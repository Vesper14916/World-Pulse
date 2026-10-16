# Security policy

Use the latest `main` revision and Node.js 24. World Pulse is a local-first project; do not expose its local server to an untrusted network.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Include the affected revision, steps to reproduce, and impact. Do not include live API keys, private report content, or other personal data in a public issue.

## Security boundaries

- Provider keys belong in the local Settings form or `.env.local`, never in source, issues, screenshots, or pull requests.
- The local API binds to loopback and enforces local host and same-origin checks.
- The AI config endpoint never returns the key; blank saves preserve it, and a separate operation removes it.
- Public reports are treated as untrusted input. AI output is validated before display.
- CI runs a repository scan and tests without provider credentials or deployment secrets.
