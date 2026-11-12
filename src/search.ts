/**
 * The one tool: web search (Tavily).
 *
 * Design notes
 *  - `since` maps to a real date filter, so "what changed since 3 Nov" is a
 *    query the search engine can actually answer, not something the model has to
 *    infer from snippet dates.
 *  - Results are compacted before they reach the model: title, url, date,
 *    ~600 chars. Token cost is latency.
 *  - Identical queries within a few minutes are served from cache.
 *  - Failures come back as text the model can reason about, never as a crash.
 */

export interface SearchArgs {
  query: string;
  /** Only results published on/after this day (YYYY-MM-DD). */
  since?: string;
  /** Use the news index (better for "what happened / announced"). */
  news?: boolean;
}

export interface SearchHit {
  title: string;
  url: string;
  date?: string;
  snippet: string;
}

export type SearchFn = (args: SearchArgs, signal?: AbortSignal) => Promise<SearchHit[]>;

const cache = new Map<string, { at: number; hits: SearchHit[] }>();
const TTL_MS = 5 * 60_000;

export function tavilySearch(apiKey: string, fetchImpl: typeof fetch = fetch): SearchFn {
  return async (args, signal) => {
    const key = JSON.stringify([args.query.toLowerCase().trim(), args.since ?? '', !!args.news]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.hits;

    const body: Record<string, unknown> = {
      query: args.query.slice(0, 380),
      search_depth: 'basic',
      max_results: 6,
      topic: args.news ? 'news' : 'general',
      include_answer: false,
    };
    if (/^\d{4}-\d{2}-\d{2}$/.test(args.since ?? '')) body.start_date = args.since;

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const timeout = AbortSignal.timeout(12_000);
        const res = await fetchImpl('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`search provider ${res.status}`);
        if (!res.ok) throw new Error(`search provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const hits: SearchHit[] = (json.results ?? []).map((r) => ({
          title: String(r.title ?? r.url ?? ''),
          url: String(r.url ?? ''),
          date: typeof r.published_date === 'string' ? r.published_date.slice(0, 10) : undefined,
          snippet: String(r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 650),
        }));
        cache.set(key, { at: Date.now(), hits });
        if (cache.size > 200) cache.delete(cache.keys().next().value!);
        return hits;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
}

export function formatHits(hits: SearchHit[], args: SearchArgs): string {
  if (!hits.length) {
    return `No results for "${args.query}"${args.since ? ` since ${args.since}` : ''}. That is weak evidence of "nothing happened": try a broader or differently worded query before concluding.`;
  }
  return hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}${h.date ? `\npublished: ${h.date}` : ''}\n${h.snippet}`)
    .join('\n\n');
}
