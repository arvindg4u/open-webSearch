export interface SearchResult {
    title: string;
    url: string;
    description: string;
    source: string;
    engine: string;
    /**
     * Every engine that surfaced this URL, in first-seen order. Set only when
     * more than one engine agreed and the results were fused (RRF); a
     * single-engine lookup leaves this undefined.
     */
    engines?: string[];
}
