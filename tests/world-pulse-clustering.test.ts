import assert from "node:assert/strict";
import test from "node:test";
import type {
  PulseCategory,
  PulseEvent,
  PulseSource,
} from "../shared/world-pulse";
import {
  analyzePulseTitle,
  clusteringDecision,
  clusterPulseEvents,
} from "../server/world-pulse/clustering";

const baseTime = Date.parse("2026-09-20T12:00:00.000Z");

function event(
  id: string,
  title: string,
  options: {
    category?: PulseCategory;
    hours?: number;
    source?: Partial<PulseSource>;
    magnitude?: number;
    filing?: PulseEvent["filing"];
  } = {},
): PulseEvent {
  const publishedAt = new Date(
    baseTime + (options.hours ?? 0) * 3_600_000,
  ).toISOString();
  const source: PulseSource = {
    id: options.source?.id ?? `source-${id}`,
    name: options.source?.name ?? `Publisher ${id}`,
    publisher: options.source?.publisher ?? `Publisher ${id}`,
    url: options.source?.url ?? `https://example.com/${id}`,
    feedId: options.source?.feedId,
  };
  return {
    id,
    title,
    summary: `Summary ${id}`,
    category: options.category ?? "Technology",
    sources: [source],
    reports: [
      {
        id: `report-${id}`,
        title,
        summary: `Summary ${id}`,
        source,
        publishedAt,
        firstSeenAt: publishedAt,
      },
    ],
    publishedAt,
    fetchedAt: publishedAt,
    classificationBasis: "Test fixture.",
    magnitude: options.magnitude,
    filing: options.filing,
  };
}

test("bilingual reports cluster with explicit entity, action, theme and location evidence", () => {
  const english = event(
    "english",
    "China restricts exports of advanced artificial intelligence chips under new controls",
    { source: { publisher: "Reuters", name: "Reuters" } },
  );
  const chinese = event("chinese", "中国宣布限制先进人工智能芯片出口", {
    hours: 2,
    source: { publisher: "新华社", name: "新华社" },
  });
  const decision = clusteringDecision(english, chinese);
  assert.equal(decision.eligible, true);
  if (!decision.eligible) return;
  assert.equal(decision.evidence.matchedBy, "action-theme-location");
  assert.ok(
    decision.evidence.sharedEntities.some((entity) => entity.id === "china"),
  );
  assert.deepEqual(decision.evidence.sharedActions, ["restrict"]);
  assert.ok(decision.evidence.sharedThemes.includes("chips"));
  assert.deepEqual(decision.evidence.sharedLocations, ["country:china"]);

  const [cluster] = clusterPulseEvents([chinese, english]);
  assert.equal(cluster!.evidence.clustered, true);
  assert.deepEqual(cluster!.evidence.memberEventIds, ["english", "chinese"]);
  assert.equal(cluster!.event.reports!.length, 2);
  assert.deepEqual(
    new Set(cluster!.event.sources.map((source) => source.publisher)),
    new Set(["Reuters", "新华社"]),
  );
});

test("similar same-language headlines cluster at the title threshold with a strong entity", () => {
  const left = event(
    "a",
    "Federal Reserve cuts interest rates after September policy meeting",
    {
      category: "Economy",
    },
  );
  const right = event(
    "b",
    "Federal Reserve cuts interest rates following September policy meeting",
    {
      category: "Economy",
      hours: 1,
    },
  );
  const decision = clusteringDecision(left, right);
  assert.equal(decision.eligible, true);
  if (decision.eligible) {
    assert.equal(decision.evidence.matchedBy, "title-similarity");
    assert.ok(decision.evidence.titleSimilarity >= 0.45);
  }
});

test("same broad theme without a shared reviewed entity never clusters", () => {
  const left = event(
    "a",
    "Artificial intelligence investment accelerates across software sector",
  );
  const right = event(
    "b",
    "Artificial intelligence investment accelerates across chip sector",
    {
      hours: 1,
    },
  );
  assert.deepEqual(clusteringDecision(left, right), {
    eligible: false,
    reason: "no-strong-shared-entity",
  });
});

test("category and 24-hour boundaries are enforced", () => {
  const title = "NVIDIA announces new artificial intelligence chip platform";
  assert.equal(
    clusteringDecision(
      event("a", title),
      event("b", title, { category: "Economy" }),
    ).eligible,
    false,
  );
  assert.deepEqual(
    clusteringDecision(event("a", title), event("b", title, { hours: 25 })),
    {
      eligible: false,
      reason: "outside-24h-window",
    },
  );
});

