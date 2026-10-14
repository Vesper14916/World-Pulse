# City labels

The original 126 curated city records are retained. Additional city/town records
come from Natural Earth 1:50m Populated Places (simple), excluding scientific
stations and entries within 0.18 degrees of an existing curated label. Population
is a historical cartographic estimate used for label priority, not current census data.

- [Dataset and selection notes](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-populated-places/)
- [Upstream GeoJSON](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_populated_places_simple.geojson), retrieved 2026-09-22.
- [Public domain terms](https://www.naturalearthdata.com/about/terms-of-use/)

Added records preserve source names and coordinates (rounded to five decimals).
Tier 1: population >= 6 million; tier 2: national capital or >= 1 million;
tier 3: other towns. Existing curated tiers remain unchanged.
Labels appear with zoom, are collision-filtered, and at most 160 are attached to
each map. This is a reference layer; it does not locate news events or claim to
include every city. Geographic names follow the source and may be dated.
