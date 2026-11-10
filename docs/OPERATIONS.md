# Running and operating Thread

## Setup

Use Node 24+, npm, and one server process per SQLite database. The app supports Windows, macOS, and Linux; CI checks Windows and Linux. Copy `.env.example` to `.env`, then run `npm install` and `npm run dev`. Without keys, the offline walkthrough remains usable. `.env`, SQLite data, and evaluation output are ignored by Git.

OpenAI:

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=<your OpenAI Platform key>
OPENAI_MODEL=gpt-5.4
TAVILY_API_KEY=<your Tavily key>
```

AgentRouter.org:

```dotenv
MODEL_PROVIDER=agentrouter
AGENTROUTER_API_KEY=<your AgentRouter.org key>
CHAT_MODEL=<exact model enabled for your account>
TAVILY_API_KEY=<your Tavily key>
```

This selects `https://agentrouter.org/v1` and Chat Completions, as documented in [AgentRouter's setup guide](https://github.com/agentrouter-org/docs/blob/main/en/codex.md). Use `MODEL_API=responses` only for a supporting route. An OpenAI model name does not guarantee availability or protocol support through a gateway. There is no automatic provider/model fallback.

Gemini:

```dotenv
MODEL_PROVIDER=google
GOOGLE_API_KEY=<your Google AI Studio key>
CHAT_MODEL=gemini-2.5-flash
TAVILY_API_KEY=<your Tavily key>
```

`CHAT_MODEL` overrides `OPENAI_MODEL`. Gemini and AgentRouter accept a provider key in `OPENAI_API_KEY` if their canonical key is absent; prefer the explicitly named key. Never put keys in `VITE_` variables. `OPENAI_BASE_URL` can select a trusted HTTPS endpoint supporting the chosen protocol. Only server configuration controls that destination.

## Troubleshooting

| Symptom                                    | Action                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Preview mode                               | Fill the missing keys. Save `.env`; dev reloads. Refresh the browser to reload configuration.                                          |
| HTTP 401/403                               | Check that the key belongs to the provider and the account permits API access.                                                         |
| AgentRouter “unauthorized client detected” | Resolve API client/account access with AgentRouter or choose another supported provider. Changing the model cannot fix authentication. |
| HTTP 404                                   | Check the exact model name, endpoint, and protocol.                                                                                    |
| HTTP 429                                   | Wait or check quota. Thread does not automatically repeat billable requests.                                                           |
| Failed/empty search                        | The answer exposes the gap. Absence of results is not proof of no change.                                                              |
| Incomplete turn after restart              | Startup marks orphaned pending turns failed. Questions survive; retry explicitly.                                                      |
| Missing history                            | Use the same hostname and browser profile. `localhost` and `127.0.0.1` have different cookies; incognito is separate.                  |
| Port in use                                | Set `PORT` to an unused port.                                                                                                          |

`npm run eval:live` checks a real model/search round trip. `npm run eval:model` uses a real model with controlled search evidence. Both incur model usage, save reports under `data/`, and do not print keys.

## State and privacy

The default database is `data/agent.sqlite`, with WAL enabled. A random HTTP-only, SameSite=Strict cookie identifies the workspace; only its hash is stored. SQL reads/writes require its owner. This provides isolation, not account authentication. Clearing cookies loses access; it does not erase the database.

Deleting a conversation removes its turns and evidence logically. This is not secure erasure of SQLite/WAL pages, backups, or provider records. For a local backup, stop the server and copy the entire `data/` directory. Database contents are not encrypted at rest.

Relevant historical excerpts go to the selected model provider and its upstream service when routed. Public search queries go to Tavily. OpenAI Responses sets `store:false`; provider retention policies still apply. Fonts are loaded from Google Fonts, with local fallbacks.

Completed request UUIDs replay saved results without another model call. A UUID cannot be reused for a different message. Cancellation aborts local HTTP work, but already-started provider work may still be billed. Limits are one active turn per owner, four per process, and twelve mutations per owner per minute.

## Hosting

Run `npm run build`, then `npm start`. Bind defaults to loopback. `HOST`, `PORT`, `DATABASE_PATH`, and `PUBLIC_ORIGIN` are configurable. Host/Origin validation blocks cross-site requests and DNS rebinding. Requests have body limits. Retrieved source URLs are never fetched by this server; the only research HTTP destination is Tavily. Markdown does not execute raw HTML and remote images are disabled.

Before exposing the app publicly, add authentication, authenticated-user quotas, TLS/proxy configuration, retention controls, and provider spend limits. Anonymous users can obtain fresh identities, so current quotas are not a public abuse-control boundary. Startup recovery assumes one process owns the database; multiple instances require coordination. Do not publicly serve development mode.
