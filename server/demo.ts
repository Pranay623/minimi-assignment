import { randomUUID } from 'node:crypto';
import type { AgentEvent, Turn } from '../shared/types.js';
import type { Store } from './db.js';

export const DEMO_DATE = '2026-11-10T12:00:00.000Z';
export const DEMO_PROMPTS = [
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
  'What did I ask you on 3 November? Is your answer still correct today?',
  'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
] as const;

/** Fictional providers and .example URLs prevent a walkthrough from posing as real research. */
export function seedDemo(store: Store, owner: string) {
  const existing = store.conversations(owner).find((chat) => chat.demo);
  if (existing) return existing;
  const chat = store.createConversation(owner, true, DEMO_DATE);
  const add = (question: string, answer: string, date: string) => {
    const turn = store.beginTurn(owner, chat.id, randomUUID(), question, date);
    store.finishTurn(owner, { ...turn, answer, status: 'complete' });
  };
  add(
    'Compare Postgres hosting for a small SaaS. We need backups and predictable monthly billing.',
    '**Sample conversation · 3 November**\n\nWe compared **HarborDB** ($19/month), **BranchDB** ($25/month), and **CloudPost** ($29/month). All prices and providers in this walkthrough are fictional. We favored HarborDB for its predictable baseline, pending a backup-retention check.',
    '2026-11-03T10:00:00.000Z',
  );
  add(
    'Shortlist 5 CRM tools for a 20-person sales team. Keep it below $800/month if possible.',
    '**Sample conversation · 9 November**\n\nOur fictional shortlist was **Cedar CRM**, **Orbit Sales**, **Pine CRM**, **Relay CRM**, and **Fieldnotes**. Budget: $800/month for 20 seats. We need monthly billing and a usable reporting workflow.',
    '2026-11-09T10:00:00.000Z',
  );
  return store.conversation(owner, chat.id)!;
}

export async function runDemo(
  store: Store,
  owner: string,
  turn: Turn,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<Turn> {
  const started = performance.now();
  const all = store.turns(owner, turn.conversationId);
  const crm = turn.question === DEMO_PROMPTS[0];
  const baseline = all.find((t) => t.createdAt.startsWith(crm ? '2026-11-09' : '2026-11-03'))!;
  const memory = [
    {
      turnId: baseline.id,
      conversationId: baseline.conversationId,
      question: baseline.question,
      createdAt: baseline.createdAt,
      reason: 'date' as const,
    },
  ];
  const wait = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 65);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  emit({ type: 'status', message: 'Replaying a saved example · no API calls' });
  emit({
    type: 'memory',
    references: memory,
    note: `${crm ? '9' : '3'} November 2026 · demo clock`,
  });
  const supported = DEMO_PROMPTS.includes(turn.question as (typeof DEMO_PROMPTS)[number]);
  const answer = !supported
    ? 'This is a **scripted walkthrough**, not a live model. Try one of the three example questions below, or start a new conversation after adding your API keys to `.env`.'
    : crm
      ? `Your shortlist from **Monday, 9 November** was Cedar CRM, Orbit Sales, Pine CRM, Relay CRM, and Fieldnotes, for **20 people at up to $800/month**.\n\nIn this fictional example, **one price changed and one feature shipped**.\n\n| Tool | Then → now | What it means |\n| :--- | :--- | :--- |\n| Cedar CRM | $24 → $29/seat/month | +$100/month for 20 seats; still under budget. [S2] |\n| Orbit Sales | New reporting dashboard | Relevant to your reporting requirement. [S3] |\n| Pine CRM | $35 → $35/seat/month | No difference in the checked price. |\n| Relay CRM | Pricing unavailable | I cannot verify a change. |\n| Fieldnotes | $39 → $39/seat/month | No difference in the checked price. |\n\n**My take:** keep Cedar on the shortlist at $580/month, and try Orbit’s reporting before deciding. Relay needs another check.\n\n*Illustrative data only. No live search was performed.*`
      : `On **Tuesday, 3 November**, you asked about **Postgres hosting for a small SaaS**, with backups and predictable monthly billing. We compared HarborDB, BranchDB, and CloudPost.\n\nThe earlier recommendation needs one update in this fictional example:\n\n| Provider | 3 November | 10 November | Assessment |\n| :--- | :--- | :--- | :--- |\n| HarborDB | $19/month [S1] | $24/month [S2] | $5 higher; the example announcement is dated 6 November. |\n| BranchDB | $25/month | $25/month | No difference in the checked price. |\n| CloudPost | $29/month | Not verified | Current pricing could not be checked. |\n\n**HarborDB is still the cheapest verified option**, but the gap is now only $1/month. I would compare backup retention before choosing. I can’t conclude that CloudPost is unchanged.\n\n*Illustrative data only. Providers, prices, and source excerpts are fictional. No live search was performed.*`;
  const sources = supported
    ? [
        {
          id: 'S1',
          title: crm ? 'Cedar · saved pricing example' : 'HarborDB · saved pricing example',
          url: 'https://example.com/previous-price',
          excerpt: crm
            ? 'Fictional: monthly plan $24/seat, observed November 9.'
            : 'Fictional: monthly plan $19, observed November 3.',
          observedAt: baseline.createdAt,
          query: 'offline fixture',
          historical: true,
        },
        {
          id: 'S2',
          title: crm ? 'Cedar · new price example' : 'HarborDB · new price example',
          url: 'https://example.com/current-price',
          excerpt: crm
            ? 'Fictional: monthly plan $29/seat, effective November 10.'
            : 'Fictional: monthly plan $24, effective November 6.',
          observedAt: DEMO_DATE,
          publishedAt: crm ? '2026-11-10' : '2026-11-06',
          query: 'offline fixture',
          historical: false,
        },
        ...(crm
          ? [
              {
                id: 'S3',
                title: 'Orbit · release example',
                url: 'https://example.com/release',
                excerpt: 'Fictional: Reporting dashboard released November 10.',
                observedAt: DEMO_DATE,
                publishedAt: '2026-11-10',
                query: 'offline fixture',
                historical: false,
              },
            ]
          : []),
      ]
    : [];
  emit({ type: 'sources', sources });
  for (const chunk of answer.match(/.{1,32}/gs) ?? []) {
    if (signal.aborted) break;
    emit({ type: 'delta', text: chunk });
    await wait();
  }
  const final: Turn = {
    ...turn,
    answer: signal.aborted ? '' : answer,
    sources,
    memory,
    status: signal.aborted ? 'cancelled' : 'complete',
    warnings: ['Scripted demo with fictional data. No model or search API was called.'],
    stats: {
      durationMs: Math.round(performance.now() - started),
      firstTokenMs: 0,
      modelCalls: 0,
      searchQueries: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
  };
  store.finishTurn(owner, final);
  emit({ type: 'done', turn: final });
  return final;
}
