# LightSpot for Claude

Audit any website for SEO and AI search visibility from Claude. LightSpot checks 46 criteria that decide whether ChatGPT, Perplexity, Gemini and Google AI Overviews can find, understand and cite a page, then returns a score out of 100 and a prioritized list of fixes.

Ask Claude things like:

- "Audit example.com and tell me why ChatGPT doesn't cite it"
- "What should I fix first on my homepage?"
- "Which competitors do AI assistants cite instead of my site?"

## Requirements

- A LightSpot account with an active **Eclat**, **Halo** or **Zenith** subscription. First-time subscribers start with a 14-day free trial
- Nothing to install and no API key to copy: the first time Claude uses the plugin, run `/mcp`, choose `lightspot` and **Authenticate**, then sign in to LightSpot in your browser and approve access

## What the plugin contains

- **A connection to LightSpot's hosted MCP server** at `https://mcp.lightspot.ai/mcp`, secured with OAuth. Nothing runs on your computer
- **A skill**, `ai-visibility-audit`, that tells Claude how to run an audit and present the result as a prioritized plan

## Tools

| Tool | Effect |
| --- | --- |
| `audit_and_wait` | Starts an audit of a URL and waits for the result (1 to 3 minutes). Uses one audit from your quota |
| `run_audit` | Starts an audit without waiting. Uses one audit from your quota |
| `get_audit_status`, `get_audit` | Read an audit's progress and results |
| `list_sites`, `get_site`, `list_site_audits` | Read your LightSpot sites and their audit history |
| `get_competitors` | Reads the latest competitor analysis of a site (Halo or Zenith plan) |
| `get_expert_report` | Reads the latest report from LightSpot's experts |
| `get_editorial_calendar` | Reads a site's editorial calendar |
| `create_editorial_calendar` | Writes up to 50 planned content slots to a site's calendar. Re-importing a slot with the same `externalId` replaces it |

Every tool declares whether it only reads or also writes, so Claude can ask before a tool changes anything.

## What it sends

- The plugin downloads and runs nothing on your computer
- Sign-in happens on `https://lightspot.ai` in your browser. Claude stores the resulting access token and can be disconnected at any time from `/mcp`
- Each tool call sends an HTTPS request to `https://mcp.lightspot.ai/mcp`, authenticated with that token
- When you run an audit, LightSpot's crawler fetches the URL you gave, and pages of the same site, with the user agent `LightSpot-Bot/1.0 (+https://lightspot.ai/bot)`
- The plugin sends nothing to any other destination

## Privacy Policy

The data you send through this plugin (audited URLs, site identifiers and editorial slots) is processed by LightSpot as described in its privacy policy: [https://lightspot.ai/en/privacy](https://lightspot.ai/en/privacy). It covers what is collected, how it is used and stored, third-party sharing, retention and how to contact us.

## Support

- Documentation: [https://lightspot.ai/en/docs/api](https://lightspot.ai/en/docs/api)
- Help: [https://lightspot.ai/en/support](https://lightspot.ai/en/support) or contact@lightspot.ai

## License

MIT. See [LICENSE](LICENSE).
