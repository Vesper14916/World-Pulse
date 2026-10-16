# Privacy

World Pulse is designed to run on the user's computer. It has no shared backend, account system, analytics integration, or hosted AI endpoint.

## Data stored locally

- A rolling cache of public reports and source status, kept in `.world-pulse/` for up to 168 hours.
- Workspace preferences and user-entered company details in the browser's local storage.
- Optional provider and data-source credentials in `.env.local`.
- Aggregate AI token counts and estimated local costs in the local database.

The local API does not retain AI responses. Configuration export omits credentials, news data, and AI response content. The local database and `.env.local` are ignored by Git.

## Network requests

The local service retrieves public feeds and data from their publishers. Opening a report can request its public article page for a readable excerpt. If AI is enabled, a connection test sends a small test prompt, automatic filtering sends report titles only, and requested analysis sends public report content to the provider configured by the user. Review that provider's terms and privacy policy before use.

Optional integrations such as market quotes and maritime observations contact their selected public providers. Their API credentials stay on the local service. Report links, map tiles, and provider requests can disclose ordinary network metadata such as your IP address to those services.

## No public AI service

The server binds to `127.0.0.1`, and its API rejects non-local host headers and cross-origin requests. World Pulse does not expose an AI route on the public internet or relay requests through a project-owned service.

## Remove local data

Turn off AI and clear the saved API key in Settings → AI configuration. To remove cached reports and local settings, stop World Pulse, delete `.world-pulse/`, and clear the browser's site data for `127.0.0.1`. Remove `.env.local` to delete any locally stored provider credentials. These operations do not revoke keys at their provider; revoke them there if needed.

## Limitations

The rolling cache is not a full archive, backup, or cross-device sync. Clearing browser data removes local workspace preferences. Clearing `.world-pulse/` removes cached reports and aggregate AI usage totals.
