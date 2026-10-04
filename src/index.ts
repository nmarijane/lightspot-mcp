#!/usr/bin/env node
// LightSpot.ai MCP server (stdio). Exposes the LightSpot SEO/GEO audit API as
// MCP tools so any MCP client (Claude, Cursor, …) can run audits, read
// results, and import an editorial plan. Auth: set LIGHTSPOT_API_KEY
// (lspai_live_…) in the server config. The tools themselves live in tools.ts,
// shared with the remote connector.
//
//   {
//     "mcpServers": {
//       "lightspot": {
//         "command": "npx",
//         "args": ["-y", "@lightspot/mcp"],
//         "env": { "LIGHTSPOT_API_KEY": "lspai_live_…" }
//       }
//     }
//   }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LightSpotClient } from "./client.ts";
import { registerLightspotTools } from "./tools.ts";

const API_KEY = process.env.LIGHTSPOT_API_KEY;
const BASE_URL = process.env.LIGHTSPOT_BASE_URL;

const client = API_KEY ? new LightSpotClient(API_KEY, BASE_URL, "api-key") : null;

const server = new McpServer({ name: "lightspot", version: "0.6.0" });
registerLightspotTools(
  server,
  () => {
    if (!client) {
      throw new Error(
        "LIGHTSPOT_API_KEY is not set. Create a key in LightSpot → Integrations → API keys (Eclat and Zenith plans).",
      );
    }
    return client;
  },
  { mode: "api-key", auditWaitTimeoutMs: 180_000 },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP JSON-RPC channel.
  console.error(
    `LightSpot MCP prêt (${client ? "clé configurée" : "⚠️ LIGHTSPOT_API_KEY manquante"}) → ${client?.base ?? "https://lightspot.ai"}`,
  );
}

main().catch((e) => {
  console.error("LightSpot MCP — erreur fatale:", e instanceof Error ? e.message : e);
  process.exit(1);
});
