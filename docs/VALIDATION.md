# Observed validation

Checked on 10 November 2026 with Node 24.21.0 on Windows. CI also runs on Linux and Windows. The live CI badge in the README refers to the latest pushed commit; counts below describe the local verification.

| Check                          | Result                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| TypeScript + production build  | Passed                                                                              |
| Unit/integration tests         | 63 passed, including real SDKs against controlled HTTP streams                      |
| Temporal retrieval evaluation  | 12/12 passed, no API calls                                                          |
| Chromium browser tests         | 5 passed; includes mobile navigation and axe checks on home/settings                |
| Dependency audit               | No known vulnerabilities reported by `npm audit`                                    |
| Live Tavily request            | HTTP 200, search results returned                                                   |
| Live complete agent run        | **Not verified**: AgentRouter.org returned HTTP 401, “unauthorized client detected” |
| Real-model behavior evaluation | Not run successfully; blocked by the same provider access issue                     |

The AgentRouter rejection came from the provider gateway using the configured account. It is not evidence that another account, route, or model will work. The implementation retains direct OpenAI and Gemini adapters as explicit alternatives. Re-run `npm run eval:live` after resolving provider/client access, then `npm run eval:model` and inspect the answers using the rubric in [EVALUATION.md](EVALUATION.md).

The offline walkthrough and deterministic tests are not substitutes for a successful live model evaluation. No claim of frontier-quality parity, production readiness, exhaustive recall, or guaranteed factual correctness is made.
