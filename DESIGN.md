# Thread: remembering is not verifying

The difficult query is not “What does this cost?” It is “Has it changed since we spoke?” That requires two different kinds of evidence: the actual earlier conversation and a fresh observation of the world. Thread keeps them separate.

**One agent, one tool.** A small TypeScript orchestrator supplies relevant local history to an OpenAI Responses API model. The only model-callable tool is `web_search`, backed by Tavily. Memory retrieval is application code, not another tool. The model decides when to search, can batch independent queries, and can follow up when evidence is missing. Simple conversation avoids search entirely.

**Durable, attributable memory.** SQLite holds original question/answer pairs and source excerpts with observation timestamps. Retrieval combines explicit local dates, lexical search, and recent conversational context, always scoped to the browser's server-issued identity. Prior assistant answers are claims, not ground truth. A source observed today does not establish its historical price or when a change happened. Ambiguous dates and missing baselines must stay visible.

**Evidence before confidence.** Search results are untrusted data. Each excerpt receives a server-assigned citation ID. The agent distinguishes confirmed changes, values observed at two times, and insufficient evidence. Historical snapshots remain immutable. Citations link to the actual retrieved URL; observation dates are distinct from publication and effective dates.

**Bound the work, expose the work.** Streaming progress makes retrieval and search visible. Hard query, round, output, and time budgets prevent runaway loops. A failed search is a failed check, never evidence of no change. Abort signals propagate to providers. Tests exercise history isolation, date boundaries, evidence provenance, and failure behavior rather than only happy-path text.

**Rejected.** A vector database plus LLM-written summaries adds infrastructure and risks losing the exact old price or shortlist. Sending all history grows cost without bound. A planner/researcher/critic swarm adds serial latency before demonstrating a quality gain. Aggressive caching is especially misleading for “has anything changed?” Explicit dated retrieval and preserved originals are a smaller foundation to evaluate first.

**Another week.** Measure a larger held-out temporal benchmark against a full-history baseline; add hybrid semantic retrieval where lexical recall demonstrably misses; evaluate claim-to-excerpt entailment and contradiction handling; add authentication, encrypted retention controls, and distributed quotas before public hosting. No claim of frontier parity without a comparative live evaluation.
