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

// Every call returns the harness envelope: { status, summary, results, result_count, error?, provenance? }.
export async function callQloo(tool, args) {
  if (qlooMode === "sample") return mockQloo(tool, args);
  const client = await liveClient();
  return parseEnvelope(await client.callTool({ name: tool, arguments: args }));
}
