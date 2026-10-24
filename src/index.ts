#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupTools } from './tools/setupTools.js';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { randomUUID } from "node:crypto";
import cors from 'cors';
import type { CorsOptions } from 'cors';
import { runCli } from './cli/runCli.js';
import type { OpenWebSearchRuntime } from './runtime/runtimeTypes.js';
import { shouldCreateFullRuntimeForInvocation } from './runtime/runtimeSelection.js';
import { shutdownLocalPlaywrightBrowserSessions } from './utils/playwrightClient.js';

type StreamableSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
};

type SseSession = {
  server: McpServer;
  closed: boolean;
};

function createServer(runtime: OpenWebSearchRuntime): McpServer {
  const server = new McpServer({
    name: 'web-search',
    version: '1.2.0'
  });

  setupTools(server, runtime);
  return server;
}

function shouldSuppressStartupLogs(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }

  const [command] = argv;
  if (command === '--help' || command === '-h' || command === 'help' || command === 'status') {
    return true;
  }

  return argv.includes('--json');
}

async function main() {
  const argv = process.argv.slice(2);
  if (shouldSuppressStartupLogs(argv)) {
    process.env.OPEN_WEBSEARCH_QUIET_STARTUP = 'true';
  }
  const { config } = await import('./config.js');
  const runtime = shouldCreateFullRuntimeForInvocation(argv)
    ? (await import('./runtime/createRuntime.js')).createOpenWebSearchRuntime()
    : ({
        config,
        services: {} as OpenWebSearchRuntime['services']
      } satisfies OpenWebSearchRuntime);
  const cliExitCode = await runCli(argv, runtime, {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text)
  });

  if (cliExitCode !== null) {
    // best-effort 清理：shutdown 失败不应覆盖 CLI 本身的退出码
    try {
      await shutdownLocalPlaywrightBrowserSessions();
    } catch (error) {
      console.error('Failed to shut down local Playwright browser sessions:', error);
    }
    process.exitCode = cliExitCode;
    return;
  }

  // Enable STDIO mode if MODE is 'both' or 'stdio' or not specified
  if (process.env.MODE === undefined || process.env.MODE === 'both' || process.env.MODE === 'stdio') {
    console.error('🔌 Starting STDIO transport...');
    const server = createServer(runtime);
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport).then(() => {
      console.error('✅ STDIO transport enabled');
    }).catch(error => {
      console.error('❌ Failed to initialize STDIO transport:', error);
    });
  }

  // Only set up HTTP server if enabled
  if (config.enableHttpServer) {
    console.error('🔌 Starting HTTP server...');
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    const mcpCorsOptions: CorsOptions = {
      origin: config.corsOrigin || '*',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id'],
    };

    if (config.enableCors) {
      app.use(cors(mcpCorsOptions));
      app.options('*', cors(mcpCorsOptions));
    }

    // Per-session transport storage.
    //
    // A client that disconnects without sending DELETE (crash, kill, dropped
    // connection) never triggers transport.onclose, so its McpServer + transport
    // stays resident for the life of the process. That is the server-side half
    // of the leak this shared instance exists to fix, so evict idle sessions and
    // cap the map.
    const SESSION_IDLE_TIMEOUT_MS = Number(process.env.OPEN_WEBSEARCH_MCP_SESSION_IDLE_TIMEOUT_MS || 300000);
    const MAX_MCP_SESSIONS = Number(process.env.OPEN_WEBSEARCH_MCP_MAX_SESSIONS || 64);
    type HttpSession = {
      server: McpServer;
      transport: StreamableHTTPServerTransport;
      lastSeen: number;
    };
    const sessions = new Map<string, HttpSession>();

    function closeSession(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      sessions.delete(sessionId);
      void session.transport.close().catch(() => undefined);
      void session.server.close().catch(() => undefined);
    }

    // Sweep idle sessions. unref() so this timer never holds the process open.
    const sessionSweeper = setInterval(() => {
      const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
      for (const [sessionId, session] of sessions) {
        if (session.lastSeen < cutoff) {
          closeSession(sessionId);
        }
      }
    }, Math.max(1000, Math.min(SESSION_IDLE_TIMEOUT_MS, 60000)));
    sessionSweeper.unref();

    app.post('/mcp', async (req, res) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Resume existing session
          const session = sessions.get(sessionId)!;
          session.lastSeen = Date.now();
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        // A session id we do not know (evicted, or from a previous process) must
        // not silently become a new session: tell the client so it re-initializes
        // instead of believing its old session is still valid.
        if (sessionId && !sessions.has(sessionId)) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found; re-initialize.' },
            id: null,
          });
          return;
        }

        // Cap concurrent sessions so a client that never disconnects cleanly
        // cannot grow the map without bound; evict the least recently used.
        if (sessions.size >= MAX_MCP_SESSIONS) {
          let oldestId: string | undefined;
          let oldestSeen = Infinity;
          for (const [sid, session] of sessions) {
            if (session.lastSeen < oldestSeen) {
              oldestSeen = session.lastSeen;
              oldestId = sid;
            }
          }
          if (oldestId) {
            closeSession(oldestId);
          }
        }

        // New session — create server + transport
        const server = createServer(runtime);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server, transport, lastSeen: Date.now() });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            closeSession(transport.sessionId);
            return;
          }
          void server.close().catch(() => {});
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('❌ MCP handler error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: String(error) },
            id: null,
          });
        }
      }
    });

    // Health check
    app.get('/mcp', (_req, res) => res.status(200).send('ok'));

    app.get("/keepalive", (req, res) => {
      const auth = req.headers.authorization;
      const token = process.env.KEEPALIVE_TOKEN;
      if (token && (!auth || auth !== `Bearer ${token}`)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      res.json({ ok: true, time: new Date().toISOString() });
    });

    const host = config.httpHost;
    const port = config.httpPort;

    const httpServer = app.listen(port, host, () => {
      console.error(`✅ HTTP MCP server listening on http://${host}:${port}/mcp`);
    });

    httpServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(
          `❌ Cannot bind http://${host}:${port} - address already in use. ` +
          'Another open-websearch instance is probably serving this port. ' +
          'Use one shared instance, or set PORT to a free port.'
        );
      } else if (error.code === 'EACCES') {
        console.error(
          `❌ Cannot bind http://${host}:${port} - permission denied. ` +
          'Ports below 1024 need elevated privileges; set PORT to a higher port.'
        );
      } else {
        console.error(`❌ HTTP MCP server failed to listen on http://${host}:${port}:`, error);
      }

      // Whenever a stdio transport is live (MODE unset, 'stdio', or 'both') the
      // MCP client is already connected over it, so a port conflict must not
      // take the server down with it. Only pure HTTP mode (MODE=http, which has
      // no stdio fallback) has nothing left to serve.
      const stdioActive = process.env.MODE !== 'http';
      if (stdioActive) {
        console.error('   Continuing without the HTTP listener; the STDIO transport is unaffected.');
        return;
      }
      process.exitCode = 1;
    });
  } else {
    console.error('ℹ️ HTTP server disabled, running in STDIO mode only')
  }
}

main().catch(console.error);
