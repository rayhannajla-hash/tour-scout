// High-level tools the agent plans with. Each wraps one or two Qloo workflows and
// records every Qloo call as numbered evidence (E1, E2, ...) the final plan must cite.
import { callQloo } from "./qloo.mjs";
import { citiesFromHeatmap, findCity, cityLabel, orderRoute, routeLegs } from "./geo.mjs";

const nameOf = (r) => r?.name ?? r?.entity?.name ?? r?.properties?.name ?? null;
const idOf = (r) => r?.entity_id ?? r?.id ?? r?.entity?.entity_id ?? null;
const affinityOf = (r) => r?.query?.affinity ?? r?.affinity ?? r?.score ?? null;
const round = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x ?? null);

export class Session {
  constructor(emit) {
    this.emit = emit;
    this.evidence = [];
    this.cities = new Map(); // label -> city row from find_fan_cities
    this.ids = new Map(); // lower-cased artist name -> Qloo entity UUID
    this.headliner = null;
    this.plan = null;
  }

  // Names like "Big Thief" can match both an artist and a person in Qloo; once an
  // artist is resolved, later calls send its UUID so they never stop on ambiguity.
  remember(name, id) {
    if (name && id) this.ids.set(name.toLowerCase(), id);
  }

  idFor(name) {
    return this.ids.get(String(name).toLowerCase()) ?? name;
  }

  async qloo(tool, args, purpose) {
    const env = await callQloo(tool, args);
    const item = {
      id: `E${this.evidence.length + 1}`,
      tool, purpose, args,
      status: env.status,
      summary: env.summary ?? "",
      result_count: env.result_count ?? 0,
      sample: Boolean(env.sample),
      requests: env.provenance?.requests ?? [],
      error: env.error ?? null,
    };
    this.evidence.push(item);
    this.emit("evidence", item);
    return { env, ref: item.id };
  }
}

function qlooProblem(env, ref) {
  if (env.status === "error") {
    return { evidence: ref, status: "error", error: env.error?.code, retryable: env.error?.retryable ?? false,
      recovery: env.error?.recovery ?? env.summary };
  }
  if (env.status === "needs_input" || env.status === "empty") {
    return { evidence: ref, status: env.status, summary: env.summary, details: env.results };
  }
  return null;
}

const str = (v, max = 120) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const strArr = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max && v.every((s) => str(s));

