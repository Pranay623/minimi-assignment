# Explaining the implementation

## Follow one turn

1. `app.ts` identifies the browser, validates ownership and idempotency, and saves a pending question. Clients cannot select an owner or backdate messages.
2. `memory.ts` resolves local dates and retrieves original records. Date matches take priority; recent context resolves follow-ups; FTS finds older named topics across conversations.
3. `agent.ts` builds bounded context. Historical citation numbers are remapped so an old `[S1]` cannot accidentally point at a new source.
4. The model answers or calls the sole `web_search` tool. `search.ts` validates arguments and runs independent Tavily queries concurrently. Errors return as missing evidence.
5. `evidence.ts` assigns IDs to timestamped excerpts. The same URL observed at two times stays two records.
6. The next model request includes tool results and opaque provider continuation. OpenAI encrypted reasoning and Gemini thought signatures stay within the run; private reasoning is not displayed.
7. Citation IDs are checked and a completed answer is saved once. Disconnect/cancellation/deadline produces an incomplete turn. Questions survive; unfinished answers do not become knowledge.

## Decisions to defend

- **SQLite:** simple setup, transactions, exact originals, FTS and calendar filtering. Distant paraphrases remain a recall limitation to measure.
- **Application-managed memory:** respects the single-tool rule; ownership and retrieval are testable application responsibilities.
- **One loop:** fewer serial calls, simpler failures. A targeted verification pass is a future experiment, not an assumed improvement.
- **Search excerpts:** no second browsing tool. Excerpt incompleteness stays visible; the agent cannot claim it audited an entire site.
- **No persistent search cache:** rechecking requires another observation. Identical queries are deduplicated only within a turn.
- **Claims versus evidence:** the old answer might have been wrong. A correction is different from a recent change.
- **Code plus prompts:** code enforces ownership, tool names, budgets, IDs, and persistence. The model still judges source relevance and comparable billing terms.
- **Provider transports:** “OpenAI compatible” does not imply Responses support. The agent depends on a small `LanguageModel` interface, not an SDK's permanent thread store.

There is no guaranteed complete recall, semantic fact-checker, exhaustive web coverage, production account system, or demonstrated frontier parity. `DESIGN.md` identifies the measurements needed before adding more complexity.
