// Tour Scout front end: streams agent events from /api/plan and renders them.
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}

const TOOL_LABELS = {
  resolve_artist: "Resolve artist",
  find_fan_cities: "Find fan cities",
  find_opener_candidates: "Find opener candidates",
  rank_openers_for_city: "Rank openers for city",
  check_momentum: "Check momentum",
  audience_snapshot: "Audience snapshot",
  plan_route: "Plan route",
  submit_tour_plan: "Submit plan",
};

function inputSummary(tool, input) {
  if (tool === "rank_openers_for_city") return input.city;
  if (tool === "find_fan_cities") return `${input.artist} · ${input.within}`;
  if (tool === "plan_route") return (input.cities ?? []).join(" · ");
  if (tool === "check_momentum") return (input.artists ?? []).join(", ");
  if (tool === "submit_tour_plan") return input.title;
  return input.name ?? input.artist ?? input.headliner ?? "";
}

// ---------- map ----------
const map = L.map("map", { scrollWheelZoom: false, worldCopyJump: true }).setView([39, -96], 4);
// Standard OSM tiles (no key); style.css mutes them and inverts them in dark mode.
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 12,
}).addTo(map);
const fanLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawFanCities(cities) {
  for (const c of cities) {
    L.circleMarker([c.lat, c.lon], {
      radius: 5 + 14 * (c.affinity ?? 0.3), color: css("--fan"), weight: 1, fillOpacity: 0.35,
    }).bindTooltip(`${c.city} · affinity ${c.affinity ?? "n/a"}`).addTo(fanLayer);
  }
  const pts = [...fanLayer.getLayers()].map((l) => l.getLatLng());
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15));
}

