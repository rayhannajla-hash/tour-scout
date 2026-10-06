// The planning agent: a tool-use loop on Gemini (GEMINI_API_KEY) or Claude (ANTHROPIC_API_KEY).
// With neither key it runs a fixed playbook over the same tools so the app stays demoable.
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, ApiError } from "@google/genai";
import { Session, TOOL_DEFS, runTool, ACTS } from "./tools.mjs";
import { distanceKm } from "./geo.mjs";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "medium";
// Tried in order; a model that is unavailable or out of free quota falls through to the next.
const GEMINI_MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
const MAX_TURNS = 20;
const NUDGE_AT = MAX_TURNS - 4;
const BUDGET_NUDGE = "Step budget nearly used. Stop exploring: run plan_route if the route is not final, then call submit_tour_plan with what you have and note any gaps in caveats.";

export const agentMode = process.env.LLM_PROVIDER
  || (process.env.GEMINI_API_KEY ? "gemini" : process.env.ANTHROPIC_API_KEY ? "claude" : "scripted");
export const MODEL = agentMode === "gemini" ? GEMINI_MODELS[0] : agentMode === "claude" ? CLAUDE_MODEL : null;

const SYSTEM = `You are Tour Scout, a tour-routing agent for independent musicians and comedians and the managers who book them.

Your edge over a generic assistant is Qloo's taste graph: real, aggregate evidence about where an artist's audience over-indexes, which acts share that audience, and whether interest is rising. Build every recommendation from that evidence.

How to work:
- Resolve the artist first, then search the requested region for fan cities. That search is the main ranking: build the route from its top-ranked metros and always include #1 unless the user's notes rule it out (a plan without it is sent back). A smaller top-ranked metro beats a bigger lower-ranked one: discovering those markets is the point. Search a smaller region only to fill a gap in the route, and never compare its ranks or scores with the main search.
- Choose stops that balance audience rank against routing: avoid two stops within roughly 150 km of each other unless the user asks for it, and prefer a route a van can drive. When the top metros cluster, take the strongest one in the cluster and move on to the next-ranked metro outside it.
- Get opener candidates once, then rank them per city so each stop gets the opener its local audience is most likely to share. Never book an opener bigger than the headliner: use the ranking's pick, and where a city has no pick, use a candidate from find_opener_candidates that is smaller than the headliner. The opener field takes one act name exactly as Qloo returned it, never a description; leave it empty if no act fits. The same opener on several stops is normal for a support slot.
- Check momentum for the headliner and the openers you pick, and take an audience snapshot for the marketing angle.
- Calls that do not depend on each other (ranking openers for every stop, momentum, the audience snapshot) go out together in one turn.
- Decide the stops yourself from the fan-city evidence, then call plan_route once (a second time only if you change the stop list), then call submit_tour_plan exactly once.

Comedians:
- The brief says whether the headliner is a musician or a stand-up comedian. The tools already query the matching kind of Qloo entity. For a comedian, the opener is an opening comic, and the same comic usually opens the whole run.

Ground rules:
- Cite evidence IDs (E1, E2, ...) for every stop. Never invent numbers, venues, ticket counts, or dates; affinity is relative interest, not a sales forecast.
- If a Qloo call errors or comes back empty, adapt (another region, fewer stops) and say what you could not establish in caveats.
- Keep the user-facing text plain and specific. Between tool calls, a short sentence about what you are checking is enough.`;

function userBrief({ artist, within, stops, notes, act }) {
  return [
    `Plan a ${stops}-stop tour for ${artist} (${(ACTS[act] ?? ACTS.musician).noun}) in ${within}.`,
    notes ? `Notes from the user: ${notes}` : null,
  ].filter(Boolean).join("\n");
}

async function executeCalls(s, calls) {
  return Promise.all(calls.map(async ({ id, name, input }) => {
    s.emit("step", { id, tool: name, input });
    const out = await runTool(s, name, input);
    s.emit("step_done", { id, ok: out?.status !== "error" });
    return out;
  }));
}

let geminiClient = null;
let geminiModelIdx = 0; // sticks to the first model that worked

const agentConfig = () => ({
  systemInstruction: SYSTEM,
  tools: [{ functionDeclarations: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }],
});

// Shared with compare.mjs, which calls the same models with no tools and no Qloo.
export async function geminiGenerate(contents, config = agentConfig()) {
  geminiClient ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  for (let i = geminiModelIdx; i < GEMINI_MODELS.length; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await geminiClient.models.generateContent({ model: GEMINI_MODELS[i], contents, config });
        geminiModelIdx = i;
        return { response, model: GEMINI_MODELS[i] };
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 503 && attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (err.status === 404 || err.status === 429 || err.status === 503) break; // try the next model
        console.error("gemini error:", err);
        throw new Error(err.status === 400 || err.status === 401 || err.status === 403
          ? "The language model rejected the server's API key." : `Language model request failed (${err.status}).`);
      }
    }
  }
  throw new Error("All configured Gemini models are unavailable or out of free quota right now.");
}

