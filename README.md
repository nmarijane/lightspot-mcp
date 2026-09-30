# @lightspot/mcp

MCP server for [LightSpot.ai](https://lightspot.ai) — run **SEO & GEO audits**, read their results and our experts' reports, and import editorial calendars from any MCP client (Claude Desktop, Claude Code, Cursor, …).

It wraps the LightSpot public API (`/v1`) as MCP tools, so an AI assistant can *"audit this site and tell me why ChatGPT doesn't cite it"* in one step.

## Requirements

- A LightSpot **API key** (`lspai_live_…`) — create one in **LightSpot → Integrations → API keys**. API access is included in the **Zenith** plan.
- Node.js ≥ 18 (run on demand via `npx`, nothing to install globally).

## Setup

Add the server to your MCP client config and set your API key:

```json
{
  "mcpServers": {
    "lightspot": {
      "command": "npx",
      "args": ["-y", "@lightspot/mcp"],
      "env": {
        "LIGHTSPOT_API_KEY": "lspai_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

- **Claude Desktop** → `claude_desktop_config.json`
- **Claude Code** → `claude mcp add` or your project's `.mcp.json`
- **Cursor** → `~/.cursor/mcp.json`

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LIGHTSPOT_API_KEY` | yes | Your API key (`lspai_live_…`). |
| `LIGHTSPOT_BASE_URL` | no | Override the API base URL (defaults to `https://lightspot.ai`). For self-hosted/testing only. |

## Tools

| Tool | What it does |
| --- | --- |
| `audit_and_wait` | Run an audit on a URL, wait for it to finish, and return a summary (score, top actions, main issues). The one-shot "audit this and tell me what's wrong." |
| `run_audit` | Start an audit without waiting (returns the audit id). |
| `get_audit_status` | Lightweight status of an audit (`PENDING`/`RUNNING`/`DONE`/`FAILED` + progress 0–1). |
| `get_audit` | Audit results — a trimmed summary by default, or the full payload with `full: true`. |
| `list_sites` | List the sites in your team (with their latest score). |
| `get_site` | A site's metadata and recent audits. |
| `list_site_audits` | A site's paginated audit history. |
| `get_competitors` | Get a site's latest competitor analysis (detected competitors, tiers, citations, recommendations). Read-only — does not trigger a new analysis. |
| `get_expert_report` | Read the latest report from our 8 experts (technical SEO, content, GEO, structured data, sitemaps, performance, visual, brand authority) for a site or a given audit: prioritized findings, recommended actions with steps, limitations and ready-to-apply artifacts. Summary by default, `full: true` for everything, `expert` to read one chapter. Read-only — does not trigger an analysis. |
| `get_editorial_calendar` | Read a site's calendar over an ISO date range, including imported slots and content already preparing, scheduled, or published. |
| `create_editorial_calendar` | Import or update up to 50 dated editorial slots. Idempotent with `externalId`; it does not generate or publish content. |

## Example prompts

- "Audit https://example.com and give me the top 3 things to fix for AI visibility."
- "List my LightSpot sites and which one has the lowest score."
- "Get the full results for audit `<id>` and group the issues by severity."
- "What competitors were detected for my site `<siteId>`, and what should I do about them?"
- "Read the experts' report for my site `<siteId>` and fix what the structured-data expert recommends in my codebase."
- "Create a four-week editorial calendar for my site `<siteId>` with two LinkedIn posts and one educational Reddit post per week, then import it into LightSpot."
- "Show me everything planned or published for site `<siteId>` between 2026-08-01T00:00:00+02:00 and 2026-09-01T00:00:00+02:00."

## Notes

- Quotas (audits/month, pages/audit) and per-key rate limits follow your LightSpot plan.
- Importing editorial slots does not consume AI credits and never generates, schedules, or publishes content automatically.
- The full REST API reference lives at [lightspot.ai/docs/api](https://lightspot.ai/docs/api).

## License

MIT
