import type { SearchResult } from '../env';
import { fetchJson } from '../http';

/**
 * GitHub repository search via the public REST API. Unauthenticated search is
 * allowed for repositories/issues/users at ~10 requests/minute (code search
 * requires auth), so this runs behind the worker's circuit breaker.
 * Docs: https://docs.github.com/en/rest/search/search
 */
const USER_AGENT = 'open-websearch-cloudflare/0.1 (+https://github.com/Aas-ee/open-webSearch)';

interface GitHubRepo {
    full_name?: string;
    html_url?: string;
    description?: string;
    stargazers_count?: number;
    language?: string;
    pushed_at?: string;
    updated_at?: string;
}

interface GitHubSearchResponse {
    items?: GitHubRepo[];
}

export async function searchGitHub(
    query: string,
    limit: number,
    options: { timeoutMs?: number } = {}
): Promise<SearchResult[]> {
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', query);
    url.searchParams.set('per_page', String(Math.min(10, Math.max(1, limit))));
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('order', 'desc');

    const response = await fetchJson<GitHubSearchResponse>(
        url.toString(),
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': USER_AGENT
            }
        },
        options.timeoutMs
    );

    return (response.items ?? [])
        .filter((repo): repo is GitHubRepo & { full_name: string; html_url: string } =>
            Boolean(repo.full_name && repo.html_url))
        .map((repo) => ({
            title: repo.full_name,
            url: repo.html_url,
            description: [
                repo.description,
                repo.language ? `Language: ${repo.language}` : '',
                typeof repo.stargazers_count === 'number' ? `★ ${repo.stargazers_count}` : ''
            ].filter(Boolean).join(' · '),
            source: 'github.com',
            engine: 'github',
            ...(repo.pushed_at || repo.updated_at ? { publishedAt: repo.pushed_at || repo.updated_at } : {})
        }))
        .slice(0, limit);
}