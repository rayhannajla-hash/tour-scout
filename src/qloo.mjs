// Qloo access through the official harness MCP server (`qloo mcp`, stdio).
// Without QLOO_API_KEY the app runs on clearly-labelled sample data instead.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mockQloo } from "./mock-qloo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const QLOO_BIN = path.join(here, "..", "node_modules", ".bin", "qloo");

export const qlooMode = process.env.QLOO_API_KEY ? "live" : "sample";

let clientPromise = null;

async function liveClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Hackathon keys only work against the hackathon API host.
      const env = {
        QLOO_BASE_URL: "https://hackathon.api.qloo.com",
        QLOO_TRUSTED_BASE_URL: "https://hackathon.api.qloo.com",
        ...process.env,
      };
      const transport = new StdioClientTransport({ command: QLOO_BIN, args: ["mcp"], env });
      const client = new Client({ name: "tour-scout", version: "0.1.0" });
      await client.connect(transport);
      transport.onclose = () => { clientPromise = null; };
      return client;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

function parseEnvelope(result) {
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (result?.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return { status: "error", summary: text ?? "Unreadable Qloo response", results: [], result_count: 0,
      error: { code: "UNPARSEABLE", retryable: false, recovery: "Check the harness version." } };
  }
}

// The harness's qloo_where_popular keeps only the top 20 heatmap cells, and for smaller
// artists those are sparse rural cells where a handful of fans saturates affinity. The
// Insights API returns the whole heatmap in one response, so the backend asks for it
// directly (key stays server-side) and geo.mjs averages the cells around each city.
async function fullHeatmap({ entity_id, within }) {
  const base = process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
  const query = { "filter.type": "urn:heatmap", "signal.interests.entities": entity_id, "filter.location.query": within };
  const request = { method: "GET", path: "/v2/insights", query };
  const fail = (code, summary, retryable = false) => ({ operation: "heatmap", status: "error", summary, results: [], result_count: 0,
    error: { code, retryable, recovery: summary }, provenance: { requests: [request] } });
  if (!/^[0-9A-F-]{36}$/i.test(entity_id ?? "")) return fail("NEEDS_ENTITY_ID", "Resolve the artist first; the heatmap needs its Qloo ID.");
  let res;
  try {
    res = await fetch(`${base}/v2/insights?${new URLSearchParams(query)}`, {
      headers: { "X-Api-Key": process.env.QLOO_API_KEY }, signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return fail("NETWORK", `Qloo heatmap request failed: ${err.message}`, true);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) return fail(`HTTP_${res.status}`, body?.errors?.[0]?.message ?? `Qloo returned ${res.status}.`, res.status === 429 || res.status >= 500);
  const results = body?.results?.heatmap ?? [];
  return { operation: "heatmap", status: results.length ? "ok" : "empty", summary: `${results.length} heatmap cells within ${within}.`,
    results, result_count: results.length, provenance: { requests: [request] } };
}

// The hackathon key answers bursts with 429, and the agent fans out one rank call per
// city, so live calls queue for one of two slots and rate-limited calls retry after a pause.
const MAX_IN_FLIGHT = 2;
const RETRY_DELAYS_MS = [3000, 8000];
let inFlight = 0;
const waiting = [];

async function acquire() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight += 1; return; }
  await new Promise((resolve) => waiting.push(resolve)); // slot handed over by release()
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
}

const rateLimited = (env) => env.status === "error" && ["QLOO_RATE_LIMIT", "HTTP_429"].includes(env.error?.code);

async function liveCall(tool, args) {
  if (tool === "qloo_heatmap") return fullHeatmap(args);
  const client = await liveClient();
  return parseEnvelope(await client.callTool({ name: tool, arguments: args }));
}

// Every call returns the harness envelope: { status, summary, results, result_count, error?, provenance? }.
export async function callQloo(tool, args) {
  if (qlooMode === "sample") return mockQloo(tool, args);
  await acquire();
  try {
    let env = await liveCall(tool, args);
    for (const delay of RETRY_DELAYS_MS) {
      if (!rateLimited(env)) break;
      await new Promise((r) => setTimeout(r, delay));
      env = await liveCall(tool, args);
    }
    return env;
  } finally {
    release();
  }
}
