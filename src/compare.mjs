// "Versus a generic LLM": the same request goes to the same model with no tools and no
// Qloo, then both plans are scored against the same Qloo evidence. Cities are placed in
// the artist's heatmap ranking for the region; all openers are ranked in one Qloo call so
// their audience-overlap scores are comparable.
import { geminiGenerate } from "./agent.mjs";
import { callQloo } from "./qloo.mjs";
import { citiesFromHeatmap, findCity, cityLabel, distanceKm } from "./geo.mjs";
import { ACTS } from "./tools.mjs";

const BASELINE_SCHEMA = {
  type: "object",
  properties: {
    stops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          city: { type: "string", description: "City and full state or country name, e.g. 'Austin, Texas'." },
          why: { type: "string", description: "One sentence." },
          // Without "name only", comedian runs came back as MC intros ("Please welcome to the
          // stage, ... Nate Craig!"), which can't be looked up in Qloo and read as rigged.
          opener: { type: "string", description: "The opener's name only, exactly as the act is billed, e.g. 'Jane Doe'. No other words." },
        },
        required: ["city", "why", "opener"],
      },
    },
  },
  required: ["stops"],
};

async function askGenericLlm({ artist, within, stops, notes, act }) {
  const prompt = [
    `Plan a ${stops}-stop tour for ${artist} (${act.noun}) in ${within}. Choose the cities where ${artist}'s audience is strongest, keep the route drivable, and suggest one ${act.opener} per stop.`,
    notes ? `Notes from the user: ${notes}` : null,
  ].filter(Boolean).join("\n");
  const { response, model } = await geminiGenerate(
    [{ role: "user", parts: [{ text: prompt }] }],
    { responseMimeType: "application/json", responseJsonSchema: BASELINE_SCHEMA },
  );
  const text = response.candidates?.[0]?.content?.parts?.filter((p) => p.text && !p.thought).map((p) => p.text).join("") ?? "";
  const parsed = JSON.parse(text);
  return { model, prompt, stops: (parsed.stops ?? []).slice(0, stops) };
}

// LLM answers say "New York, NY" or "St. Louis"; GeoNames says "New York City" and "Saint Louis".
function matchCity(text) {
  const tries = [text];
  const [cityPart, ...rest] = text.split(",").map((t) => t.trim());
  const region = rest.join(", ");
  const city = cityPart.replace(/^st\.?\s+/i, "Saint ").replace(/^ft\.?\s+/i, "Fort ");
  if (/^new york$/i.test(city)) tries.push(`New York City${region ? `, ${region}` : ""}`);
  if (/^washington$/i.test(city) && /d\.?\s?c\.?|district/i.test(region || "dc")) tries.push("Washington, District of Columbia");
  tries.push(region ? `${city}, ${region}` : city, city);
  for (const t of tries) {
    const c = findCity(t);
    if (c) return c;
  }
  return null;
}

// Heatmap ranking rows are metros named after their biggest city, so place a city by the
// ranked metro within 40 km of it.
function placeCity(name, ranking) {
  const c = matchCity(name);
  if (!c) return { city: name, rank: null, affinity: null, matched: false };
  let best = null;
  ranking.forEach((r, i) => {
    const d = distanceKm(c, r);
    if (d <= 40 && (!best || d < best.d)) best = { r, i, d };
  });
  return best
    ? { city: cityLabel(c), rank: best.i + 1, affinity: best.r.affinity, metro: best.r.city, matched: true }
    : { city: cityLabel(c), rank: null, affinity: null, matched: true };
}

const idOf = (env) => (env.status === "ok" ? env.results?.[0]?.entity_id ?? null : null);

