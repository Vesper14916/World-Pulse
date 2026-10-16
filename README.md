# World-Pulse

**A local-first workspace for following world events, public reporting, and company signals on a map.**

World-Pulse brings public RSS, earthquake, market, and maritime feeds into one desktop-friendly interface. It runs on your computer, keeps a seven-day working cache, and makes AI analysis optional through an endpoint and API key that you choose.

This repository is a focused, local-first application extracted from [World Monitor](https://github.com/koala73/worldmonitor). It has its own install, build, and Git history. The source and this derivative work are distributed under **AGPL-3.0-only**; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

## What you can do

- Follow events in the **World**, **Portfolio**, **Explore**, **Reading**, and **Command** views.
- See public reports and source health alongside earthquake, company, market, and maritime signals.
- Keep a local rolling cache for up to 168 hours. It is a convenience cache, not a complete archive or backup.
- Optionally analyze reports with any user-selected API that supports OpenAI Chat Completions.
- Set local AI input and output prices; automatic title filtering observes a **¥2 monthly budget** and remains paused until both prices are configured.
- Use the app without an account, hosted backend, shared AI service, or project-provided API key.

## Quick start

**Requirements:** Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:3000/world](http://127.0.0.1:3000/world). The development server binds to loopback and continues collecting data while it is running, even if you close the browser. Press `Ctrl+C` in the terminal to stop it.

To build and preview the production bundle locally:

```sh
npm run build
npm run preview
```

The preview server also binds to loopback. These commands do not deploy the app.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/app/world-pulse/` | App entry and page integration |
| `src/components/world-pulse/` | User interface and map components |
| `src/services/world-pulse/` | Browser-side data and API clients |
| `server/world-pulse/` | Local feed, storage, market, maritime, and AI services |
| `server/_shared/` | Small shared server helper required by the extraction |
| `shared/` | Data types and logic shared across browser and server |
| `public/data/` | Geographic datasets with source and processing notes |
| `tests/` | Application unit and service tests |
| `docs/` | AI setup and privacy details |
| `.github/workflows/` | Credential-free checks for pull requests and `main` |

The `world-pulse` names in internal paths, the local cache, and `/api/world-pulse/*` are retained for compatibility.

## Configure integrations

Public RSS and USGS earthquake data work without credentials. Optional market and maritime integrations can be configured in `.env.local`, starting from the blank-value [.env.example](.env.example). Keep `.env.local` private; Git ignores it. Before enabling SEC requests, set a user-agent that identifies your app and provides a contact address.

### Optional AI

Open **Settings → AI configuration** and enter the full Chat Completions URL, model, API key, and input/output prices in RMB per million tokens. There is no provider or model default. The key is stored in the local `.env.local` file; the UI receives only a “key saved” status. When you make an AI request, the local service sends the key to the endpoint you selected for authentication.

Manual analysis works without prices, but its cost is marked unknown. Automatic title filtering stays paused and headlines remain visible until both prices are set. When enabled, automatic filtering sends titles only and uses a conservative reservation if the provider does not return token usage. These local estimates are not provider invoices.

See [AI configuration](docs/AI_CONFIGURATION.md), [Privacy](docs/PRIVACY.md), and [Security](SECURITY.md) before enabling a provider.

## Privacy and network use

The local service retrieves public feeds and data from their publishers. Opening a report may request its public article page for a readable excerpt. When you request AI analysis, your selected provider receives the requested public report titles, summaries, source identifiers, and excerpts already read in the app. Automatic filtering sends titles only. The app does not send holdings, saved company lists, or workspace preferences to the AI provider, and it does not save AI responses.

The local API is available only on loopback and rejects cross-origin requests. MundiTrace does not provide a hosted AI service or a public AI API. Public providers may receive ordinary network metadata, such as your IP address. Review a provider's terms and privacy policy before sending it data.

Read the full [privacy description](docs/PRIVACY.md).

## Data, attribution, and use

The included geographic data is derived from public-domain Natural Earth datasets. Sources, retrieval notes, and processing details are documented alongside the files in `public/data/`. Upstream source and direct software dependency notices are listed in [NOTICE.md](NOTICE.md).

News, article excerpts, market observations, maritime data, logos, and other third-party material remain subject to the rights and terms of their respective publishers and providers. This repository does not grant rights to redistribute that material. Check each provider's terms before using or republishing its content. MundiTrace is an information tool; reports and AI analysis can be incomplete or wrong and are not financial or investment advice.

## Development

```sh
npm run security:scan
npm test
npm run typecheck
npm run build
```

The GitHub Actions workflow runs these checks on pushes to `main` and pull requests. It has no provider credentials or deployment steps.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Public-facing documentation and UI use English. Do not submit credentials, personal data, local databases, private screenshots, or private service URLs.

## License

World Pulse is distributed under the GNU Affero General Public License, version 3 only. Preserve the license and required notices when redistributing covered source. If you modify the program and let users interact with that version over a network, AGPL section 13 also requires offering those users the corresponding source. Read the full [LICENSE](LICENSE) and [GNU AGPL text](https://www.gnu.org/licenses/agpl-3.0.en.html).