function drawRoute(route) {
  routeLayer.clearLayers();
  const latlngs = route.map((c) => [c.lat, c.lon]);
  L.polyline(latlngs, { color: css("--accent"), weight: 3, dashArray: "6 6" }).addTo(routeLayer);
  route.forEach((c, i) => {
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: "", html: `<div class="stop-pin">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      title: c.city,
    }).addTo(routeLayer);
  });
  if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.25));
}

// ---------- state + rendering ----------
let state;
function reset() {
  state = { steps: new Map(), evidence: [], trends: [], legs: [], plan: null, request: null };
  $("#steps").replaceChildren();
  $("#compare-out").replaceChildren();
  $("#compare-go").disabled = false;
  $("#evidence").replaceChildren();
  $("#ev-count").textContent = "";
  $("#plan").hidden = true;
  fanLayer.clearLayers();
  routeLayer.clearLayers();
}

function addNote(text, cls = "note") {
  $("#steps").append(el("li", { class: cls }, text));
}

function addStep({ id, tool, input }) {
  const li = el("li", { class: "run" },
    el("span", { class: "icon", "aria-hidden": "true" }),
    el("div", {}, el("strong", {}, TOOL_LABELS[tool] ?? tool), " ", el("code", {}, inputSummary(tool, input ?? {}))));
  state.steps.set(id, li);
  $("#steps").append(li);
}

function finishStep({ id, ok }) {
  const li = state.steps.get(id);
  if (li) li.className = ok ? "ok" : "fail";
}

function addEvidence(e) {
  state.evidence.push(e);
  const req = e.requests?.[0];
  const li = el("li", { id: `ev-${e.id}` },
    el("span", { class: "ev-id" }, e.id),
    e.purpose,
    e.sample ? el("span", { class: "ev-tag" }, "sample") : null,
    e.status === "error" ? el("span", { class: "ev-tag err" }, e.error?.code ?? "error") : null,
    el("div", { class: "ev-meta" }, `${e.tool} · ${e.status} · ${e.result_count} results${req ? ` · ${req.method} ${req.path}` : ""}`));
  $("#evidence").append(li);
  $("#ev-count").textContent = `(${state.evidence.length})`;
}

function flashEvidence(id) {
  const li = document.getElementById(`ev-${id}`);
  if (!li) return;
  li.scrollIntoView({ behavior: "smooth", block: "center" });
  li.classList.add("flash");
  setTimeout(() => li.classList.remove("flash"), 1600);
}

function sparkline(series) {
  const w = 90, h = 24;
  const vals = series.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", pts);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", css("--accent"));
  line.setAttribute("stroke-width", "2");
  svg.append(line);
  return svg;
}

function renderTrends() {
  const box = $("#trends");
  box.replaceChildren();
  if (!state.trends.length) { box.append(el("p", { class: "hint" }, "No momentum data.")); return; }
  for (const t of state.trends) {
    const pct = typeof t.change === "number" ? Math.round(t.change * 100) : null;
    box.append(el("div", { class: "trend" },
      el("span", { class: "name", title: t.name ?? "" }, t.name ?? "?"),
      t.series?.length > 1 ? sparkline(t.series) : el("span"),
      el("span", { class: `delta ${pct > 0 ? "up" : pct < 0 ? "down" : ""}` },
        t.flat ? "flat" : pct === null ? "n/a" : `${pct > 0 ? "+" : ""}${pct} pts`)));
  }
}

function renderPlan(plan) {
  state.plan = plan;
  $("#plan-title").textContent = plan.title;
  $("#plan-summary").textContent = plan.summary;
  const list = $("#stops-list");
  list.replaceChildren();
  plan.stops.forEach((s, i) => {
    const leg = state.legs[i];
    list.append(el("li", { class: "stop" },
      el("span", { class: "num" }, String(i + 1)),
      el("div", {},
        el("h4", {}, s.city),
        el("p", {}, s.why),
        s.opener ? el("div", { class: "opener" }, "Opener:", el("b", {}, s.opener), s.opener_reason ? el("span", { class: "ev-meta" }, `— ${s.opener_reason}`) : null) : null,
        el("div", { class: "cites" }, (s.evidence ?? []).map((id) => el("button", { type: "button", class: "cite", onclick: () => flashEvidence(id) }, id)))),
      leg ? el("div", { class: "leg" }, `↓ ${leg.km} km · ~${leg.drive_hours} h drive to ${leg.to}`) : null));
  });
  $("#angle").textContent = plan.marketing_angle ?? "";
  $("#caveats").replaceChildren(...(plan.caveats ?? []).map((c) => el("li", {}, c)));
  renderTrends();
  $("#plan").hidden = false;
  if (plan.stops.every((s) => s.lat !== null)) drawRoute(plan.stops.map((s) => ({ city: s.city, lat: s.lat, lon: s.lon })));
}

// ---------- versus a generic LLM ----------
const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v ?? 0)) * 100)}%`;
const bar = (v) => el("span", { class: "bar", "aria-hidden": "true" }, el("span", { style: `width:${pct(v)}` }));

function compareCity(s, topN) {
  const sc = s.score ?? {};
  const label = sc.rank === null || sc.rank === undefined
    ? (sc.matched ? "no fan signal" : "city not found")
    : `#${sc.rank}`;
  const cls = sc.rank == null ? "miss" : sc.rank <= topN ? "top" : "";
  return el("li", { class: "cmp-row" },
    el("span", {}, s.city),
    el("span", { class: `rank ${cls}`, title: sc.metro ? `Qloo metro: ${sc.metro} · affinity ${sc.affinity.toFixed(3)}` : null }, label),
    bar(sc.affinity),
    s.why ? el("span", { class: "cmp-why" }, s.why) : null);
}

function renderCompare(r) {
  const stat = (cls, who, side) => el("div", { class: `cmp-stat ${cls}` },
    el("div", { class: "who" }, who),
    el("div", { class: "big" }, `${side.in_top}/${side.stops.length}`),
    el("div", { class: "lbl" }, `stops in Qloo's top ${r.top_n} fan metros · median rank #${side.median_rank} of ${r.ranked_metros}`));
  const opener = (o) => el("li", { class: "cmp-row" },
    el("span", {}, o.name,
      ...o.from.map((f) => el("span", { class: "chip" }, f === "llm" ? "LLM" : "Tour Scout")),
      o.bigger_than_headliner ? el("span", { class: "ev-tag" }, "bigger than headliner") : null),
    el("span", { class: `rank ${o.affinity === null ? "miss" : ""}` },
      o.affinity === null ? (o.resolved ? "no overlap signal" : "not in Qloo") : o.affinity.toFixed(3)),
    bar(o.affinity));
  const missed = (side) => el("p", { class: "cmp-why" }, "Qloo top-10 metros not on this route: ",
    side.missed_top10.length ? side.missed_top10.map((m) => `${m.city.split(",")[0]} (#${m.rank})`).join(", ") : "none");
  const calls = r.qloo_calls.length;
  $("#compare-out").replaceChildren(...[
    r.sample ? el("p", { class: "hint" }, "Scored against SAMPLE DATA, not live Qloo results.") : null,
    el("div", { class: "cmp-stats" }, stat("", "Generic LLM, no Qloo", r.llm), stat("ours", "Tour Scout", r.scout)),
    el("div", { class: "grid2" },
      el("div", {}, el("h3", {}, "Generic LLM stops"), el("ol", { class: "cmp-list" }, r.llm.stops.map((s) => compareCity(s, r.top_n))), missed(r.llm)),
      el("div", {}, el("h3", {}, "Tour Scout stops"), el("ol", { class: "cmp-list" }, r.scout.stops.map((s) => compareCity(s, r.top_n))), missed(r.scout))),
    el("div", {},
      el("h3", {}, "Openers: audience overlap with the headliner"),
      el("ol", { class: "cmp-list" }, r.openers.map(opener))),
    el("details", {},
      el("summary", {}, "How this was scored"),
      el("p", {}, `Generic answer from ${r.model}, same request, no tools. Rank = position of the stop's metro among ${r.ranked_metros} metros in ${r.artist}'s Qloo heatmap for ${r.within} (${r.heatmap_cells} cells, mean affinity per metro). Opener scores come from one Qloo rank call over every opener with the headliner as the signal, so they are comparable. ${calls} Qloo calls in total.`),
      el("p", {}, `Prompt: “${r.prompt}”`),
      r.cached_at ? el("p", {}, `Cached result from ${new Date(r.cached_at).toLocaleString()}.`) : null),
  ].filter(Boolean));
}

async function runCompare() {
  const btn = $("#compare-go");
  if (!state.plan || !state.request) return;
  btn.disabled = true;
  btn.textContent = "Comparing… about a minute";
  $("#compare-out").replaceChildren();
  try {
    const res = await fetch("/api/compare", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...state.request, scout: state.plan.stops.map((s) => ({ city: s.city, opener: s.opener ?? null })) }),
    });
    const r = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok || r.error) throw new Error(r.error ?? "Comparison failed");
    renderCompare(r);
  } catch (err) {
    $("#compare-out").replaceChildren(el("p", { class: "error" }, String(err.message ?? err)));
    btn.disabled = false;
  } finally {
    btn.textContent = "Run comparison";
  }
}

