import type { Env } from './env';
import { handleMcpRequest } from './mcp';

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

function withCors(response: Response): Response {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        response.headers.set(key, value);
    }
    return response;
}

function jsonError(status: number, message: string): Response {
    return withCors(Response.json({ error: message }, { status }));
}

function isAuthorized(request: Request, env: Env): boolean {
    const expected = env.MCP_AUTH_TOKEN?.trim();
    if (!expected) {
        return true;
    }
    const header = request.headers.get('authorization');
    if (header === `Bearer ${expected}`) {
        return true;
    }
    return new URL(request.url).searchParams.get('token') === expected;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return withCors(new Response(null, { status: 204 }));
        }

        if (url.pathname === '/health' || url.pathname === '/') {
            return withCors(Response.json({ ok: true, service: 'open-websearch', version: '0.1.0' }));
        }

        if (url.pathname !== '/mcp') {
            return jsonError(404, 'Not found');
        }

        if (!isAuthorized(request, env)) {
            return jsonError(401, 'Unauthorized');
        }

        if (request.method === 'GET') {
            // Liveness probe. Stateless mode has no server-initiated stream to
            // open, so a request carrying a session id is rejected explicitly.
            if (request.headers.get('mcp-session-id')) {
                return jsonError(405, 'Server-initiated streams are disabled in stateless mode.');
            }
            return withCors(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
        }

        if (request.method === 'DELETE') {
            // No session to terminate in stateless mode; answer idempotently.
            return withCors(new Response('ok', { status: 200 }));
        }

        if (request.method !== 'POST') {
            return jsonError(405, 'Method Not Allowed');
        }

        try {
            return withCors(await handleMcpRequest(request, env));
        } catch (error) {
            console.error('[mcp] unhandled', error);
            return jsonError(500, 'Internal server error');
        }
    }
};