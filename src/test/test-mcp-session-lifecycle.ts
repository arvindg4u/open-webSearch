// Tests for HTTP MCP session lifecycle.
//
// The shared instance is the whole point of the HTTP transport, so it must not
// leak sessions server-side. A client that disconnects without sending DELETE
// never triggers transport.onclose, so idle sessions must be evicted by a
// sweep, and the session map must be capped. A client that comes back with an
// evicted session id must be told to re-initialize rather than being silently
// handed a fresh session (which would let it believe its old state is intact).
import { spawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('failed to resolve ephemeral port'));
                return;
            }
            const { port } = address;
            server.close(() => resolve(port));
        });
    });
}

async function waitForListener(port: number, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => { socket.destroy(); resolve(false); });
        });
        if (ok) {
            return true;
        }
        await sleep(200);
    }
    return false;
}

function spawnServer(env: Record<string, string>): ChildProcess {
    return spawn(process.execPath, ['build/index.js'], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
    });
}

function kill(child: ChildProcess): void {
    if (child.exitCode === null) {
        child.kill('SIGKILL');
    }
}

type InitResult = { sessionId: string | null; status: number };

/** POST an MCP initialize and capture the negotiated session id. */
async function initializeSession(port: number): Promise<InitResult> {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'lifecycle-test', version: '1' }
            }
        })
    });
    const sessionId = response.headers.get('mcp-session-id');
    // Drain the body so the connection can be reused.
    await response.text().catch(() => undefined);
    return { sessionId, status: response.status };
}

/** Re-use a session id and report the HTTP status. */
async function reuseSession(port: number, sessionId: string): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Mcp-Session-Id': sessionId
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    await response.text().catch(() => undefined);
    return response.status;
}

/** An unknown session id must be rejected, not silently adopted. */
async function testUnknownSessionIsRejected(): Promise<void> {
    const port = await findFreePort();
    const child = spawnServer({ MODE: 'http', PORT: String(port), HOST: '127.0.0.1' });

    try {
        assert(await waitForListener(port), `server should listen on 127.0.0.1:${port}`);

        const status = await reuseSession(port, '00000000-0000-4000-8000-000000000000');
        assertEqual(status, 404, 'unknown session id must be rejected with 404');
    } finally {
        kill(child);
    }

    console.log('✅ an unknown session id is rejected with 404 instead of silently adopted');
}

/** An idle session must be evicted once the idle timeout elapses. */
async function testIdleSessionIsEvicted(): Promise<void> {
    const port = await findFreePort();
    const idleTimeoutMs = 1500;
    const child = spawnServer({
        MODE: 'http',
        PORT: String(port),
        HOST: '127.0.0.1',
        OPEN_WEBSEARCH_MCP_SESSION_IDLE_TIMEOUT_MS: String(idleTimeoutMs)
    });

    try {
        assert(await waitForListener(port), `server should listen on 127.0.0.1:${port}`);

        const first = await initializeSession(port);
        assertEqual(first.status, 200, 'initialize status');
        assert(first.sessionId !== null, 'initialize must return a session id');

        // While the session is fresh it must still be usable.
        assertEqual(
            await reuseSession(port, first.sessionId as string),
            200,
            'a fresh session must be reusable'
        );

        // Let it go idle well past the timeout and the sweep interval.
        await sleep(idleTimeoutMs * 3);

        assertEqual(
            await reuseSession(port, first.sessionId as string),
            404,
            'an idle session must be evicted and reported as not found'
        );
    } finally {
        kill(child);
    }

    console.log('✅ an idle session is evicted and returns 404 afterwards');
}

/** The session map must be capped so it cannot grow without bound. */
async function testSessionCountIsCapped(): Promise<void> {
    const port = await findFreePort();
    const maxSessions = 3;
    const child = spawnServer({
        MODE: 'http',
        PORT: String(port),
        HOST: '127.0.0.1',
        OPEN_WEBSEARCH_MCP_MAX_SESSIONS: String(maxSessions),
        // Long idle timeout so only the cap can evict during this test.
        OPEN_WEBSEARCH_MCP_SESSION_IDLE_TIMEOUT_MS: '600000'
    });

    try {
        assert(await waitForListener(port), `server should listen on 127.0.0.1:${port}`);

        const ids: string[] = [];
        for (let i = 0; i < maxSessions; i++) {
            const init = await initializeSession(port);
            assert(init.sessionId !== null, `initialize ${i} must return a session id`);
            ids.push(init.sessionId as string);
        }

        // Creating one more than the cap must evict the oldest, leaving it dead.
        const overflow = await initializeSession(port);
        assert(overflow.sessionId !== null, 'the overflow initialize must still succeed');

        assertEqual(
            await reuseSession(port, ids[0]),
            404,
            'exceeding the cap must evict the oldest session'
        );
        assertEqual(
            await reuseSession(port, overflow.sessionId as string),
            200,
            'the newest session must stay usable'
        );
    } finally {
        kill(child);
    }

    console.log('✅ the session map is capped and evicts the oldest session');
}

async function main(): Promise<void> {
    await testUnknownSessionIsRejected();
    await testIdleSessionIsEvicted();
    await testSessionCountIsCapped();
    console.log('\nMCP session lifecycle tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
