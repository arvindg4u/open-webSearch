import type { SupportedEngine, Topic } from './env';

/**
 * Lightweight intent detection. The goal is not perfect classification — it is
 * to add the right vertical source (code / news / academic) to the general web
 * fan-out so the fused result is not dominated by SEO pages.
 */
const ACADEMIC_HINTS =
    /\b(paper|papers|study|studies|research|preprint|arxiv|doi|journal|survey|literature|thesis|benchmark|dataset|peer[- ]reviewed|meta[- ]analysis)\b/i;
const CODE_HINTS =
    /\b(error|exception|stack ?trace|traceback|segfault|undefined|null|typescript|javascript|python|rust|golang|java|kotlin|swift|sql|react|vue|svelte|angular|next\.?js|node|deno|bun|npm|pnpm|yarn|pip|cargo|docker|kubernetes|terraform|regex|compile|compiler|dependency|function|class|api|sdk|cli|cors|http|https|header|headers|endpoint|request|response|server|client|deploy|deployment|config|configuration|environment|webhook|json|yaml|html|css|database|query|runtime|async|buffer|library|framework|install|build|debug|refactor|git|github|oauth|jwt|cookie|cache|proxy|websocket|graphql|rest|orm|migration)\b|\.(js|ts|tsx|jsx|py|rs|go|java|rb|php)\b|\bcve-\d{4}-\d+/i;
const NEWS_HINTS =
    /\b(news|announcement|announced|launch|launched|release|released|roadmap|changelog|latest|today|this week|breaking|outage|incident|acquisition)\b/i;

export type ResolvedTopic = Exclude<Topic, 'auto'>;

export function detectTopic(query: string): ResolvedTopic {
    if (ACADEMIC_HINTS.test(query)) {
        return 'academic';
    }
    if (CODE_HINTS.test(query)) {
        return 'code';
    }
    if (NEWS_HINTS.test(query)) {
        return 'news';
    }
    return 'general';
}

const CLUSTERS: Record<ResolvedTopic, SupportedEngine[]> = {
    // General web: SearXNG (when configured) is the strongest broad index, so
    // it leads; DuckDuckGo/Bing/Wikipedia cover the rest.
    general: ['searxng', 'duckduckgo', 'bing', 'wikipedia'],
    // Code: authoritative repo + Q&A verticals, plus broad indexes for the long tail.
    code: ['github', 'stackexchange', 'searxng', 'duckduckgo', 'bing'],
    // News: discussion signal + broad indexes.
    news: ['hackernews', 'searxng', 'duckduckgo', 'bing'],
    // Academic: papers + encyclopedic background + broad indexes.
    academic: ['arxiv', 'wikipedia', 'searxng', 'duckduckgo']
};

/** Pick the engine cluster for a topic, keeping only engines that are enabled. */
export function enginesForTopic(topic: ResolvedTopic, available: SupportedEngine[]): SupportedEngine[] {
    const cluster = CLUSTERS[topic].filter((engine) => available.includes(engine));
    return cluster.length > 0 ? cluster : available;
}