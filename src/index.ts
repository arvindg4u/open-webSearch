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

    // Per-session transport storage
    const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

    app.post('/mcp', async (req, res) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Resume existing session
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        // New session — create server + transport
        const server = createServer(runtime);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server, transport });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
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

    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

    app.listen(PORT, '0.0.0.0', () => {
      console.error(`✅ HTTP server running on port ${PORT}`)
    });
  } else {
    console.error('ℹ️ HTTP server disabled, running in STDIO mode only')
  }
}

main().catch(console.error);
