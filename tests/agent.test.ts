import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses';
import { Store } from '../server/db.js';
import { runAgent, LIMITS } from '../server/agent.js';
import type { LanguageModel, ModelRequest, ModelResponse } from '../server/model.js';
import { ProviderError, TavilySearch, webSearchTool, type SearchProvider } from '../server/search.js';
import { Evidence, safeUrl } from '../server/evidence.js';
import type { AgentEvent } from '../shared/types.js';

const query = { query: 'Acme official pricing', domains: ['acme.example'], startDate: null, endDate: null };
const source = { title: 'Acme pricing', url: 'https://acme.example/pricing', excerpt: '$25 per seat per month, billed monthly.', query: query.query, observedAt: '2026-11-10T12:00:00Z' };
const toolCall = (queries = [query], id = 'call_1'): ResponseFunctionToolCall => ({ type: 'function_call', call_id: id, name: 'web_search', arguments: JSON.stringify({ queries }) });
const reply = (text: string): ModelResponse => ({ text, output: [], inputTokens: 10, outputTokens: 5 });
const responseWithCall = (call = toolCall()): ModelResponse => ({ ...reply(''), output: [call] });
const stores: Store[] = [];

function harness(responses: ModelResponse[], searchOverride?: SearchProvider) {
  const store = new Store(); stores.push(store); store.createOwner('alice');
  const chat = store.createConversation('alice');
  const turn = store.beginTurn('alice', chat.id, randomUUID(), 'What does Acme cost today?');
  const requests: ModelRequest[] = []; const events: AgentEvent[] = [];
  const model: LanguageModel = { respond: vi.fn(async request => {
    requests.push(structuredClone({ ...request, signal: undefined, onDelta: undefined }) as unknown as ModelRequest);
    const response = responses.shift(); if (!response) throw new Error('Unexpected model call');
    if (response.text) request.onDelta(response.text);
    return response;
  }) };
  const search = searchOverride ?? { search: vi.fn(async () => [source]) };
  const controller = new AbortController();
  return { store, chat, turn, model, search, requests, events, controller,
    run: () => runAgent({ store, model, search, clock: () => new Date('2026-11-10T12:00:00Z') },
      { owner: 'alice', turn, timezone: 'UTC', signal: controller.signal, emit: event => events.push(event) }) };
}
afterEach(() => { stores.splice(0).forEach(s => s.close()); });

