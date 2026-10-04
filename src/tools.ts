// LightSpot.ai MCP tools, registered once and shared by the npm stdio server
// (mcp/src/index.ts, API-key auth) and the remote HTTPS connector (app/mcp,
// OAuth). Both pass a McpServer, a client factory and their own options.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LightSpotError,
  type ApiAuditFull,
  type ApiCompetitorRun,
  type ApiExpertReport,
  type LightSpotClient,
} from "./client.ts";

/** Noms des outils enregistrés (la parité avec registerLightspotTools est testée). */
export const LIGHTSPOT_TOOL_NAMES = [
  "audit_and_wait", "run_audit", "get_audit_status", "get_audit", "list_sites", "get_site",
  "list_site_audits", "get_competitors", "get_expert_report", "get_editorial_calendar", "create_editorial_calendar",
] as const;

export type ToolsOptions = { mode: "api-key" | "oauth"; auditWaitTimeoutMs: number };

/** Base poll interval of audit_and_wait: two parallel calls stay under 30 requests/minute. */
export const AUDIT_POLL_INTERVAL_MS = 5_000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof LightSpotError) {
      const retry = e.retryAfter ? ` Retry in ${e.retryAfter}s.` : "";
      return fail(`${e.message} (code: ${e.code}).${retry}`);
    }
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Trim a full audit into an LLM-friendly summary (keeps the actionable parts). */
function summarize(a: ApiAuditFull) {
  return {
    id: a.id,
    url: a.url,
    status: a.status,
    score: a.score, // { global, seo, geo, grade }
    detectedStack: a.detectedStack,
    pagesAudited: a.pages.length,
    issueCount: a.issues.length,
    topActions: a.topActions,
    topIssues: a.issues.slice(0, 10).map((i) => ({
      id: i.id,
      label: i.label,
      severity: i.severity,
      affectedPages: i.affectedPages,
      fix: i.fix ?? null,
    })),
    topKeywords: a.keywords.slice(0, 10),
    shareToken: a.shareToken,
  };
}

/** Trim a competitor run into an LLM-friendly summary. */
function summarizeCompetitors(r: ApiCompetitorRun) {
  return {
    status: r.status,
    runId: r.runId,
    completedAt: r.completedAt,
    competitors: r.competitors, // already sorted by descending citationCount by the API
    topActions: r.recommendations?.actions.slice(0, 5) ?? [],
  };
}

const EXPERT_KEYS = [
  "seo-technical",
  "seo-content",
  "seo-geo",
  "seo-schema",
  "seo-sitemap",
  "seo-performance",
  "seo-visual",
  "brand-authority",
] as const;

const EXPERT_REPORT_HINTS: Partial<Record<ApiExpertReport["status"], string>> = {
  NONE: "No expert analysis exists for this site (or this audit). It starts after an audit from the LightSpot app or via audit_and_wait, depending on the plan.",
  PENDING: "The expert analysis is queued. Try again in a few minutes.",
  RUNNING:
    "The expert analysis is running (allow ~5 minutes). Try again in a few minutes; progress shows the experts already finished.",
  FAILED: "The expert analysis failed: no chapter completed.",
  CANCELLED: "The expert analysis was cancelled.",
};

/** Trim an expert report into an LLM-friendly summary (findings + actions, no artifacts/evidence). */
function summarizeExpertReport(r: ApiExpertReport) {
  return {
    status: r.status,
    id: r.id,
    auditId: r.auditId,
    completedAt: r.completedAt,
    progress: r.progress,
    experts: r.experts.map((chapter) => ({
      expert: chapter.expert,
      status: chapter.status,
      errorCode: chapter.errorCode,
      title: chapter.report?.title ?? null,
      summary: chapter.report?.summary ?? null,
      findings:
        chapter.report?.findings.map((f) => ({ title: f.title, priority: f.priority, detail: f.detail })) ?? [],
      actions: chapter.report?.actions.map((a) => ({ title: a.title, effort: a.effort, steps: a.steps })) ?? [],
      artifactCount: chapter.report?.artifacts.length ?? 0,
    })),
  };
}

/**
 * Poll an audit until DONE/FAILED or the timeout. A 429 does not fail the
 * call: wait the API's retryAfter (at least the base interval), then retry.
 */
