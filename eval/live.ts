import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { configuration } from '../server/config.js';
import { Store } from '../server/db.js';
import { runAgent } from '../server/agent.js';

const { config, agent } = configuration();
if (!agent) {
  console.error(`Live smoke requires ${config.missingKeys.join(', ')}.`);
  process.exit(1);
}
const store = new Store();
store.createOwner('smoke');
const chat = store.createConversation('smoke');
const turn = store.beginTurn(
  'smoke',
  chat.id,
  randomUUID(),
  "What is Tavily's current pay-as-you-go API credit price? Check its official pricing page and cite your source. Keep the answer under 100 words.",
);
try {
  console.log(`Live provider smoke · ${config.model} + Tavily`);
  const result = await runAgent(
    { store, ...agent },
    {
      owner: 'smoke',
      turn,
      timezone: 'UTC',
      signal: new AbortController().signal,
      emit: (event) => {
        if (event.type === 'status') console.log(event.message);
        if (event.type === 'search')
          console.log(`Search ${event.search.status}: ${event.search.query}`);
        if (event.type === 'error') console.error(event.message);
      },
    },
  );
  const pass =
    result.status === 'complete' &&
    result.sources.some((s) => !s.historical && new URL(s.url).hostname.endsWith('tavily.com')) &&
    /\[S\d+\]/.test(result.answer);
  const report = {
    timestamp: new Date().toISOString(),
    model: config.model,
    pass,
    question: turn.question,
    answer: result.answer,
    stats: result.stats,
    warnings: result.warnings,
    sources: result.sources.map(({ id, url, observedAt }) => ({ id, url, observedAt })),
  };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/live-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `VERDICT: ${pass ? 'PASS' : 'FAIL -- live provider smoke did not return a sourced answer'}`,
  );
  if (!pass) process.exitCode = 1;
} finally {
  store.close();
}
