---
name: ai-visibility-audit
description: Audit a website's SEO and AI search visibility with LightSpot (ChatGPT, Perplexity, Gemini, Google AI Overviews) and explain what to fix first. Use when the user asks why AI assistants don't cite their site, wants an SEO or AI visibility audit of a URL, or asks for a prioritized fix list for a website.
---

# Audit a website's AI visibility with LightSpot

Use the LightSpot MCP tools to audit a site and turn the result into a short, prioritized plan.

## Run the audit

1. Get the URL to audit. If the user named a site without a URL, ask for it.
2. Call `audit_and_wait` with the URL. Only pass `maxPages` if the user asked for a deeper crawl.
3. If the result has `status: "still_running"`, follow it with `get_audit_status`, then fetch the result with `get_audit` and the returned `auditId`.

An audit consumes the user's LightSpot audit quota, and a site can be audited once per day. Run one audit per request, and ask before auditing several sites.

## Present the result

- Start with the overall score out of 100 and what it means in one sentence.
- List the top actions first, in plain language, each with why it matters for being cited by AI assistants.
- Group the remaining issues by impact. Don't show internal criterion identifiers.
- Answer in the user's language.

## Go further on a site the user manages in LightSpot

- `list_sites` and `get_site` find the site and its recent audits; `list_site_audits` shows the score history.
- `get_expert_report` returns the prioritized findings and ready-to-apply artifacts from LightSpot's experts. Use `full: true` only when the user wants the details.
- `get_competitors` shows which competitors AI assistants cite instead. It reads the latest analysis and never starts a new one.
- `create_editorial_calendar` writes planned content slots to the site's calendar. Call it only after the user has confirmed the exact slots.
