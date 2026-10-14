# AI configuration

MundiTrace does not select or host an AI provider. AI is optional and uses the OpenAI Chat Completions request and response format.

## Configure a provider

1. Open **Settings → AI configuration**.
2. Enter the complete Chat Completions URL ending in `/chat/completions`.
3. Enter the model name expected by that endpoint.
4. Enter the API key. Use **Save on this computer**.
5. Enter both input and output prices in RMB per million tokens to enable automatic filtering.
6. Turn on the AI master switch, then run **Test provider connection**.

The endpoint must use HTTPS, except for an HTTP endpoint on `localhost`, `127.0.0.1`, or `::1`. Credentials in the URL and query parameters named like API keys or tokens are rejected. Use the API key field for authentication.

The key is written to `.env.local` with owner-only file permissions where supported. The API returns the endpoint, model, prices, and a boolean key status, never the key. Leaving the key field empty preserves the saved key. **Clear saved API key** removes it. The form does not save the key to browser storage.

## Cost controls

Input and output prices are separate user-provided values in RMB per million tokens. Automatic title filtering requires both values and stops before a request if the conservative reservation would exceed ¥2 for the current calendar month. When the provider returns token usage, the reservation is settled to the calculated estimate. When usage is missing, the reservation remains charged to the local budget.

Manual analysis is not blocked by a missing price or by the automatic filter budget. Without both rates, its cost is shown as unknown. If the provider omits token usage, the request is also counted as unknown cost. These are estimates based on the rates you entered, not a provider invoice.

## What leaves this computer

- Connection test: a small JSON-only test prompt.
- Automatic filtering: report titles only.
- On-demand analysis: public report titles, summaries, source names/IDs, and excerpts already read in MundiTrace.

The AI provider receives the content for the requested operation. Holdings, saved company lists, and workspace preferences are not included. MundiTrace does not persist generated AI responses. The locally stored budget totals contain token counts and estimated costs, not the prompts or responses.

## Local API boundary

The application server binds to loopback. Its `/api/world-pulse/*` routes reject non-local hosts and cross-origin requests. AI keys are sent from the local service to the configured provider in the standard `Authorization: Bearer` header; they are never embedded in browser bundles or API responses.
