import { z } from 'zod';
import type { Source } from '../shared/types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
export const searchArguments = z.object({
  queries: z.array(z.object({
    query: z.string().trim().min(3).max(400),
    domains: z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i)).max(5),
    startDate: isoDate,
    endDate: isoDate,
  }).strict()).min(1).max(4),
}).strict();
export type SearchQuery = z.infer<typeof searchArguments>['queries'][number];
export interface SearchProvider { search(query: SearchQuery, signal: AbortSignal): Promise<Omit<Source, 'id' | 'historical'>[]> }

export const webSearchTool = {
  type: 'function' as const,
  name: 'web_search',
  description: 'Search the public web for up to four independent queries concurrently. Prefer official pricing pages and dated changelogs. Date filters apply to publication dates; leave null for current pricing pages. Results are excerpts, not complete page crawls. Never include private conversation text or unnecessary personal data in queries.',
  strict: true,
  parameters: {
    type: 'object', additionalProperties: false, required: ['queries'],
    properties: {
      queries: { type: 'array', minItems: 1, maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['query', 'domains', 'startDate', 'endDate'],
        properties: {
          query: { type: 'string', minLength: 3, maxLength: 400 },
          domains: { type: 'array', maxItems: 5, items: { type: 'string' } },
          startDate: { type: ['string', 'null'], description: 'Publication start date YYYY-MM-DD, or null.' },
          endDate: { type: ['string', 'null'], description: 'Publication end date YYYY-MM-DD, or null.' },
        },
      } },
    },
  },
};

const responseSchema = z.object({ results: z.array(z.object({
  title: z.string(), url: z.string(), content: z.string(),
  published_date: z.string().optional().nullable(),
})) });

export class ProviderError extends Error {
  constructor(public provider: 'search' | 'model', public code: number | string) {
    super(`${provider === 'search' ? 'Web search' : 'Model'} ${code === 401 || code === 403 ? 'authentication failed. Check the server API key.' : code === 429 ? 'rate limit reached. Please try again shortly.' : 'request failed. Please try again.'}`);
  }
}

export class TavilySearch implements SearchProvider {
  constructor(private apiKey: string, private fetcher: typeof fetch = fetch, private clock = () => new Date()) {}
  async search(query: SearchQuery, signal: AbortSignal) {
    // No response cache: "changed since then" should always trigger a new observation.
    // One request per query, no implicit SDK retries hiding cost or latency.
    const response = await this.fetcher('https://api.tavily.com/search', {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.query, search_depth: 'advanced', max_results: 5,
        include_answer: false, include_raw_content: false,
        ...(query.domains.length ? { include_domains: query.domains } : {}),
        ...(query.startDate ? { start_date: query.startDate } : {}),
        ...(query.endDate ? { end_date: query.endDate } : {}),
      }),
    });
    if (!response.ok) throw new ProviderError('search', response.status);
    const payload = responseSchema.parse(await response.json());
    const observedAt = this.clock().toISOString();
    return payload.results.slice(0, 5).map(result => ({
      url: result.url, title: result.title.slice(0, 240), excerpt: result.content.slice(0, 3200),
      observedAt, ...(result.published_date ? { publishedAt: result.published_date } : {}), query: query.query,
    }));
  }
}