async function geminiLoop(req, s) {
  const contents = [{ role: "user", parts: [{ text: userBrief(req) }] }];
  const usage = { input_tokens: 0, output_tokens: 0, models: new Set() };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { response, model } = await geminiGenerate(contents);
    usage.models.add(model);
    usage.input_tokens += response.usageMetadata?.promptTokenCount ?? 0;
    usage.output_tokens += response.usageMetadata?.candidatesTokenCount ?? 0;

    const candidate = response.candidates?.[0];
    if (!candidate?.content) throw new Error(`Gemini returned no content (${candidate?.finishReason ?? "no candidate"}).`);
    for (const part of candidate.content.parts ?? []) {
      if (part.text && !part.thought && part.text.trim()) s.emit("note", { text: part.text.trim() });
    }
    const calls = response.functionCalls ?? [];
    if (calls.length === 0) break;

    // Push the model turn back unchanged so Gemini 3 thought signatures are preserved.
    contents.push(candidate.content);
    const outs = await executeCalls(s, calls.map((c, i) => ({ id: c.id ?? `g${turn}-${i}`, name: c.name, input: c.args ?? {} })));
    contents.push({
      role: "user",
      parts: [
        ...calls.map((c, i) => ({
          functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: outs[i]?.status === "error" ? { error: outs[i] } : { output: outs[i] } },
        })),
        ...(turn === NUDGE_AT && !s.plan ? [{ text: BUDGET_NUDGE }] : []),
      ],
    });
    if (s.plan) break;
  }
  return { ...usage, models: [...usage.models] };
}

async function claudeLoop(req, s) {
  const client = new Anthropic();
  const messages = [{ role: "user", content: userBrief(req) }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: CLAUDE_EFFORT },
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
    const outs = await executeCalls(s, toolUses.map((tu) => ({ id: tu.id, name: tu.name, input: tu.input })));
    messages.push({
      role: "user",
      content: [
        ...toolUses.map((tu, i) => ({
          type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(outs[i]), ...(outs[i]?.status === "error" ? { is_error: true } : {}),
        })),
        ...(turn === NUDGE_AT && !s.plan ? [{ type: "text", text: BUDGET_NUDGE }] : []),
      ],
    });
    if (s.plan) break; // plan accepted; no need to pay for a closing remark
  }
  return usage;
}

// Offline playbook: same tools, fixed order, template wording.
async function scriptedRun(req, s) {
  const step = async (tool, input) => {
    const [out] = await executeCalls(s, [{ id: `script-${tool}-${Math.random().toString(36).slice(2, 8)}`, name: tool, input }]);
    return out;
  };

  s.emit("note", { text: `Resolving ${req.artist} and mapping where the audience over-indexes in ${req.within}.` });
  const artist = await step("resolve_artist", { name: req.artist });
  if (artist.status) throw new Error(artist.error === "NO_AUDIENCE_DATA"
    ? `Qloo has no audience data for ${req.artist} yet, so Tour Scout cannot plan this tour.`
    : `Could not resolve ${req.artist} (${artist.status}).`);
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
  // Smaller acts first; top up with the rest so Qloo has a real choice to rank.
  const pool = [...(openers.candidates ?? [])]
    .sort((a, b) => (a.smaller_than_headliner === false) - (b.smaller_than_headliner === false))
    .slice(0, 4).map((c) => c.name);
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
    summary: `Stops are the ${req.within} cities where ${req.artist}'s audience over-indexes most, spaced at least 150 km apart and ordered into a ${route.total_km} km drive. Each stop pairs the highest-ranked opener for that city's audience that is not bigger than ${req.artist}.`,
    stops: route.route.map((city) => {
      const r = perCity.get(city);
      const top = r?.pick ?? null;
      const c = s.cities.get(city);
      return {
        city,
        why: `Affinity ${typeof c?.affinity === "number" ? c.affinity.toFixed(3) : "n/a"} for ${req.artist} in this market.`,
        opener: top ?? undefined,
        opener_reason: top ? "Highest-ranked shared-audience act for this city that is not bigger than the headliner." : undefined,
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
  s.region = req.within;
  s.act = ACTS[req.act] ?? ACTS.musician;
  emit("start", { mode: agentMode, model: MODEL });
  const loop = { gemini: geminiLoop, claude: claudeLoop }[agentMode] ?? scriptedRun;
  const usage = await loop(req, s);
  if (!s.plan) {
    throw new Error(s.noAudienceData
      ? `Qloo has no audience data for ${req.artist} yet, so Tour Scout cannot plan this tour.`
      : "The agent finished without a plan.");
  }
  emit("done", { evidence_count: s.evidence.length, usage });
  return s;
}
