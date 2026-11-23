import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * HTML → Markdown for LLM consumption. Markdown keeps structure (headings,
 * lists, links, tables, code fences) that a flattened text dump destroys,
 * which is the whole reason the reference `mcp-server-fetch` converts rather
 * than strips.
 *
 * Turndown defaults are adjusted toward GitHub-flavoured Markdown: ATX
 * headings, fenced code blocks and `-` bullets, matching what the Worker-side
 * converter (linkedom + the same Turndown pipeline) produces.
 */
let turndown: TurndownService | undefined;

function getTurndown(): TurndownService {
    if (!turndown) {
        turndown = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-',
            emDelimiter: '*',
            strongDelimiter: '**',
            linkStyle: 'inlined'
        });
        turndown.use(gfm);
        // Turndown emits the raw attribute, so relative hrefs survive as
        // relative. Read the resolved DOM property instead so the markdown
        // carries absolute URLs the agent can follow.
        turndown.addRule('absoluteLinks', {
            filter: (node) => node.nodeName === 'A' && Boolean(node.getAttribute('href')),
            replacement: (content, node) => {
                const href = (node as unknown as HTMLAnchorElement).href
                    || node.getAttribute('href')
                    || '';
                const text = content.trim() || href;
                return href ? `[${text}](${href})` : text;
            }
        });
        turndown.addRule('absoluteImages', {
            filter: (node) => node.nodeName === 'IMG' && Boolean(node.getAttribute('src')),
            replacement: (_content, node) => {
                const alt = node.getAttribute('alt') || '';
                const src = (node as unknown as HTMLImageElement).src
                    || node.getAttribute('src')
                    || '';
                return src ? `![${alt}](${src})` : '';
            }
        });
        // Decorative images add tokens without meaning for most agent tasks.
        turndown.addRule('dropDataImages', {
            filter: (node) => node.nodeName === 'IMG' && /^data:/i.test(node.getAttribute('src') || ''),
            replacement: () => ''
        });
    }
    return turndown;
}

/** Convert an HTML fragment to Markdown. Relative links resolve against `baseUrl`. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
    if (!html.trim()) {
        return '';
    }
    const dom = new JSDOM(html, baseUrl ? { url: baseUrl } : undefined);
    const root = dom.window.document.body ?? dom.window.document.documentElement;
    return getTurndown().turndown(root as unknown as HTMLElement).trim();
}
