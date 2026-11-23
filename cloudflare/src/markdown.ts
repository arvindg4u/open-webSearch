import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

/**
 * HTML → GitHub-flavoured Markdown for Workers, using linkedom (a compact,
 * Workers-safe DOM) plus Turndown.
 *
 * The `turndown-plugin-gfm` package is intentionally NOT used here: its table
 * filter reads `node.rows[0]`, which linkedom does not implement, so it throws
 * on any page containing a table. The two useful GFM behaviours (tables and
 * strikethrough) are implemented below against only querySelectorAll/textContent.
 */
function cellText(cell: Element): string {
    return (cell.textContent || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function convertTable(node: Element): string {
    const rows = Array.from(node.querySelectorAll('tr'));
    if (rows.length === 0) {
        return '';
    }

    const grid = rows.map((row) => Array.from(row.querySelectorAll('th,td')).map(cellText));
    const columns = Math.max(...grid.map((row) => row.length));
    const pad = (row: string[]): string[] => {
        const padded = [...row];
        while (padded.length < columns) {
            padded.push('');
        }
        return padded;
    };

    const header = pad(grid[0]);
    const lines = [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...grid.slice(1).map((row) => `| ${pad(row).join(' | ')} |`)
    ];
    return `\n\n${lines.join('\n')}\n\n`;
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
    if (!html.trim()) {
        return '';
    }

    const { document } = parseHTML(
        /<html[\s>]/i.test(html)
            ? html
            : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`
    );

    const service = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
        strongDelimiter: '**',
        linkStyle: 'inlined'
    });

    const resolve = (value: string | null): string => {
        if (!value) {
            return '';
        }
        try {
            return new URL(value, baseUrl).toString();
        } catch {
            return value;
        }
    };

    service.addRule('absoluteLinks', {
        filter: (node) => node.nodeName === 'A' && Boolean(node.getAttribute('href')),
        replacement: (content, node) => {
            const href = resolve(node.getAttribute('href'));
            const text = content.trim() || href;
            return href ? `[${text}](${href})` : text;
        }
    });

    service.addRule('absoluteImages', {
        filter: (node) => node.nodeName === 'IMG' && Boolean(node.getAttribute('src')),
        replacement: (_content, node) => {
            const alt = node.getAttribute('alt') || '';
            const src = resolve(node.getAttribute('src'));
            return src ? `![${alt}](${src})` : '';
        }
    });

    service.addRule('dropDataImages', {
        filter: (node) => node.nodeName === 'IMG' && /^data:/i.test(node.getAttribute('src') || ''),
        replacement: () => ''
    });

    service.addRule('safeTables', {
        filter: (node) => node.nodeName === 'TABLE',
        replacement: (_content, node) => convertTable(node)
    });

    service.addRule('strikethrough', {
        filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
        replacement: (content) => (content.trim() ? `~~${content.trim()}~~` : '')
    });

    return service.turndown(document.body as unknown as HTMLElement).trim();
}