# Notices and attribution

## World Monitor source

MundiTrace contains code derived from [World Monitor](https://github.com/koala73/worldmonitor). The upstream project identifies copyright © 2024–2026 Elie Habib; other contributors retain rights in their contributions. The upstream source and this derivative work are licensed under AGPL-3.0-only; see [LICENSE](LICENSE). This focused extraction has a new Git history and does not include the upstream repository history. MundiTrace is an independent extraction and is not presented as the upstream project's official release.

## Geographic data

The included country, city, land, and coastline data is derived from Natural Earth datasets. Natural Earth data is public domain. Source links, retrieval notes, and the MundiTrace simplification details are recorded in `public/data/cities.README.md` and `public/data/pulse-coastline-10m.README.md`.

## Runtime dependencies

| Package | License | Project use |
| --- | --- | --- |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | MIT | RSS and XML parsing |
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl) | BSD-3-Clause | Interactive map rendering |
| [ws](https://github.com/websockets/ws) | MIT | Optional maritime WebSocket connection |
| [Vite](https://github.com/vitejs/vite) | MIT | Local development and build tooling |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Type checking |
| [tsx](https://github.com/privatenumber/tsx) | MIT | TypeScript test execution |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Node.js type definitions |
| [@types/ws](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | WebSocket type definitions |

Indirect dependency notices are available in the npm package metadata and lockfile. This notice is informational and does not change the terms of the included license.
