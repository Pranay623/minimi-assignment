# Thread

A chat agent that remembers the conversation and checks what changed.

Built for the [minimi hiring challenge](https://github.com/Pranay623/minimi-assignment): one agent, one tool (**web search**), durable memory, and evidence you can inspect.

## Development

Requires **Node.js 24+** (uses built-in SQLite).

```sh
npm install
```

Copy `.env.example` to `.env`, add `OPENAI_API_KEY` and `TAVILY_API_KEY`, then:

```sh
npm run dev
```

Open http://localhost:3000. Without keys the app offers an explicitly labeled, offline walkthrough; live chat requires both keys.

## Architecture

The implementation is being built in focused milestones:

1. Persistent, tenant-scoped conversation memory and timezone-aware recall.
2. Bounded Responses API loop, Tavily search, immutable source snapshots.
3. Streaming chat, inspectable evidence, and an offline walkthrough.
4. Temporal evaluations, integration tests, and operational documentation.

Read [DESIGN.md](DESIGN.md) for the core choices.
