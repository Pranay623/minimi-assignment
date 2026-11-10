import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { resolveTime, retrieveMemory } from '../server/memory.js';

// A deterministic retrieval benchmark, not a score for model answer quality.
const store = new Store();
const now = new Date('2026-11-10T12:00:00.000Z');
store.createOwner('reviewer');
store.createOwner('other');
const earlier = store.createConversation('reviewer');
const current = store.createConversation('reviewer');
const add = (
  question: string,
  answer: string,
  date: string,
  owner = 'reviewer',
  chatId = earlier.id,
) => {
  const turn = store.beginTurn(owner, chatId, randomUUID(), question, date);
  store.finishTurn(owner, { ...turn, answer, status: 'complete' });
  return turn;
};
const postgres = add(
  'Compare Postgres hosting with daily backups.',
  'We considered Neon, Supabase, and Render. Quoted prices are unverified prior claims.',
  '2026-11-03T12:00:00.000Z',
);
const crm = add(
  'Shortlist 5 CRM tools for a 20-person team.',
  'HubSpot, Pipedrive, Zoho, Salesforce, Freshsales; monthly billing; $800 budget.',
  '2026-11-09T09:00:00.000Z',
);
add('Unrelated lunch recommendation', 'Try soup.', '2026-11-08T12:00:00.000Z');
add(
  'Secret CRM decision',
  'Private competitor shortlist.',
  '2026-11-09T10:00:00.000Z',
  'other',
  store.createConversation('other').id,
);
add(
  'Demo CRM decision',
  'Fictional demo facts.',
  '2026-11-09T10:00:00.000Z',
  'reviewer',
  store.createConversation('reviewer', true).id,
);
const recall = (question: string) =>
  retrieveMemory(store, 'reviewer', current.id, question, now, 'UTC');
const cases: [string, () => void][] = [
  [
    'Monday CRM shortlist: all five entities and team constraints survive',
    () => {
      const result = recall(
        'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any changed pricing or shipped something big since?',
      );
      assert.equal(result.turns[0]?.id, crm.id);
      for (const entity of ['HubSpot', 'Pipedrive', 'Zoho', 'Salesforce', 'Freshsales'])
        assert.ok(result.turns[0]?.answer.includes(entity));
      assert.ok(result.turns[0]?.question.includes('20-person'));
      assert.ok(result.turns[0]?.answer.includes('$800'));
    },
  ],
  [
    '3 November recall ignores today as the historical anchor',
    () => {
      const result = recall(
        'What did I ask you on 3 November? Is your answer still correct today?',
      );
      assert.equal(result.turns[0]?.id, postgres.id);
      assert.equal(result.dateMatches, 1);
    },
  ],
  [
    'Last Tuesday resolves across conversations',
    () => {
      assert.equal(
        recall('Last Tuesday I asked about Postgres hosting. Has pricing changed since?').turns[0]
          ?.id,
        postgres.id,
      );
    },
  ],
  [
    'Topic-only query retrieves a nonrecent conversation',
    () => {
      for (let i = 0; i < 8; i++) add(`Dinner ${i}`, 'Pasta', `2026-11-10T0${i}:00:00.000Z`);
      assert.ok(recall('Postgres backups').turns.some((t) => t.id === postgres.id));
    },
  ],
  [
    'Missing dated history remains visibly missing',
    () => {
      assert.equal(recall('What did I ask on 1 November?').dateMatches, 0);
    },
  ],
  [
    'Private and demo histories never enter real memory',
    () => {
      assert.ok(!JSON.stringify(recall('CRM')).includes('Private competitor'));
      assert.ok(!JSON.stringify(recall('CRM')).includes('Fictional demo'));
    },
  ],
  [
    'User correction is retained alongside the earlier claim',
    () => {
      const corrected = add(
        'Correction: our team now has 12 people, not 20.',
        'Understood: 12 seats.',
        '2026-11-10T11:00:00.000Z',
        'reviewer',
        current.id,
      );
      assert.ok(recall('Recheck our CRM shortlist').turns.some((t) => t.id === corrected.id));
    },
  ],
  [
    'Ambiguous dates are not guessed',
    () => {
      assert.equal(resolveTime('03/11', now, 'UTC').window, null);
    },
  ],
  [
    'Explicit year takes precedence',
    () => {
      assert.equal(
        resolveTime('3 November 2025', now, 'UTC').window?.start,
        '2025-11-03T00:00:00.000Z',
      );
    },
  ],
  [
    'Year rollover uses the most recent past occurrence',
    () => {
      assert.equal(
        resolveTime('December 30', new Date('2026-01-02T12:00:00Z'), 'UTC').window?.start,
        '2025-12-30T00:00:00.000Z',
      );
    },
  ],
  [
    'Local yesterday respects an offset across midnight',
    () => {
      assert.equal(
        resolveTime('yesterday', new Date('2026-11-10T00:30:00Z'), 'America/Los_Angeles').window
          ?.start,
        '2026-11-08T08:00:00.000Z',
      );
    },
  ],
  [
    'DST day uses calendar boundaries, not 24-hour subtraction',
    () => {
      const range = resolveTime('1 November 2026', now, 'America/New_York').window!;
      assert.equal(Date.parse(range.end) - Date.parse(range.start), 90_000_000);
    },
  ],
];
let failed = 0;
try {
  for (const [name, check] of cases) {
    try {
      check();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL  ${name}\n${(error as Error).message}`);
    }
  }
  console.log(
    `\nTemporal retrieval: ${cases.length - failed}/${cases.length} passed. No model or search API called.`,
  );
  console.log(failed ? 'VERDICT: FAIL -- temporal retrieval regressions' : 'VERDICT: PASS');
  if (failed) process.exitCode = 1;
} finally {
  store.close();
}