describe('bounded orchestration', () => {
  it('uses one model call and zero searches for conversation', async () => {
    const h = harness([reply('Hello!')]); const result = await h.run();
    expect(result.status).toBe('complete'); expect(h.search.search).not.toHaveBeenCalled();
    expect(result.stats?.modelCalls).toBe(1);
  });
  it('passes real evidence to the next call, streams text, and persists the final result', async () => {
    const h = harness([responseWithCall(), reply('Acme costs $25 monthly. [S1]')]); const result = await h.run();
    expect(result.sources[0]).toMatchObject({ id: 'S1', ...source });
    expect(h.requests[1]?.input.some(item => item.type === 'function_call_output' && String(item.output).includes('$25'))).toBe(true);
    expect(h.events.some(e => e.type === 'delta')).toBe(true);
    expect(h.store.turn('alice', h.turn.id)?.answer).toBe(result.answer);
    expect(result.stats).toMatchObject({ modelCalls: 2, searchQueries: 1, inputTokens: 20 });
  });
  it('runs independent queries concurrently, not serially', async () => {
    let active = 0; let peak = 0;
    const search: SearchProvider = { search: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return [source]; } };
    const h = harness([responseWithCall(toolCall([query, { ...query, query: 'Acme changelog' }])), reply('Checked. [S1]')], search);
    await h.run(); expect(peak).toBe(2);
  });
  it('preserves reasoning items between tool rounds with store:false', async () => {
    const response = responseWithCall(); response.output.unshift({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-state' });
    const h = harness([response, reply('Checked. [S1]')]); await h.run();
    expect(h.requests[1]?.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-state')).toBe(true);
  });
  it('exposes a failed search as missing evidence', async () => {
    const h = harness([responseWithCall(), reply('I could not verify current pricing.')], { search: async () => { throw new ProviderError('search', 429); } });
    const result = await h.run();
    expect(result.searches[0]?.status).toBe('failed');
    expect(result.warnings[0]).toContain('Could not verify');
    expect(JSON.stringify(h.requests[1]?.input)).toContain('never as no change');
    expect(result.sources).toEqual([]);
  });
  it('deduplicates identical queries only within one turn', async () => {
    const h = harness([responseWithCall(toolCall([query, query])), reply('Done. [S1]')]);
    await h.run(); expect(h.search.search).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown tools and malformed arguments without executing them', async () => {
    const invalid = { ...toolCall(), name: 'read_file', arguments: '{bad json' };
    const h = harness([responseWithCall(invalid), reply('I can only search the web.')]);
    await h.run(); expect(h.search.search).not.toHaveBeenCalled();
    expect(JSON.stringify(h.requests[1]?.input)).toContain('Invalid tool call');
  });
  it('enforces three search rounds, twelve queries, and a final no-tools call', async () => {
    const rounds = Array.from({ length: 3 }, (_, round) => responseWithCall(toolCall(Array.from({ length: 4 }, (_, i) => ({ ...query, query: `company ${round * 4 + i} pricing` })), `c${round}`)));
    const h = harness([...rounds, reply('Compared available evidence. [S1]')]);
    const result = await h.run();
    expect(result.stats?.searchQueries).toBe(LIMITS.searchQueries);
    expect(h.requests[3]?.allowSearch).toBe(false);
  });
  it('propagates cancellation and never saves a partial answer as complete', async () => {
    const h = harness([reply('Should not run')]); h.controller.abort();
    const result = await h.run();
    expect(result.status).toBe('cancelled'); expect(result.answer).toBe('');
    expect(h.model.respond).not.toHaveBeenCalled();
  });
  it('drops speculative pre-search prose from the final answer', async () => {
    const first = { ...responseWithCall(), text: 'Probably $10.' };
    const h = harness([first, reply('It is $25. [S1]')]);
    expect((await h.run()).answer).not.toContain('$10');
    expect(h.events.some(e => e.type === 'answer' && e.text === '')).toBe(true);
  });
  it('remaps saved citation IDs instead of pointing old claims at new evidence', async () => {
    const h = harness([responseWithCall(), reply('Previously $19 [S1]; now $25 [S2].')]);
    const old = h.store.beginTurn('alice', h.chat.id, randomUUID(), 'Acme pricing', '2026-11-03T12:00:00Z');
    h.store.finishTurn('alice', { ...old, status: 'complete', answer: '$19 [S8]', sources: [{ ...source, id: 'S8', excerpt: '$19 monthly', historical: false, observedAt: '2026-11-03T12:00:00Z' }] });
    const result = await h.run();
    expect(result.sources.map(s => [s.id, s.excerpt, s.historical])).toEqual([['S1', '$19 monthly', true], ['S2', source.excerpt, false]]);
    expect(JSON.stringify(h.requests[0]?.input)).not.toContain('[S8]');
  });
});

describe('evidence integrity', () => {
  it('keeps separate old and new snapshots of the same URL', () => {
    const evidence = new Evidence(); evidence.add({ ...source, historical: true });
    evidence.add({ ...source, historical: false, observedAt: '2026-11-11T12:00:00Z' });
    expect(evidence.all()).toHaveLength(2);
  });
  it('removes fabricated citations and never trusts model citation URLs', () => {
    const evidence = new Evidence(); evidence.add({ ...source, historical: false });
    const checked = evidence.check('Price [S1](https://evil.example) and [S99].');
    expect(checked.text).toBe('Price [S1] and [source unavailable].'); expect(checked.warnings).toHaveLength(1);
  });
  it.each(['javascript:alert(1)', 'data:text/html,secret', 'file:///etc/passwd', 'https://user:pass@example.com'])('rejects unsafe citation %s', url => {
    expect(safeUrl(url)).toBeNull();
  });
  it('removes tracking fields without removing meaningful URL parameters', () => {
    expect(safeUrl('https://example.com/pricing?plan=pro&utm_source=spam#top')).toBe('https://example.com/pricing?plan=pro');
  });
});

describe('provider contract', () => {
  it('exposes exactly one function tool', () => { expect(webSearchTool.name).toBe('web_search'); });
  it('uses publication filters only when requested and does not request a generated answer', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: source.title, url: source.url, content: source.excerpt }] }))) as unknown as typeof fetch;
    const search = new TavilySearch('test-key', fetcher, () => new Date('2026-11-10T12:00:00Z'));
    await search.search(query, new AbortController().signal);
    const [, init] = vi.mocked(fetcher).mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ include_answer: false, include_raw_content: false, max_results: 5, search_depth: 'advanced' });
    expect(body).not.toHaveProperty('start_date');
  });
  it('does not leak provider error response bodies', async () => {
    const search = new TavilySearch('secret', async () => new Response('private response body', { status: 401 }));
    await expect(search.search(query, new AbortController().signal)).rejects.toThrow('authentication failed');
  });
});
