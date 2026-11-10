import type { Source } from '../shared/types.js';

/** URLs are citations, never server-side fetch targets. Never render active schemes. */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^utm_|^fbclid$|^gclid$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return null;
  }
}

/** IDs are assigned here, never accepted from either the model or search provider. */
export class Evidence {
  private records: Source[] = [];
  add(source: Omit<Source, 'id'>): Source | null {
    const url = safeUrl(source.url);
    if (!url) return null;
    // Time is part of the identity: a fresh observation must not overwrite an old one.
    const existing = this.records.find(
      (s) => s.url === url && s.observedAt === source.observedAt && s.excerpt === source.excerpt,
    );
    if (existing) return existing;
    const record = { ...source, url, id: `S${this.records.length + 1}` };
    this.records.push(record);
    return record;
  }
  all(): Source[] {
    return this.records.map((s) => ({ ...s }));
  }

  check(answer: string): { text: string; warnings: string[] } {
    const known = new Set(this.records.map((s) => s.id));
    const invalid = new Set<string>();
    // Support both bare [S1] and model-produced markdown citation links. The UI
    // always resolves known markers through our registry, never through model URLs.
    const text = answer.replace(/\[(S\d+)\](?:\([^\s)]*\))?/g, (_match, id: string) => {
      if (known.has(id)) return `[${id}]`;
      invalid.add(id);
      return '[source unavailable]';
    });
    return {
      text,
      warnings: invalid.size
        ? [
            'Some citation IDs were not in the retrieved evidence and were removed. Treat the associated claims as unverified.',
          ]
        : [],
    };
  }
}
