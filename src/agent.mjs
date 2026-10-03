// The planning agent. With ANTHROPIC_API_KEY it is a Claude tool-use loop; without one it
// runs a fixed playbook over the same tools so the app stays demoable offline.
import Anthropic from "@anthropic-ai/sdk";
import { Session, TOOL_DEFS, runTool } from "./tools.mjs";
import { distanceKm } from "./geo.mjs";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const EFFORT = process.env.CLAUDE_EFFORT || "medium";
const MAX_TURNS = 16;
export const agentMode = process.env.ANTHROPIC_API_KEY ? "claude" : "scripted";

const SYSTEM = `You are Tour Scout, a tour-routing agent for independent musicians and comedians and the managers who book them.

Your edge over a generic assistant is Qloo's taste graph: real, aggregate evidence about where an artist's audience over-indexes, which acts share that audience, and whether interest is rising. Build every recommendation from that evidence.

How to work:
- Resolve the artist first. Then find fan cities in the requested region; if the region is large or the results cluster tightly, search a second region or a state to get geographic spread.
- Choose stops that balance audience affinity against routing: avoid two stops within roughly 150 km of each other unless the user asks for it, and prefer a route a van can drive.
- Get opener candidates once, then rank them per city so each stop gets the opener its local audience is most likely to share. Prefer openers smaller than the headliner.
- Check momentum for the headliner and the openers you pick, and take an audience snapshot for the marketing angle.
- Order the stops with plan_route, then call submit_tour_plan exactly once.

Ground rules:
- Cite evidence IDs (E1, E2, ...) for every stop. Never invent numbers, venues, ticket counts, or dates; affinity is relative interest, not a sales forecast.
- If a Qloo call errors or comes back empty, adapt (another region, fewer stops) and say what you could not establish in caveats.
- If any evidence is marked as sample data, say so in the first caveat.
- Keep the user-facing text plain and specific. Between tool calls, a short sentence about what you are checking is enough.`;

function userBrief({ artist, within, stops, notes }) {
  return [
    `Plan a ${stops}-stop tour for ${artist} in ${within}.`,
    notes ? `Notes from the user: ${notes}` : null,
  ].filter(Boolean).join("\n");
}

async function claudeLoop(req, s) {
  const client = new Anthropic();
  const messages = [{ role: "user", content: userBrief(req) }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools: TOOL_DEFS,
      messages,
    });
    usage.input_tokens += response.usage.input_tokens ?? 0;
    usage.output_tokens += response.usage.output_tokens ?? 0;
    usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      throw new Error("The model declined this request.");
    }
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) s.emit("note", { text: block.text.trim() });
    }
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason === "max_tokens" && toolUses.length) {
      throw new Error("The model ran out of output tokens mid tool call.");
    }
    if (response.stop_reason === "end_turn" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results = await Promise.all(toolUses.map(async (tu) => {
      s.emit("step", { id: tu.id, tool: tu.name, input: tu.input });
      const out = await runTool(s, tu.name, tu.input);
      s.emit("step_done", { id: tu.id, ok: out?.status !== "error" });
      return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out), ...(out?.status === "error" ? { is_error: true } : {}) };
    }));
    messages.push({ role: "user", content: results });
    if (s.plan) break; // plan accepted; no need to pay for a closing remark
  }
  return usage;
}

// Offline playbook: same tools, fixed order, template wording.
async function scriptedRun(req, s) {
  const step = async (tool, input) => {
    const id = `script-${tool}-${Math.random().toString(36).slice(2, 8)}`;
    s.emit("step", { id, tool, input });
    const out = await runTool(s, tool, input);
    s.emit("step_done", { id, ok: out?.status !== "error" });
    return out;
  };

  s.emit("note", { text: `Resolving ${req.artist} and mapping where the audience over-indexes in ${req.within}.` });
  const artist = await step("resolve_artist", { name: req.artist });
  if (artist.status) throw new Error(`Could not resolve the artist (${artist.status}).`);
  const fans = await step("find_fan_cities", { artist: req.artist, within: req.within });
  if (!fans.cities?.length) throw new Error("No fan-city evidence came back for that region.");

  const chosen = [];
  for (const c of fans.cities) {
    const row = s.cities.get(c.city);
    if (chosen.every((k) => distanceKm(k, row) > 150)) chosen.push(row);
    if (chosen.length === req.stops) break;
  }

  s.emit("note", { text: "Finding acts that share the audience, then ranking them city by city." });
  const openers = await step("find_opener_candidates", { headliner: req.artist, count: 8 });
  const pool = (openers.candidates ?? []).filter((c) => c.smaller_than_headliner !== false).slice(0, 4).map((c) => c.name);
  const perCity = new Map();
  if (pool.length >= 2) {
    const ranked = await Promise.all(chosen.map((c) => step("rank_openers_for_city", { headliner: req.artist, candidates: pool, city: c.city })));
    chosen.forEach((c, i) => perCity.set(c.city, ranked[i]));
  }

  await step("check_momentum", { artists: [req.artist, ...pool.slice(0, 2)] });
  await step("audience_snapshot", { artist: req.artist });
  const route = await step("plan_route", { cities: chosen.map((c) => c.city) });

  const fanRef = fans.evidence;
  const sample = s.evidence.some((e) => e.sample);
  await step("submit_tour_plan", {
    title: `${req.artist}: ${route.route.length}-stop run through ${req.within}`,
    summary: `Stops are the ${req.within} cities where ${req.artist}'s audience over-indexes most, spaced at least 150 km apart and ordered into a ${route.total_km} km drive. Each stop pairs the opener Qloo ranks highest for that city's audience.`,
    stops: route.route.map((city) => {
      const r = perCity.get(city);
      const top = r?.ranking?.[0];
      const c = s.cities.get(city);
      return {
        city,
        why: `Affinity ${c?.affinity ?? "n/a"} for ${req.artist} in this market.`,
        opener: top?.name,
        opener_reason: top ? "Highest-ranked shared-audience act for this city." : undefined,
        evidence: [fanRef, r?.evidence].filter(Boolean),
      };
    }),
    marketing_angle: "Lead with the audience's strongest taste tags in local promotion.",
    caveats: [
      ...(sample ? ["This run used SAMPLE DATA, not live Qloo results."] : []),
      "Scripted mode: no language model reviewed these choices.",
      "Affinity measures relative interest, not ticket demand; confirm venue capacity and dates separately.",
    ],
  });
  return null;
}

export async function runAgent(req, emit) {
  const s = new Session(emit);
  emit("start", { mode: agentMode, model: agentMode === "claude" ? MODEL : null });
  const usage = agentMode === "claude" ? await claudeLoop(req, s) : await scriptedRun(req, s);
  if (!s.plan) throw new Error("The agent finished without a plan.");
  emit("done", { evidence_count: s.evidence.length, usage });
  return s;
}
