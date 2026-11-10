import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { lexicalQuery, resolveTime, retrieveMemory } from '../server/memory.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const stores: Store[] = [];
function setup() {
  const store = new Store();
  stores.push(store);
  store.createOwner('alice');
  store.createOwner('bob');
  return store;
}
function seed(
  store: Store,
  owner: string,
  chatId: string,
  question: string,
  date: string,
  answer = 'Original answer',
) {
  const turn = store.beginTurn(owner, chatId, randomUUID(), question, date);
  store.finishTurn(owner, { ...turn, answer, status: 'complete' });
  return turn.id;
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});

describe('calendar resolution', () => {
  it.each([
    ['On Monday we shortlisted CRMs. Anything changed since?', '2026-11-09'],
    ['Last Tuesday I asked about Postgres hosting.', '2026-11-03'],
    ['What did I ask you on 3 November? Is your answer still correct today?', '2026-11-03'],
    ['What did I ask on 2026-11-03?', '2026-11-03'],
    ['What did we discuss yesterday?', '2026-11-09'],
  ])('%s', (question, expected) => {
    expect(resolveTime(question, now, 'UTC').window?.start.slice(0, 10)).toBe(expected);
  });
  it('resolves a missing year to the past across New Year', () => {
    expect(
      resolveTime('On December 30', new Date('2026-01-02T12:00:00Z'), 'UTC').window?.start,
    ).toBe('2025-12-30T00:00:00.000Z');
  });
  it('uses the browser timezone across midnight', () => {
    expect(
      resolveTime('yesterday', new Date('2026-11-10T00:30:00Z'), 'America/Los_Angeles').window
        ?.start,
    ).toBe('2026-11-08T08:00:00.000Z');
  });
  it('handles a 25-hour DST day', () => {
    const { window } = resolveTime('November 1, 2026', now, 'America/New_York');
    expect(Date.parse(window!.end) - Date.parse(window!.start)).toBe(25 * 3600_000);
  });
  it('does not choose between ambiguous numeric dates', () => {
    expect(resolveTime('What did I ask on 03/11?', now, 'UTC')).toMatchObject({
      window: null,
      note: expect.stringContaining('ambiguous'),
    });
  });
  it('does not choose between two weekdays', () => {
    expect(resolveTime('Monday or Tuesday?', now, 'UTC').window).toBeNull();
  });
  it('rejects an invalid timezone', () => {
    expect(() => resolveTime('hello', now, 'Mars/Base')).toThrow();
  });
  it('does not silently normalize an impossible ISO date', () => {
    expect(resolveTime('What did I ask on 2026-02-30?', now, 'UTC')).toMatchObject({
      window: null,
      note: expect.stringContaining('invalid'),
    });
  });
  it('does not interpret next Tuesday as last Tuesday', () => {
    expect(resolveTime('next Tuesday', now, 'UTC').window).toBeNull();
  });
});

describe('durable, scoped recall', () => {
  it('recalls the complete shortlist from another conversation on the requested date', () => {
    const store = setup();
    const earlier = store.createConversation('alice');
    const current = store.createConversation('alice');
    const id = seed(
      store,
      'alice',
      earlier.id,
      'Shortlist 5 CRMs for our 20-person sales team',
      '2026-11-09T15:00:00Z',
      'HubSpot, Pipedrive, Zoho, Salesforce, Freshsales.',
    );
    const memory = retrieveMemory(
      store,
      'alice',
      current.id,
      'On Monday we shortlisted 5 tools. Have any changed?',
      now,
      'UTC',
    );
    expect(memory.turns[0]?.id).toBe(id);
    expect(memory.turns[0]?.answer).toContain('Freshsales');
    expect(memory.references[0]?.reason).toBe('date');
  });
  it('keeps other users and demo fixtures out of real recall', () => {
    const store = setup();
    const current = store.createConversation('alice');
    seed(store, 'bob', store.createConversation('bob').id, 'Secret CRM', '2026-11-09T15:00:00Z');
    seed(
      store,
      'alice',
      store.createConversation('alice', true).id,
      'Demo CRM',
      '2026-11-09T15:00:00Z',
    );
    expect(retrieveMemory(store, 'alice', current.id, 'CRM Monday', now, 'UTC').turns).toEqual([]);
  });
  it('recalls the original question after cancellation, but never the partial answer', () => {
    const store = setup();
    const chat = store.createConversation('alice');
    const turn = store.beginTurn(
      'alice',
      chat.id,
      randomUUID(),
      'Postgres hosting',
      '2026-11-03T12:00:00Z',
    );
    store.finishTurn('alice', { ...turn, status: 'cancelled', answer: 'Unverified price' });
    const recalled = store.recall('alice', {
      query: lexicalQuery('Postgres hosting'),
      limit: 10,
      demo: false,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({
      question: 'Postgres hosting',
      answer: '',
      sources: [],
      status: 'cancelled',
    });
  });
  it('enforces ownership for reads, updates and deletes', () => {
    const store = setup();
    const chat = store.createConversation('alice');
    const turn = store.beginTurn('alice', chat.id, randomUUID(), 'Private');
    expect(store.turns('bob', chat.id)).toEqual([]);
    expect(store.turn('bob', turn.id)).toBeUndefined();
    expect(store.deleteConversation('bob', chat.id)).toBe(false);
    expect(() => store.finishTurn('bob', { ...turn, status: 'complete' })).toThrow();
  });
  it('preserves source snapshots and prevents rewriting completed history', () => {
    const store = setup();
    const chat = store.createConversation('alice');
    const turn = store.beginTurn('alice', chat.id, randomUUID(), 'Price?');
    const final = {
      ...turn,
      status: 'complete' as const,
      sources: [
        {
          id: 'S1',
          title: 'Pricing',
          url: 'https://example.com/pricing',
          excerpt: '$19',
          observedAt: '2026-11-03T12:00:00Z',
          query: 'pricing',
          historical: false,
        },
      ],
    };
    store.finishTurn('alice', final);
    expect(() => store.finishTurn('alice', { ...final, sources: [] })).toThrow();
    expect(store.turn('alice', turn.id)?.sources[0]?.excerpt).toBe('$19');
  });
  it('safely handles FTS punctuation and operator injection', () => {
    const store = setup();
    seed(
      store,
      'alice',
      store.createConversation('alice').id,
      'Postgres hosting',
      '2026-11-03T12:00:00Z',
    );
    expect(() =>
      store.recall('alice', {
        query: lexicalQuery('Postgres " OR * NEAR()'),
        limit: 5,
        demo: false,
      }),
    ).not.toThrow();
  });
  it('survives a database restart and marks orphaned work failed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-test-'));
    const path = join(dir, 'db.sqlite');
    let store = new Store(path);
    try {
      store.createOwner('alice');
      const chat = store.createConversation('alice');
      const id = seed(store, 'alice', chat.id, 'Saved', '2026-11-03T12:00:00Z');
      const pending = store.beginTurn('alice', chat.id, randomUUID(), 'Interrupted');
      store.close();
      store = new Store(path);
      expect(store.turn('alice', id)?.answer).toBe('Original answer');
      expect(store.turn('alice', pending.id)?.status).toBe('failed');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('signals truncation instead of claiming exhaustive history', () => {
    const store = setup();
    const chat = store.createConversation('alice');
    for (let i = 0; i < 20; i++)
      seed(store, 'alice', chat.id, `Question ${i}`, '2026-11-03T12:00:00Z');
    expect(
      retrieveMemory(store, 'alice', chat.id, 'What did I ask on 3 November?', now, 'UTC')
        .truncated,
    ).toBe(true);
  });
});