test("distinct USGS events remain separate even with identical titles", () => {
  const source = (id: string): Partial<PulseSource> => ({
    id: "usgs",
    feedId: "usgs",
    publisher: "USGS",
    name: "USGS",
    url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
  });
  const left = event("us-a", "Japan earthquake magnitude 6", {
    category: "Disasters",
    magnitude: 6,
    source: source("us-a"),
  });
  const right = event("us-b", "Japan earthquake magnitude 6", {
    category: "Disasters",
    magnitude: 6,
    source: source("us-b"),
  });
  assert.deepEqual(clusteringDecision(left, right), {
    eligible: false,
    reason: "distinct-usgs-events",
  });
});

test("SEC filings require matching issuer, accession and filing date", () => {
  const filing = (cik: string, accession: string): PulseEvent["filing"] => ({
    form: "8-K",
    cik,
    accession,
    metadataOnly: true,
  });
  const left = event("sec-a", "NVIDIA files 8-K", {
    category: "Economy",
    filing: filing("1045810", "0001045810-26-000001"),
  });
  const right = event("sec-b", "NVIDIA files 8-K", {
    category: "Economy",
    filing: filing("1045810", "0001045810-26-000002"),
  });
  assert.deepEqual(clusteringDecision(left, right), {
    eligible: false,
    reason: "incompatible-sec-filings",
  });
  assert.deepEqual(
    clusteringDecision(
      left,
      event("news", "NVIDIA files 8-K", { category: "Economy" }),
    ),
    {
      eligible: false,
      reason: "filing-versus-news",
    },
  );
});

test("explicitly conflicting countries, companies, numbers and directions do not cluster", () => {
  const cases: [PulseEvent, PulseEvent, string][] = [
    [
      event("country-a", "China announces artificial intelligence regulation"),
      event("country-b", "France announces artificial intelligence regulation"),
      "conflicting-countries",
    ],
    [
      event("company-a", "NVIDIA announces new artificial intelligence chips"),
      event("company-b", "Tesla announces new artificial intelligence chips"),
      "conflicting-companies",
    ],
    [
      event("number-a", "China earthquake kills 10 people", {
        category: "Disasters",
      }),
      event("number-b", "China earthquake kills 20 people", {
        category: "Disasters",
      }),
      "conflicting-numbers",
    ],
    [
      event(
        "policy-a",
        "Federal Reserve raises interest rates after policy meeting",
        {
          category: "Economy",
        },
      ),
      event(
        "policy-b",
        "Federal Reserve cuts interest rates after policy meeting",
        {
          category: "Economy",
        },
      ),
      "conflicting-policy-direction",
    ],
  ];
  for (const [left, right, reason] of cases)
    assert.deepEqual(clusteringDecision(left, right), {
      eligible: false,
      reason,
    });
});

test("complete-link clustering blocks a transitive bridge and output is stable", () => {
  const first = event(
    "a",
    "China restricts NVIDIA artificial intelligence chip exports",
  );
  const bridge = event(
    "b",
    "China restricts NVIDIA and Tesla artificial intelligence chip exports",
    {
      hours: 1,
    },
  );
  const last = event(
    "c",
    "China restricts Tesla artificial intelligence chip exports",
    { hours: 2 },
  );
  const forward = clusterPulseEvents([first, bridge, last]);
  const reverse = clusterPulseEvents([last, bridge, first]);
  assert.deepEqual(
    forward.map((cluster) => cluster.evidence.memberEventIds),
    reverse.map((cluster) => cluster.evidence.memberEventIds),
  );
  assert.equal(forward.length, 2);
  assert.equal(
    forward.reduce(
      (total, cluster) => total + cluster.event.reports!.length,
      0,
    ),
    3,
  );
});

test("reviewed title analysis is bilingual and ignores ambiguous bare Apple", () => {
  const chinese = analyzePulseTitle("中国限制英伟达人工智能芯片出口");
  assert.ok(chinese.countries.has("china"));
  assert.ok(chinese.companies.has("nvidia"));
  assert.ok(chinese.themes.has("artificial-intelligence"));
  assert.equal(
    analyzePulseTitle("Apple harvest rises in France").companies.has("apple"),
    false,
  );
  assert.equal(
    analyzePulseTitle("Apple Inc announces a product").companies.has("apple"),
    true,
  );
  assert.equal(
    analyzePulseTitle("Analysts who tell us why markets moved").countries.has(
      "united-states",
    ),
    false,
  );
  assert.equal(
    analyzePulseTitle("US announces new export controls").countries.has(
      "united-states",
    ),
    true,
  );
});
