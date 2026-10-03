// HTTP server: static UI + POST /api/plan streaming agent events as server-sent events.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runAgent, agentMode, MODEL } from "./agent.mjs";
import { qlooMode } from "./qloo.mjs";
import { CITY_SOURCE } from "./geo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = Number(process.env.PORT || 8787);
const RUNS_PER_HOUR = Number(process.env.RUNS_PER_HOUR || 6);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const CACHE_MS = 6 * 60 * 60 * 1000;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const runsByIp = new Map(); // ip -> timestamps
const cache = new Map(); // request key -> { at, events }
let running = 0;

function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();
}

function allowRun(ip) {
  const now = Date.now();
  const recent = (runsByIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= RUNS_PER_HOUR) return false;
  recent.push(now);
  runsByIp.set(ip, recent);
  return true;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error("too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parsePlanRequest(body) {
  const j = JSON.parse(body);
  const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const artist = clean(j.artist, 80);
  const within = clean(j.within, 60) || "United States";
  const stops = Math.min(8, Math.max(3, Number.parseInt(j.stops, 10) || 5));
  const notes = clean(j.notes, 300);
  if (!artist) throw new Error("artist is required");
  return { artist, within, stops, notes };
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function handlePlan(req, res) {
  let plan;
  try {
    plan = parsePlanRequest(await readBody(req));
  } catch (err) {
    return json(res, 400, { error: String(err.message) });
  }

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const key = JSON.stringify([plan.artist.toLowerCase(), plan.within.toLowerCase(), plan.stops, plan.notes.toLowerCase()]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    send("cached", { at: new Date(hit.at).toISOString() });
    for (const [event, data] of hit.events) send(event, data);
    return res.end();
  }

  if (running >= MAX_CONCURRENT) {
    send("error", { message: "Tour Scout is busy planning other tours. Try again in a minute." });
    return res.end();
  }
  if (!allowRun(clientIp(req))) {
    send("error", { message: `Demo limit reached (${RUNS_PER_HOUR} new plans per hour). Cached plans still load instantly.` });
    return res.end();
  }

  running += 1;
  const events = [];
  let closed = false;
  res.on("close", () => { closed = true; });
  const emit = (event, data) => {
    events.push([event, data]);
    if (!closed) send(event, data);
  };
  try {
    await runAgent(plan, emit);
    cache.set(key, { at: Date.now(), events });
  } catch (err) {
    console.error("plan failed:", err);
    if (!closed) send("error", { message: String(err?.message ?? err).slice(0, 300) });
  } finally {
    running -= 1;
    res.end();
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: "not found" });
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/plan") return handlePlan(req, res);
  if (req.method === "GET" && req.url === "/api/health") {
    return json(res, 200, { qloo: qlooMode, agent: agentMode, model: MODEL, cities: CITY_SOURCE });
  }
  if (req.method === "GET") return serveStatic(req, res);
  json(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Tour Scout on http://localhost:${PORT} (qloo: ${qlooMode}, agent: ${agentMode}${MODEL ? `, model: ${MODEL}` : ""})`);
});
