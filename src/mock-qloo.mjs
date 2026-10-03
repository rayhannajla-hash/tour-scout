// Deterministic sample responses shaped like the harness envelope, for building the UI
// before the event key arrives. Every envelope says it is sample data.
import { findCity } from "./geo.mjs";

const SAMPLE_NOTE = "SAMPLE DATA: generated locally, not from Qloo.";

function seededRandom(seedText) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const TOUR_MARKETS = {
  "united states": ["New York City", "Los Angeles", "Chicago", "Austin", "Nashville", "Seattle", "Portland, Oregon",
    "Denver", "Atlanta", "Boston", "Philadelphia", "Minneapolis", "San Francisco", "Washington", "Detroit",
    "New Orleans", "Phoenix", "Salt Lake City", "Kansas City, Missouri", "Columbus, Ohio"],
  "united kingdom": ["London", "Manchester", "Glasgow", "Bristol", "Leeds", "Birmingham", "Brighton", "Liverpool", "Edinburgh"],
  europe: ["Berlin", "Amsterdam", "Paris", "Barcelona", "Copenhagen", "Hamburg", "Brussels", "Milan", "Vienna", "Prague", "Stockholm"],
  indonesia: ["Jakarta", "Bandung", "Surabaya", "Yogyakarta", "Denpasar", "Medan", "Malang", "Semarang"],
};

const envelope = (operation, extra) => ({
  schema_version: "1.0-preview.1", operation, warnings: [SAMPLE_NOTE], sample: true, ...extra,
});

const sampleArtists = (seed, n) => {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, (_, i) => ({
    entity_id: `sample-${seed.length}-${i}`,
    name: `Sample Artist ${String.fromCharCode(65 + i)}`,
    popularity: Math.round((0.35 + rnd() * 0.5) * 1000) / 1000,
    query: { affinity: Math.round((0.95 - i * 0.05 - rnd() * 0.03) * 1000) / 1000 },
  }));
};

export function mockQloo(tool, args) {
  switch (tool) {
    case "qloo_describe": {
      const rnd = seededRandom(args.entity.toLowerCase());
      return envelope("describe", {
        status: "ok",
        summary: `Resolved "${args.entity}" (sample).`,
        results: [{ entity_id: `sample-${args.entity.toLowerCase().replace(/\W+/g, "-")}`, name: args.entity,
          type: "urn:entity:artist", popularity: Math.round((0.9 + rnd() * 0.09) * 1000) / 1000 }],
        result_count: 1,
      });
    }
    case "qloo_where_popular": {
      const key = Object.keys(TOUR_MARKETS).find((k) => args.within.toLowerCase().includes(k)) ?? "united states";
      const rnd = seededRandom(`${args.entity}|${key}`);
      const points = TOUR_MARKETS[key]
        .map((name) => findCity(name))
        .filter(Boolean)
        .map((c) => ({
          location: { latitude: c.lat + (rnd() - 0.5) * 0.2, longitude: c.lon + (rnd() - 0.5) * 0.2 },
          query: { affinity: Math.round((0.4 + rnd() * 0.6) * 1000) / 1000, popularity: Math.round(rnd() * 1000) / 1000 },
        }))
        .sort((a, b) => b.query.affinity - a.query.affinity)
        .slice(0, args.limit ?? 20);
      return envelope("where_popular", {
        status: "ok", summary: `Heatmap for ${args.entity} within ${args.within} (sample).`,
        results: points, result_count: points.length,
      });
    }
    case "qloo_recommend": {
      const results = sampleArtists(`rec|${(args.signals ?? []).join(",")}`, args.limit ?? 8);
      return envelope("recommend", { status: "ok", summary: "Related artists (sample).", results, result_count: results.length });
    }
    case "qloo_rank": {
      const rnd = seededRandom(`rank|${args.signal_location}|${args.options.join(",")}`);
      const results = args.options
        .map((name) => ({ name, query: { affinity: Math.round(rnd() * 1000) / 1000 } }))
        .sort((a, b) => b.query.affinity - a.query.affinity);
      return envelope("rank", { status: "ok", summary: `Ranked for ${args.signal_location ?? "global"} (sample).`,
        results, result_count: results.length });
    }
    case "qloo_trends": {
      const results = args.entities.map((name) => {
        const rnd = seededRandom(`trend|${name}`);
        let v = 0.5 + rnd() * 0.2;
        const drift = (rnd() - 0.4) * 0.04;
        const series = Array.from({ length: 12 }, (_, i) => {
          v = Math.min(1, Math.max(0, v + drift + (rnd() - 0.5) * 0.03));
          const d = new Date(args.start_date);
          d.setDate(d.getDate() + i * 14);
          return { date: d.toISOString().slice(0, 10), population_percentile: Math.round(v * 1000) / 1000 };
        });
        return { name, series };
      });
      return envelope("trends", { status: "ok", summary: "Popularity over time (sample).", results, result_count: results.length });
    }
    case "qloo_audience_demographics":
      return envelope("audience_demographics", {
        status: "ok", summary: "Audience skew (sample).", result_count: 1,
        results: [{ age: { "24_and_younger": 0.31, "25_to_29": 0.22, "30_to_34": 0.12, "35_and_younger": -0.08, "36_to_55": -0.21, "55_and_older": -0.4 },
          gender: { male: -0.04, female: 0.05 } }],
      });
    case "qloo_entity_tags":
      return envelope("entity_tags", {
        status: "ok", summary: "Characteristic tags (sample).", result_count: 5,
        results: ["indie", "dream pop", "late-night", "college towns", "vinyl collectors"].map((name, i) => ({ name, query: { affinity: 0.9 - i * 0.1 } })),
      });
    default:
      return envelope(tool, { status: "error", summary: `No sample for ${tool}.`, results: [], result_count: 0,
        error: { code: "SAMPLE_UNSUPPORTED", layer: "sample", retryable: false, recovery: "Use live mode." } });
  }
}