async function pollAudit(
  c: LightSpotClient,
  id: string,
  timeoutMs: number,
): Promise<{ kind: "done"; audit: ApiAuditFull } | { kind: "timeout"; lastStatus: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "PENDING";
  while (Date.now() < deadline) {
    let wait = AUDIT_POLL_INTERVAL_MS;
    try {
      const s = await c.getAuditStatus(id);
      lastStatus = s.status;
      if (s.status === "DONE" || s.status === "FAILED") {
        return { kind: "done", audit: await c.getAudit(id) };
      }
    } catch (e) {
      if (e instanceof LightSpotError && e.status === 429) {
        wait = Math.max(AUDIT_POLL_INTERVAL_MS, (e.retryAfter ?? 0) * 1000);
      } else {
        throw e;
      }
    }
    // Never sleep past the budget: the caller must get still_running in time.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(wait, remaining));
  }
  return { kind: "timeout", lastStatus };
}

// Tool annotations (title + readOnlyHint/destructiveHint): required by the
// Claude connectors directory, and read by MCP clients to decide when to ask
// for confirmation. Read-only = no side effect; audits write (they consume
// quota) and reach out to the web (openWorld); the calendar import is
// idempotent but overwrites an existing slot with the same externalId
// (destructive).
export function registerLightspotTools(
  server: McpServer,
  getClient: () => LightSpotClient,
  opts: ToolsOptions,
): void {
  server.registerTool(
    "audit_and_wait",
    {
      title: "Audit a URL and wait for the result",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Runs a LightSpot SEO and AI-visibility audit on a URL, waits for it to finish, and returns a summary (score, top actions, main issues). " +
        'Ideal for "audit this site and tell me what to fix". Can take 1 to 3 minutes; past the time limit, it returns the id so you can follow up with get_audit_status / get_audit.',
      inputSchema: {
        url: z.string().url().describe("URL to audit (home page or a specific page)."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Number of pages to crawl (capped by your plan)."),
      },
    },
    async ({ url, maxPages }) =>
      run(async () => {
        const c = getClient();
        const created = await c.createAudit({ url, maxPages });
        let res: Awaited<ReturnType<typeof pollAudit>>;
        try {
          res = await pollAudit(c, created.id, opts.auditWaitTimeoutMs);
        } catch (e) {
          // Keep the audit id so the user can resume with get_audit_status.
          const hint = `The audit is still running: use get_audit_status with auditId ${created.id}.`;
          if (e instanceof LightSpotError) {
            throw new LightSpotError(`Polling failed (${e.message}). ${hint}`, e.code, e.status, e.retryAfter);
          }
          throw new Error(`Polling failed (${e instanceof Error ? e.message : String(e)}). ${hint}`);
        }
        if (res.kind === "timeout") {
          return {
            status: "still_running",
            auditId: created.id,
            lastStatus: res.lastStatus,
            message:
              "The audit did not finish within the time limit. Follow it with get_audit_status, then fetch the result with get_audit using this auditId.",
          };
        }
        return summarize(res.audit);
      }),
  );

  server.registerTool(
    "run_audit",
    {
      title: "Start an audit (non-blocking)",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Starts an SEO and AI-visibility audit on a URL without waiting. Returns the id and status. Use get_audit_status to follow progress and get_audit for the results.",
      inputSchema: {
        url: z.string().url().describe("URL to audit."),
        maxPages: z.number().int().min(1).max(50).optional().describe("Number of pages to crawl."),
        siteId: z.string().optional().describe("Attach the audit to an existing site (optional)."),
      },
    },
    async ({ url, maxPages, siteId }) => run(() => getClient().createAudit({ url, maxPages, siteId })),
  );

  server.registerTool(
    "get_audit_status",
    {
      title: "Get audit status",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "Lightweight status of an audit (PENDING/RUNNING/DONE/FAILED) with a progress value from 0 to 1.",
      inputSchema: { id: z.string().describe("Audit identifier.") },
    },
    async ({ id }) => run(() => getClient().getAuditStatus(id)),
  );

  server.registerTool(
    "get_audit",
    {
      title: "Get audit results",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Fetches the results of an audit: a summary by default (score, top actions, main issues), or the full payload with full=true (all pages and all issues).",
      inputSchema: {
        id: z.string().describe("Audit identifier."),
        full: z.boolean().optional().describe("true for the full payload, otherwise a summary."),
      },
    },
    async ({ id, full }) =>
      run(async () => {
        const audit = await getClient().getAudit(id);
        return full ? audit : summarize(audit);
      }),
  );

  server.registerTool(
    "list_sites",
    {
      title: "List your sites",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "Paginated list of your LightSpot team's sites (with their latest score).",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ limit, offset }) => run(() => getClient().listSites({ limit, offset })),
  );

  server.registerTool(
    "get_site",
    {
      title: "Get a site",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "A site's metadata and its recent audits.",
      inputSchema: { id: z.string().describe("Site identifier.") },
    },
    async ({ id }) => run(() => getClient().getSite(id)),
  );

  server.registerTool(
    "list_site_audits",
    {
      title: "List a site's audit history",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "Paginated audit history of a site.",
      inputSchema: {
        id: z.string().describe("Site identifier."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ id, limit, offset }) => run(() => getClient().listSiteAudits(id, { limit, offset })),
  );

  server.registerTool(
    "get_competitors",
    {
      title: "Get a site's competitor analysis",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Fetches a site's latest existing competitor analysis (detected competitors, tiers, citations, recommendations). Requires the Zenith plan. " +
        'Does NOT trigger a new analysis — if none has been started from the app yet, returns status: "NONE".',
      inputSchema: { siteId: z.string().describe("Site identifier.") },
    },
    async ({ siteId }) => run(async () => summarizeCompetitors(await getClient().getCompetitors(siteId))),
  );

  server.registerTool(
    "get_expert_report",
    {
      title: "Get a site's expert report",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Fetches the latest report from our 8 experts (technical SEO, editorial quality, AI visibility, structured data, sitemaps, performance, visual analysis, brand authority) produced after a site audit: " +
        "prioritized findings, recommended actions with their steps, limitations and ready-to-apply artifacts (JSON-LD, sitemap…). " +
        "Summary by default (findings + actions); full=true adds the rationale of the actions, the limitations, the artifacts and the evidence; expert=… limits the read to a single expert (useful with full=true to read one whole chapter without loading everything). " +
        "auditId targets the analysis of a specific audit, otherwise the site's most recent one. " +
        'Does NOT trigger an analysis — if none exists, returns status: "NONE"; PENDING/RUNNING = try again later.',
      inputSchema: {
        siteId: z.string().describe("LightSpot site identifier."),
        auditId: z
          .string()
          .optional()
          .describe("Identifier of a specific audit (otherwise the site's latest analysis)."),
        expert: z.enum(EXPERT_KEYS).optional().describe("Return only this expert's chapter."),
        full: z
          .boolean()
          .optional()
          .describe("true for the full report (rationale, limitations, artifacts, evidence), otherwise a summary."),
      },
    },
    async ({ siteId, auditId, expert, full }) =>
      run(async () => {
        const report = await getClient().getExpertReport(siteId, { auditId, expert });
        const hint = EXPERT_REPORT_HINTS[report.status];
        const body = full ? report : summarizeExpertReport(report);
        return hint ? { ...body, message: hint } : body;
      }),
  );

  server.registerTool(
    "get_editorial_calendar",
    {
      title: "Read a site's editorial calendar",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Reads a site's LightSpot editorial calendar over a period: imported slots, content being prepared, scheduled or published, and upcoming autopilot runs.",
      inputSchema: {
        siteId: z.string().describe("LightSpot site identifier."),
        from: z.string().describe("Inclusive start of the period, ISO 8601 with time zone."),
        to: z.string().describe("Exclusive end of the period, ISO 8601 with time zone (366 days maximum)."),
      },
    },
    async ({ siteId, from, to }) => run(() => getClient().getEditorialCalendar(siteId, from, to)),
  );

  server.registerTool(
    "create_editorial_calendar",
    {
      title: "Create or update an editorial calendar",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Imports up to 50 dated editorial slots into a LightSpot site's calendar. " +
        "The import is idempotent: externalId lets you update a slot without creating a duplicate. " +
        "This action only creates the schedule; it does not generate, schedule or publish any content and consumes no AI credit.",
      inputSchema: {
        siteId: z.string().describe("LightSpot site identifier."),
        items: z
          .array(
            z.object({
              externalId: z
                .string()
                .min(1)
                .max(160)
                .optional()
                .describe("Optional stable identifier for re-imports."),
              kind: z.enum(["SOCIAL", "ARTICLE"]).describe("Intended content type."),
              topic: z.string().min(1).max(300).describe("Slot topic or title."),
              platforms: z
                .array(z.enum(["LINKEDIN", "REDDIT", "X"]))
                .max(3)
                .optional()
                .describe("Required for SOCIAL, empty or omitted for ARTICLE."),
              format: z
                .string()
                .min(1)
                .max(80)
                .optional()
                .describe("Editorial format: post, carousel, thread, guide…"),
              notes: z
                .string()
                .min(1)
                .max(1_000)
                .optional()
                .describe("Angle, goal, CTA or writing instructions."),
              plannedFor: z.string().describe("Future date, ISO 8601 with time zone."),
            }),
          )
          .min(1)
          .max(50)
          .describe("Slots to show in the LightSpot calendar."),
      },
    },
    async ({ siteId, items }) => run(() => getClient().createEditorialCalendar(siteId, items)),
  );
}