export async function compareWithGenericLlm({ artist, within, stops, notes, scout, act: actKey }) {
  const act = ACTS[actKey] ?? ACTS.musician;
  const calls = [];
  const qloo = async (tool, args) => {
    const env = await callQloo(tool, args);
    calls.push({ tool, status: env.status, result_count: env.result_count ?? 0, sample: Boolean(env.sample),
      request: env.provenance?.requests?.[0] ?? null });
    return env;
  };

  const [baseline, head] = await Promise.all([
    askGenericLlm({ artist, within, stops, notes, act }),
    qloo("qloo_describe", { entity: artist, type: act.type }),
  ]);
  const headliner = head.results?.[0];
  const headId = idOf(head);
  if (!headId) throw new Error(`Qloo could not resolve "${artist}".`);
  if (typeof headliner?.popularity !== "number") throw new Error(`Qloo has no audience data for ${artist} yet.`);

  const heat = await qloo("qloo_heatmap", { entity_id: headId, within });
  if (heat.status !== "ok") throw new Error(`No Qloo heatmap for ${artist} in ${within}.`);
  const ranking = citiesFromHeatmap(heat.results ?? []);
  const topN = Math.min(20, Math.max(5, Math.ceil(ranking.length / 4)));

  // One rank call over every opener from both plans, headliner as the taste signal.
  const named = new Map(); // lower-cased name -> { name, from: Set }
  const addOpener = (name, from) => {
    if (typeof name !== "string" || !name.trim()) return;
    const key = name.trim().toLowerCase();
    const row = named.get(key) ?? { name: name.trim(), from: new Set() };
    row.from.add(from);
    named.set(key, row);
  };
  baseline.stops.forEach((s) => addOpener(s.opener, "llm"));
  scout.forEach((s) => addOpener(s.opener, "scout"));
  const openers = [...named.values()].slice(0, 10);
  const resolved = await Promise.all(openers.map((o) => qloo("qloo_describe", { entity: o.name, type: act.type })));
  openers.forEach((o, i) => {
    o.id = idOf(resolved[i]);
    o.popularity = resolved[i].results?.[0]?.popularity ?? null;
  });
  const ids = openers.filter((o) => o.id).map((o) => o.id);
  const affinityById = new Map();
  if (ids.length) {
    const ranked = await qloo("qloo_rank", { options: ids, option_type: act.type, signals: [headId] });
    for (const r of ranked.status === "ok" ? ranked.results ?? [] : []) affinityById.set(r.entity_id, r.affinity ?? r.query?.affinity ?? null);
  }

  const score = (list) => {
    const placed = list.map((s) => placeCity(s.city, ranking));
    // A known city with no measurable fan metro counts as ranked last; a city outside the
    // city list (towns under 100k) cannot be placed at all, so it stays out of the median.
    const ranks = placed.filter((p) => p.matched).map((p) => p.rank ?? ranking.length + 1).sort((a, b) => a - b);
    const mid = Math.floor(ranks.length / 2);
    const median = !ranks.length ? null : ranks.length % 2 ? ranks[mid] : Math.round((ranks[mid - 1] + ranks[mid]) / 2);
    const picked = new Set(placed.map((p) => p.rank).filter((r) => r !== null));
    const missed = ranking.slice(0, 10).map((r, i) => ({ city: r.city, rank: i + 1 })).filter((m) => !picked.has(m.rank));
    return { placed, inTop: placed.filter((p) => p.rank !== null && p.rank <= topN).length, median, missed,
      unplaced: placed.filter((p) => !p.matched).length };
  };
  const llm = score(baseline.stops);
  const ours = score(scout);

  return {
    artist,
    within,
    model: baseline.model,
    prompt: baseline.prompt,
    ranked_metros: ranking.length,
    heatmap_cells: heat.result_count,
    top_n: topN,
    llm: { in_top: llm.inTop, median_rank: llm.median, unplaced: llm.unplaced, missed_top10: llm.missed, stops: baseline.stops.map((s, i) => ({ ...s, score: llm.placed[i] })) },
    scout: { in_top: ours.inTop, median_rank: ours.median, unplaced: ours.unplaced, missed_top10: ours.missed, stops: scout.map((s, i) => ({ ...s, score: ours.placed[i] })) },
    openers: openers.map((o) => ({
      name: o.name,
      from: [...o.from],
      resolved: Boolean(o.id),
      affinity: o.id ? affinityById.get(o.id) ?? null : null,
      bigger_than_headliner: typeof o.popularity === "number" && typeof headliner?.popularity === "number"
        ? o.popularity > headliner.popularity : null,
    })).sort((a, b) => (b.affinity ?? -1) - (a.affinity ?? -1)),
    qloo_calls: calls,
    sample: calls.some((c) => c.sample),
  };
}
