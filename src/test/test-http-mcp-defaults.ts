// Tests for the HTTP MCP listener defaults.
//
// Two behaviours are load-bearing here:
//   1. An unset MODE must NOT open a listening socket. A stdio MCP client
//      spawning this server should never cause a port to appear as a side
//      effect of merely connecting.
//   2. When HTTP is opted into, it must bind loopback by default and report a
//      clear diagnostic (instead of an unhandled EADDRINUSE) when the port is
//      already taken.
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
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

function runModuleWithEnv(code: string, env: Record<string, string>): string {
    return execFileSync(
        process.execPath,
        ['--input-type=module', '-e', code],
        {
            cwd: process.cwd(),
            env: { ...process.env, ...env },
            encoding: 'utf8'
        }
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the OS for a free port, then release it. */
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

/** True if something accepts a TCP connection on 127.0.0.1:port right now. */
async function probeListener(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
    });
}

/** Wait until something accepts connections on 127.0.0.1:port, or time out. */
async function waitForListener(port: number, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probeListener(port)) {
            return true;
        }
        await sleep(200);
    }
    return false;
}

function spawnServer(env: Record<string, string>): { child: ChildProcess; stderr: () => string } {
    const child = spawn(process.execPath, ['build/index.js'], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let err = '';
    child.stderr?.on('data', (chunk) => { err += String(chunk); });
    return { child, stderr: () => err };
}

function kill(child: ChildProcess): void {
    if (child.exitCode === null) {
        child.kill('SIGKILL');
    }
}

/** Unset MODE means stdio only: no listener may appear. */
async function testUnsetModeOpensNoListener(): Promise<void> {
    const port = await findFreePort();
    const { child, stderr } = spawnServer({ MODE: '', PORT: String(port) });

    try {
        // Give it well past where it used to bind 0.0.0.0:3000.
        await sleep(9000);
        assertEqual(
            await probeListener(port),
            false,
            'unset MODE must not open an HTTP listener'
        );
        assert(
            stderr().includes('STDIO'),
            `expected a STDIO mode log, got: ${stderr().slice(0, 200)}`
        );
    } finally {
        kill(child);
    }

    console.log('✅ unset MODE starts STDIO only and binds no port');
}

/** MODE=http binds the configured host/port and answers on /mcp. */
async function testHttpModeBindsConfiguredLoopbackHost(): Promise<void> {
    const port = await findFreePort();
    const { child, stderr } = spawnServer({ MODE: 'http', PORT: String(port), HOST: '127.0.0.1' });

    try {
        assert(await waitForListener(port), `MODE=http should listen on 127.0.0.1:${port}`);
        assert(
            stderr().includes(`http://127.0.0.1:${port}/mcp`),
            `expected the listener address to be logged, got: ${stderr().slice(0, 300)}`
        );

        // Reachable on loopback, and the MCP health endpoint answers.
        const response = await fetch(`http://127.0.0.1:${port}/mcp`);
        assertEqual(response.status, 200, 'GET /mcp health check status');
    } finally {
        kill(child);
    }

    console.log('✅ MODE=http binds loopback and serves /mcp');
}

/** A second instance on a taken port reports a diagnostic and exits 1. */
async function testPortConflictReportsDiagnostic(): Promise<void> {
    const port = await findFreePort();
    const blocker = http.createServer((_req, res) => res.end('blocked'));
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));

    try {
        // MODE=http has no stdio fallback, so the conflict is fatal and must
        // surface as a diagnostic rather than an unhandled exception.
        const raw = execFileSync(
            process.execPath,
            ['-e', `
                const { spawnSync } = require('child_process');
                const r = spawnSync(process.execPath, ['build/index.js'], {
                    env: { ...process.env, MODE: 'http', PORT: '${port}' },
                    encoding: 'utf8'
                });
                console.log(JSON.stringify({ status: r.status, stderr: r.stderr }));
            `],
            { cwd: process.cwd(), encoding: 'utf8' }
        );

        const parsed = JSON.parse(raw.trim().split('\n').pop() as string) as {
            status: number;
            stderr: string;
        };
        assertEqual(parsed.status, 1, 'MODE=http port conflict exit code');
        assert(
            /already in use/.test(parsed.stderr),
            `expected an "already in use" diagnostic, got: ${parsed.stderr.slice(0, 300)}`
        );
    } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }

    console.log('✅ port conflict reports a clear diagnostic instead of an unhandled throw');
}

/** A live stdio client must keep working while the HTTP port is taken. */
async function testStdioSurvivesBusyHttpPort(): Promise<void> {
    const port = await findFreePort();
    const blocker = http.createServer((_req, res) => res.end('blocked'));
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));

    const { child, stderr } = spawnServer({ MODE: 'both', PORT: String(port) });
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });

    try {
        await sleep(2500);
        child.stdin?.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'test', version: '1' }
            }
        }) + '\n');
        await sleep(1500);
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        await sleep(2000);

        assert(
            stdout.includes('serverInfo'),
            `expected an initialize result over stdio; stdout=${stdout.slice(0, 200)} stderr=${stderr().slice(0, 200)}`
        );
        assert(stdout.includes('search'), 'expected tools/list to expose the search tool');
        assert(
            /already in use/.test(stderr()),
            'expected the listen conflict to be reported on stderr'
        );
        assertEqual(child.exitCode, null, 'MODE=both must stay alive despite the busy HTTP port');
    } finally {
        child.stdin?.end();
        await sleep(500);
        kill(child);
    }

    console.log('✅ stdio transport keeps serving while the HTTP port is occupied');
}

/** Config reads: HOST and PORT env vars drive the listener address. */
function testConfigExposesListenerAddress(): void {
    const output = runModuleWithEnv(
        `
            const { config } = await import('./build/config.js');
            console.log(JSON.stringify({
                httpHost: config.httpHost,
                httpPort: config.httpPort,
                enableHttpServer: config.enableHttpServer
            }));
        `,
        { MODE: 'http', HOST: '127.0.0.1', PORT: '4567' }
    );
    const parsed = JSON.parse(output.trim().split('\n').pop() as string) as {
        httpHost: string;
        httpPort: number;
        enableHttpServer: boolean;
    };

    assertEqual(parsed.httpHost, '127.0.0.1', 'HOST env is read into httpHost');
    assertEqual(parsed.httpPort, 4567, 'PORT env is read into httpPort');
    assertEqual(parsed.enableHttpServer, true, 'MODE=http enables the HTTP server');

    // Unset MODE must disable HTTP and default the host to loopback.
    const defaults = runModuleWithEnv(
        `
            const { config } = await import('./build/config.js');
            console.log(JSON.stringify({
                httpHost: config.httpHost,
                enableHttpServer: config.enableHttpServer
            }));
        `,
        { MODE: '' }
    );
    const defaultParsed = JSON.parse(defaults.trim().split('\n').pop() as string) as {
        httpHost: string;
        enableHttpServer: boolean;
    };

    assertEqual(defaultParsed.enableHttpServer, false, 'unset MODE disables the HTTP server');
    assertEqual(defaultParsed.httpHost, '127.0.0.1', 'default httpHost is loopback');

    console.log('✅ HOST/PORT drive the listener address and default to loopback');
}

async function main(): Promise<void> {
    await testUnsetModeOpensNoListener();
    await testHttpModeBindsConfiguredLoopbackHost();
    await testPortConflictReportsDiagnostic();
    await testStdioSurvivesBusyHttpPort();
    testConfigExposesListenerAddress();
    console.log('\nHTTP MCP defaults tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
