import { createMcpHandler, McpServer as SdkMcpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './env';
import { fetchPage } from './fetchPage';
import { runSearch } from './search';
import { searchAndFetch } from './evidence';

const VERSION = '0.1.0';
const TOPICS = ['auto', 'general', 'code', 'news', 'academic'] as const;

const INSTRUCTIONS = [
    'Open WebSearch is a keyless web search and page-fetch server.',
    'Use `search` to find pages. It auto-detects the topic (general/code/news/academic), fans out to the matching free engines (DuckDuckGo, Bing, Wikipedia, GitHub, Stack Exchange, Hacker News, arXiv, and SearXNG when configured), fuses them with reciprocal rank fusion, then reranks by lexical relevance, source authority and freshness.',
    'Use `searchAndFetch` when you need evidence, not just links: it searches, fetches the top pages as Markdown, and returns them under a character budget in one call.',
    'Use `fetchWebContent` to read a specific page. It handles HTML, PDFs, and a site\'s /llms.txt index, and is chunked: pass `startIndex` from `nextStartIndex` to continue.',
    'Set `engines` or `topic` only when you need to override the automatic routing.'
].join(' ');

function errorText(tool: string, error: unknown): string {
    return `${tool} failed: ${error instanceof Error ? error.message : String(error)}`;
}

function textResult(data: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data as Record<string, unknown>
    };
}

function createServer(env: Env): McpServer {
    const server = new SdkMcpServer(
        { name: 'open-websearch', title: 'Open WebSearch', version: VERSION },
        { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
    );

    server.registerTool(
        'search',
        {
            title: 'Search',
            description:
                'Search the web without an API key. The topic is auto-detected and routed to the matching free engines (DuckDuckGo, Bing, Wikipedia, GitHub, Stack Exchange, Hacker News, arXiv, SearXNG when configured), fused with reciprocal rank fusion, then reranked by relevance, authority and freshness with per-domain diversity. Returns results plus per-engine health.',
            inputSchema: z.object({
                query: z.string().min(1, 'Search query must not be empty'),
                limit: z.number().int().min(1).max(50).default(10),
                engines: z.array(z.string()).optional(),
                topic: z.enum(TOPICS).default('auto'),
                maxPerDomain: z.number().int().min(1).max(10).optional()
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async (args): Promise<CallToolResult> => {
            try {
                return textResult(await runSearch(env, {
                    query: args.query,
                    limit: args.limit,
                    engines: args.engines,
                    topic: args.topic,
                    maxPerDomain: args.maxPerDomain
                }));
            } catch (error) {
                return { content: [{ type: 'text', text: errorText('search', error) }], isError: true };
            }
        }
    );

    server.registerTool(
        'searchAndFetch',
        {
            title: 'Search and fetch',
            description:
                'Search, then fetch the top results as Markdown under a total character budget. One call returns ranked, cited evidence ready for reasoning instead of a list of links. Failed pages keep their snippet with an error field.',
            inputSchema: z.object({
                query: z.string().min(1, 'Search query must not be empty'),
                topic: z.enum(TOPICS).default('auto'),
                engines: z.array(z.string()).optional(),
                limit: z.number().int().min(1).max(20).default(8),
                fetchTop: z.number().int().min(1).max(8).default(3),
                maxCharsPerPage: z.number().int().min(1000).max(20000).default(6000),
                totalMaxChars: z.number().int().min(1000).max(80000).default(24000),
                format: z.enum(['text', 'markdown']).default('markdown'),
                maxPerDomain: z.number().int().min(1).max(10).optional()
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async (args): Promise<CallToolResult> => {
            try {
                return textResult(await searchAndFetch(env, {
                    query: args.query,
                    topic: args.topic,
                    engines: args.engines,
                    limit: args.limit,
                    fetchTop: args.fetchTop,
                    maxCharsPerPage: args.maxCharsPerPage,
                    totalMaxChars: args.totalMaxChars,
                    format: args.format,
                    maxPerDomain: args.maxPerDomain
                }));
            } catch (error) {
                return { content: [{ type: 'text', text: errorText('searchAndFetch', error) }], isError: true };
            }
        }
    );

    server.registerTool(
        'fetchWebContent',
        {
            title: 'Fetch web content',
            description:
                'Fetch a public HTTP(S) URL as LLM-friendly Markdown. Handles HTML, PDFs (native extraction), and a site\'s /llms.txt index. Long content is chunked: pass `startIndex` to read the next chunk. A Jina Reader fallback handles JS-heavy/anti-bot pages when enabled.',
            inputSchema: z.object({
                url: z.string().url(),
                maxChars: z.number().int().min(1000).max(200000).default(30000),
                startIndex: z.number().int().min(0).optional(),
                format: z.enum(['text', 'markdown']).default('markdown'),
                readability: z.boolean().optional(),
                jinaFallback: z.boolean().optional(),
                preferLlmsTxt: z.boolean().optional()
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async (args): Promise<CallToolResult> => {
            try {
                return textResult(await fetchPage(args.url, env, {
                    maxChars: args.maxChars,
                    startIndex: args.startIndex,
                    format: args.format,
                    readability: args.readability,
                    jinaFallback: args.jinaFallback,
                    preferLlmsTxt: args.preferLlmsTxt
                }));
            } catch (error) {
                console.error('[fetchWebContent]', error);
                return { content: [{ type: 'text', text: errorText('fetchWebContent', error) }], isError: true };
            }
        }
    );

    return server;
}

/**
 * Serve a POSTed MCP message through the SDK's stateless web handler. A fresh
 * server is built per request (closing over this request's `env` bindings), so
 * there is no session state to leak between invocations on the edge.
 */
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
    const handler = createMcpHandler(() => createServer(env), {
        legacy: 'stateless',
        onerror: (error) => console.error('[mcp]', error)
    });

    try {
        const response = await handler.fetch(request);
        response.headers.set('Cache-Control', 'no-store');
        return response;
    } finally {
        try {
            await handler.close();
        } catch {
            // Per-request handler teardown never fails the response.
        }
    }
}