export const TOOLS = [
  {
    name: "resolve_artist",
    description: "Resolve an artist or comedian name to its Qloo entity. Call this first. If the result is ambiguous, pick the candidate that matches the user's description and say which one you used.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Artist name as the user wrote it." } }, required: ["name"] },
    validate: (i) => str(i.name, 80),
    async run(s, { name }) {
      const { env, ref } = await s.qloo("qloo_describe", { entity: name, type: "artist" }, `Resolve "${name}"`);
      const problem = qlooProblem(env, ref);
      if (problem) return problem;
      const top = Array.isArray(env.results) ? env.results[0] : env.results;
      s.headliner = { name: nameOf(top) ?? name, id: idOf(top), popularity: round(top?.popularity) };
      s.remember(name, s.headliner.id);
      s.remember(s.headliner.name, s.headliner.id);
      return { evidence: ref, artist: { name: s.headliner.name, popularity: s.headliner.popularity },
        description: top?.properties?.short_description ?? top?.description ?? null, note: "Use this exact name in later tool calls." };
    },
  },
  {
    name: "find_fan_cities",
    description: "Find the cities inside a region where an artist's audience over-indexes, using Qloo's geographic affinity heatmap snapped to the nearest major city. `within` is a Qloo location such as a country or state (e.g. 'United States', 'Texas', 'United Kingdom'). Call again with another region to widen the search.",
    input_schema: {
      type: "object",
      properties: {
        artist: { type: "string" },
        within: { type: "string", description: "Country, state, or region name." },
      },
      required: ["artist", "within"],
    },
    validate: (i) => str(i.artist, 80) && str(i.within, 60),
    async run(s, { artist, within }) {
      const { env, ref } = await s.qloo("qloo_heatmap",
        { entity_id: s.idFor(artist), within }, `Where ${artist}'s audience over-indexes in ${within}`);
      const problem = qlooProblem(env, ref);
      if (problem) return problem;
      const cities = citiesFromHeatmap(env.results ?? []).slice(0, 12);
      for (const c of cities) s.cities.set(c.city, c);
      s.emit("cities", { within, cities, evidence: ref });
      return {
        evidence: ref,
        note: "affinity is query-relative (0-1), averaged over the Qloo heatmap cells around each city: how much more that metro over-indexes for the artist than the rest of the searched region. Scores from searches of different regions are not comparable, so compare cities using one search. It is not a ticket-sales forecast.",
        cities: cities.map((c) => ({ city: c.city, affinity: round(c.affinity), heatmap_cells: c.points, population: c.population })),
      };
    },
  },
  {
    name: "find_opener_candidates",
    description: "List artists whose audiences overlap with the headliner's, as opening-act candidates. Prefer candidates whose popularity is below the headliner's.",
    input_schema: {
      type: "object",
      properties: { headliner: { type: "string" }, count: { type: "integer", minimum: 3, maximum: 12 } },
      required: ["headliner"],
    },
    validate: (i) => str(i.headliner, 80),
    async run(s, { headliner, count = 8 }) {
      const { env, ref } = await s.qloo("qloo_recommend",
        { target_type: "artist", signals: [s.idFor(headliner)], limit: Math.min(12, Math.max(3, count)) }, `Artists that ${headliner}'s fans also like`);
      const problem = qlooProblem(env, ref);
      if (problem) return problem;
      const hp = s.headliner?.popularity;
      for (const r of env.results ?? []) s.remember(nameOf(r), idOf(r));
      const candidates = (env.results ?? []).map((r) => ({
        name: nameOf(r), affinity: round(affinityOf(r)), popularity: round(r?.popularity),
        smaller_than_headliner: typeof hp === "number" && typeof r?.popularity === "number" ? r.popularity < hp : null,
      })).filter((c) => c.name);
      return { evidence: ref, headliner_popularity: hp ?? null, candidates };
    },
  },
  {
    name: "rank_openers_for_city",
    description: "Rank opening-act candidates for one specific city, using the headliner as the taste signal and the city as the location signal. Scores are only comparable within one call.",
    input_schema: {
      type: "object",
      properties: {
        headliner: { type: "string" },
        candidates: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 },
        city: { type: "string", description: "City label as returned by find_fan_cities." },
      },
      required: ["headliner", "candidates", "city"],
    },
    validate: (i) => str(i.headliner, 80) && strArr(i.candidates, 2, 8) && str(i.city, 80),
    async run(s, { headliner, candidates, city }) {
      const { env, ref } = await s.qloo("qloo_rank",
        { options: candidates.map((c) => s.idFor(c)), option_type: "artist", signals: [s.idFor(headliner)], signal_location: city }, `Best opener for ${headliner} in ${city}`);
      const problem = qlooProblem(env, ref);
      if (problem) return problem;
      return { evidence: ref, city, ranking: (env.results ?? []).map((r) => ({ name: nameOf(r), affinity: round(affinityOf(r)) })) };
    },
  },
  {
    name: "check_momentum",
    description: "Check whether interest in up to five artists is rising or falling over the last few months (Qloo trends).",
    input_schema: {
      type: "object",
      properties: {
        artists: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        months: { type: "integer", minimum: 6, maximum: 12 },
      },
      required: ["artists"],
    },
    validate: (i) => strArr(i.artists, 1, 5),
    async run(s, { artists, months = 6 }) {
      const end = new Date();
      const start = new Date(end);
      // Windows shorter than about six months come back empty from the hackathon API.
      start.setMonth(start.getMonth() - Math.min(12, Math.max(6, months)));
      const iso = (d) => d.toISOString().slice(0, 10);
      const { env, ref } = await s.qloo("qloo_trends",
        { entities: artists.map((a) => s.idFor(a)), entity_type: "artist", start_date: iso(start), end_date: iso(end), limit: 20 }, `Momentum for ${artists.join(", ")}`);
      const problem = qlooProblem(env, ref);
      if (problem) return problem;
      // One entry per entity; points arrive newest first and are capped by `limit`.
      const trends = (env.series ?? []).map((r) => {
        const series = (r.points ?? [])
          .map((p) => ({ date: p.date, value: p.population_percentile }))
          .filter((p) => typeof p.value === "number")
          .sort((a, b) => a.date.localeCompare(b.date));
        const change = series.length > 1 ? round(series.at(-1).value - series[0].value) : null;
        const flat = series.length > 1 && series.every((p) => p.value === series[0].value);
        return { name: r.entity?.name ?? r.entity?.input ?? null, change, flat, series };
      });
      s.emit("trends", { trends, evidence: ref });
      const result = { evidence: ref, trends: trends.map(({ name, change, flat, series }) => ({ name, change, flat, points: series.length })) };
      if (trends.length && trends.every((t) => t.flat || !t.series.length)) {
        result.note = "Qloo shows no movement for these artists in this window. Do not claim rising or falling momentum; mention it as a caveat instead.";
      }
      return result;
    },
  },
  {
    name: "audience_snapshot",
    description: "Describe the headliner's audience: demographic skew and characteristic taste tags. Use it for the marketing angle, never to profile individuals.",
    input_schema: { type: "object", properties: { artist: { type: "string" } }, required: ["artist"] },
    validate: (i) => str(i.artist, 80),
    async run(s, { artist }) {
      const [demo, tags] = await Promise.all([
        s.qloo("qloo_audience_demographics", { entity: s.idFor(artist), entity_type: "artist" }, `Audience skew for ${artist}`),
        s.qloo("qloo_entity_tags", { entities: [s.idFor(artist)], entity_type: "artist", limit: 20 }, `Taste tags for ${artist}`),
      ]);
      // Tags span every domain; venue amenities (credit cards, dishes, hotel stars) say nothing about the audience.
      const tasteTags = (tags.env.results ?? [])
        .filter((t) => !/:(place|brand)$/.test(t.type ?? ""))
        .map(nameOf).filter(Boolean).slice(0, 8);
      return {
        demographics: qlooProblem(demo.env, demo.ref)
          ?? { evidence: demo.ref, note: "Values are skew vs. the average audience (-1..1), not shares.", skew: demo.env.results?.[0]?.query ?? null },
        tags: qlooProblem(tags.env, tags.ref) ?? { evidence: tags.ref, tags: tasteTags },
      };
    },
  },
  {
    name: "plan_route",
    description: "Order chosen cities into the shortest drivable route and return leg distances. Local computation, no Qloo call. Optionally pin the first and last city.",
    input_schema: {
      type: "object",
      properties: {
        cities: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 12 },
        start_city: { type: "string" },
        end_city: { type: "string" },
      },
      required: ["cities"],
    },
    validate: (i) => strArr(i.cities, 2, 12),
    async run(s, { cities, start_city, end_city }) {
      s.routeCalls = (s.routeCalls ?? 0) + 1;
      if (s.routeCalls > 3) return { status: "error", error: "ROUTE_LIMIT", recovery: "The route has been planned three times. Keep the last route and call submit_tour_plan." };
      const resolved = [];
      const unknown = [];
      for (const name of cities) {
        const known = s.cities.get(name);
        const c = known ?? findCity(name);
        if (!c) { unknown.push(name); continue; }
        resolved.push(known ?? { city: cityLabel(c), lat: c.lat, lon: c.lon, country: c.country, population: c.population });
      }
      if (unknown.length) return { status: "error", unknown_cities: unknown, recovery: "Use city labels exactly as find_fan_cities returned them." };
      const pick = (n) => (n ? resolved.find((c) => c.city === n || c.city.startsWith(`${n},`)) ?? null : null);
      const route = orderRoute(resolved, { start: pick(start_city), end: pick(end_city) });
      const legs = routeLegs(route);
      s.route = route;
      s.emit("route", { route, legs });
      return { route: route.map((c) => c.city), legs, total_km: legs.reduce((a, l) => a + l.km, 0) };
    },
  },
  {
    name: "submit_tour_plan",
    description: "Submit the final tour plan. Call exactly once, after plan_route. Every stop must cite the evidence IDs that justify it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string", description: "Two or three sentences for the artist's manager." },
        stops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              city: { type: "string" },
              why: { type: "string", description: "One sentence grounded in the evidence." },
              opener: { type: "string" },
              opener_reason: { type: "string" },
              evidence: { type: "array", items: { type: "string" } },
            },
            required: ["city", "why", "evidence"],
          },
        },
        marketing_angle: { type: "string" },
        caveats: { type: "array", items: { type: "string" } },
      },
      required: ["title", "summary", "stops", "caveats"],
    },
    validate: (i) => str(i.title, 140) && str(i.summary, 1200) && Array.isArray(i.stops) && i.stops.length >= 1
      && i.stops.every((st) => str(st.city) && str(st.why, 600) && Array.isArray(st.evidence)) && Array.isArray(i.caveats),
    async run(s, plan) {
      const known = new Set(s.evidence.map((e) => e.id));
      const bad = plan.stops.flatMap((st) => st.evidence.filter((e) => !known.has(e)));
      if (bad.length) return { status: "error", unknown_evidence: bad, recovery: "Cite only evidence IDs returned by earlier tools." };
      const coords = new Map((s.route ?? []).map((c) => [c.city, c]));
      // The sample-data warning is the app's job, not the model's: always first, always exact.
      const caveats = s.evidence.some((e) => e.sample)
        ? ["This plan used SAMPLE DATA generated locally, not live Qloo results.", ...plan.caveats.filter((c) => !/sample/i.test(c))]
        : plan.caveats;
      s.plan = {
        ...plan,
        caveats,
        stops: plan.stops.map((st) => ({ ...st, lat: coords.get(st.city)?.lat ?? null, lon: coords.get(st.city)?.lon ?? null })),
      };
      s.emit("plan", s.plan);
      return { status: "accepted" };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Definitions sent to Claude (strip the local-only fields).
export const TOOL_DEFS = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

export async function runTool(session, name, input) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { status: "error", error: `Unknown tool ${name}` };
  if (!tool.validate(input ?? {})) return { status: "error", error: "INVALID_INPUT", recovery: "Check required fields and types against the tool schema." };
  try {
    return await tool.run(session, input);
  } catch (err) {
    return { status: "error", error: "TOOL_FAILED", message: String(err?.message ?? err).slice(0, 300) };
  }
}
