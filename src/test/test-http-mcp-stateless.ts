// Tests for the opt-in stateless Streamable HTTP mode.
//
// OPEN_WEBSEARCH_MCP_STATELESS=true removes the protocol session entirely: no
// Mcp-Session-Id is issued, no session map exists, and each POST is handled by a
// fresh server+transport that is torn down with its response. This follows the
// stateless direction of MCP (2026-07-28) and deletes the session-map leak
// surface (idle sweep, LRU cap, re-initialize 404) rather than bounding it.
//
// The tests pin the behaviours a client depends on: initialize still succeeds
// but returns no session id, requests work without one, GET stays a probe
// without a header and is rejected with one, and DELETE is an idempotent no-op.
import { spawn, ChildProcess } from 'node:child_process';
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

/** Extract the JSON-RPC object from either a JSON or an SSE response body. */
function parseJsonRpc(contentType: string, body: string): any {
    if (contentType.includes('text/event-stream')) {
        for (const line of body.split('\n')) {
            if (line.startsWith('data: ')) {
                return JSON.parse(line.slice('data: '.length));
            }
        }
        throw new Error(`no SSE data frame in body: ${body}`);
    }
    return JSON.parse(body);
}

type PostResult = { status: number; sessionId: string | null; contentType: string; message: any };

/** POST a JSON-RPC message with no session header (stateless has none). */
async function post(port: number, message: Record<string, unknown>): Promise<PostResult> {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(message)
    });
    const contentType = response.headers.get('content-type') || '';
    const sessionId = response.headers.get('mcp-session-id');
    const body = await response.text().catch(() => '');
    let parsed: any = undefined;
    if (body.length > 0) {
        try {
            parsed = parseJsonRpc(contentType, body);
        } catch {
            parsed = undefined;
        }
    }
    return { status: response.status, sessionId, contentType, message: parsed };
}

/**
 * initialize must succeed but must NOT hand out a session id.
 *
 * A session id here would make clients believe a session exists that the server
 * does not track.
 */
async function testInitializeIssuesNoSession(): Promise<void> {
    const port = await findFreePort();
    const child = spawnServer({ MODE: 'http', PORT: String(port), HOST: '127.0.0.1', OPEN_WEBSEARCH_MCP_STATELESS: 'true' });

    try {
        assert(await waitForListener(port), `server should listen on 127.0.0.1:${port}`);

        const init = await post(port, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'stateless-test', version: '1' }
            }
        });
        assertEqual(init.status, 200, 'stateless initialize status');
        assertEqual(init.sessionId, null, 'stateless initialize must not issue a session id');
        assert(init.message?.result, 'stateless initialize must return a result');
    } finally {
        kill(child);
    }

    console.log('✅ stateless initialize succeeds and issues no session id');
}

/**
 * Requests must work without any session id, and each request must be
 * independent (a fresh transport per request, not a reused one).
 */
async function testRequestsWorkWithoutSession(): Promise<void> {
    const port = await findFreePort();
    const child = spawnServer({ MODE: 'http', PORT: String(port), HOST: '127.0.0.1', OPEN_WEBSEARCH_MCP_STATELESS: 'true' });

    try {
        assert(await waitForListener(port), `server should listen on 127.0.0.1:${port}`);

        await post(port, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stateless-test', version: '1' } }
        });

        const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        assertEqual(list.status, 200, 'tools/list without a session must succeed');
        const tools = list.message?.result?.tools ?? [];
        assert(tools.length >= 1, `tools/list must return tools, got ${JSON.stringify(list.message)}`);

        // A second, independent request must also succeed: proves the transport
        // is not being reused across requests.
        const again = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        assertEqual(again.status, 200, 'a second independent request must succeed');
    } finally {
        kill(child);
    }

    console.log('✅ stateless requests work without a session id and are independent');
}

/** GET without a header stays a probe; GET with one is rejected (no stream to open). */
async function testGetIsProbeOrRejected(): Promise<void> {
    const port = await findFreePort();
    const child = spawnServer({ MODE: 'http', PORT: String(port), HOST: '127.0.0.1', OPEN_WEBSEARCH_MCP_STATELESS: 'true' });

    try {
        assert(await waitForListener(port), `server should listen on 127.0.0.1:${port}`);

        const probe = await fetch(`http://127.0.0.1:${port}/mcp`);
        assertEqual(probe.status, 200, 'GET without a session must stay the liveness probe');
        await probe.text().catch(() => undefined);

        const withHeader = await fetch(`http://127.0.0.1:${port}/mcp`, {
            headers: { 'Accept': 'text/event-stream', 'Mcp-Session-Id': '00000000-0000-4000-8000-000000000000' }
        });
        assertEqual(withHeader.status, 405, 'GET with a session header must be rejected in stateless mode');
        await withHeader.text().catch(() => undefined);
    } finally {
        kill(child);
    }

    console.log('✅ stateless GET stays a probe without a header and is rejected with one');
}

/** DELETE is an idempotent no-op so clients that tear down on exit see no error. */
async function testDeleteIsIdempotent(): Promise<void> {
    const port = await findFreePort();
    const child = spawnServer({ MODE: 'http', PORT: String(port), HOST: '127.0.0.1', OPEN_WEBSEARCH_MCP_STATELESS: 'true' });

    try {
        assert(await waitForListener(port), `server should listen on 127.0.0.1:${port}`);

        for (let i = 0; i < 2; i++) {
            const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE' });
            assertEqual(res.status, 200, `DELETE must be an idempotent no-op (attempt ${i})`);
            await res.text().catch(() => undefined);
        }
    } finally {
        kill(child);
    }

    console.log('✅ stateless DELETE is an idempotent no-op');
}

async function main(): Promise<void> {
    await testInitializeIssuesNoSession();
    await testRequestsWorkWithoutSession();
    await testGetIsProbeOrRejected();
    await testDeleteIsIdempotent();
    console.log('\nStateless HTTP MCP tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