function planAsText() {
  const p = state.plan;
  if (!p) return "";
  const lines = [`# ${p.title}`, "", p.summary, ""];
  p.stops.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.city}: ${s.why}${s.opener ? ` Opener: ${s.opener}.` : ""} [${(s.evidence ?? []).join(", ")}]`);
    if (state.legs[i]) lines.push(`   -> ${state.legs[i].km} km to ${state.legs[i].to}`);
  });
  if (p.marketing_angle) lines.push("", `Marketing angle: ${p.marketing_angle}`);
  lines.push("", "Caveats:", ...(p.caveats ?? []).map((c) => `- ${c}`));
  lines.push("", "Evidence:", ...state.evidence.map((e) => `${e.id} ${e.purpose} (${e.tool}, ${e.status}${e.sample ? ", sample" : ""})`));
  return lines.join("\n");
}

// ---------- streaming ----------
const handlers = {
  start: (d) => addNote(d.model ? `Agent: ${d.model}` : "Agent: scripted playbook (no language model key configured)"),
  cached: (d) => addNote(`Loaded a cached plan from ${new Date(d.at).toLocaleString()}.`),
  note: (d) => addNote(d.text),
  step: addStep,
  step_done: finishStep,
  evidence: addEvidence,
  cities: (d) => drawFanCities(d.cities),
  trends: (d) => { state.trends.push(...d.trends); },
  route: (d) => { state.legs = d.legs; drawRoute(d.route); },
  plan: renderPlan,
  done: (d) => addNote(`Done · ${d.evidence_count} Qloo calls cited.`),
  error: (d) => addNote(d.message, "note error"),
};

async function scout(payload) {
  reset();
  state.request = payload;
  const res = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    addNote(err.error ?? "Request failed", "note error");
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (event && data && handlers[event]) handlers[event](JSON.parse(data));
    }
  }
}

// ---------- boot ----------
const form = $("#scout");
form.stops.addEventListener("input", () => { $("#stops-out").textContent = form.stops.value; });
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("#go");
  btn.disabled = true;
  btn.textContent = "Scouting…";
  const payload = Object.fromEntries(new FormData(form));
  // Shareable link: the current request lives in the URL.
  history.replaceState(null, "", `?${new URLSearchParams(payload)}`);
  try {
    await scout(payload);
  } catch (err) {
    addNote(String(err), "note error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Scout the tour";
  }
});
$("#compare-go").addEventListener("click", runCompare);
$("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(planAsText());
    $("#copy").textContent = "Copied";
  } catch {
    $("#copy").textContent = "Copy failed";
  }
  setTimeout(() => { $("#copy").textContent = "Copy plan"; }, 1500);
});

const params = new URLSearchParams(location.search);
if (params.get("artist")) {
  for (const k of ["artist", "within", "stops", "notes"]) if (params.has(k)) form[k].value = params.get(k);
  $("#stops-out").textContent = form.stops.value;
  form.requestSubmit();
}

fetch("/api/health").then((r) => r.json()).then((h) => {
  $("#modes").replaceChildren(
    el("span", { class: `badge ${h.qloo === "live" ? "live" : "sample"}` }, h.qloo === "live" ? "Qloo: live" : "Qloo: sample data"),
    el("span", { class: "badge" }, h.model ? `Agent: ${h.model}` : "Agent: scripted"));
  $("#sample-banner").hidden = h.qloo === "live";
}).catch(() => {});
