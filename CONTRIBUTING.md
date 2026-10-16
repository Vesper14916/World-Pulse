# Contributing

Thanks for contributing to World Pulse. Public-facing documentation and UI should be in English. Source headlines remain in the language published by their source.

## Before opening a pull request

1. Use Node.js 24 from `.nvmrc` and install with `npm ci`.
2. Keep changes focused on World Pulse and its required shared code.
3. Do not commit `.env.local`, `.world-pulse/`, personal data, private URLs, API keys, or screenshots containing local data.
4. Add or update focused tests for behavior changes.
5. Run:

   ```sh
   npm audit --audit-level=high
   npm run security:scan
   npm test
   npm run typecheck
   npm run build
   ```

6. Inspect the complete diff and confirm the application still binds only to loopback.

By submitting a contribution, you agree that it is distributed under the repository's AGPL-3.0-only license. Preserve existing copyright and attribution notices.
