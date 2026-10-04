// Thin HTTP client for the LightSpot.ai public API (/v1/*). Mirrors the wire
// shapes from the app's lib/api/serializers.ts. Auth is a Bearer API key
// (lspai_live_…) created in the LightSpot dashboard (Eclat and Zenith plans), or an OAuth access token
// when used by the remote connector.

const DEFAULT_BASE = "https://lightspot.ai";

export class LightSpotError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  constructor(message: string, code: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "LightSpotError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// ─── Wire shapes (subset, mirrors lib/api/serializers.ts) ───────────────────

export type AuditScore = {
  global: number | null;
  seo: number | null;
  geo: number | null;
  grade: string | null;
};

export type ApiIssue = {
  id: string;
  label: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  detail?: string;
  fix?: string;
  fixSnippet?: string;
  fixSnippetKind?: string;
  affectedPages: number;
};

export type ApiTopAction = {
  what: string;
  why: string;
  effort: "LOW" | "MEDIUM" | "HIGH";
  severity: "HIGH" | "MEDIUM" | "LOW";
  affectedPages?: number;
};

export type ApiPageSummary = { url: string; score: number; passed: number; total: number };
export type ApiKeyword = { term: string; count: number; pages: number };

export type AuditCreated = {
  id: string;
  shareToken: string | null;
  status: string;
  maxPages: number;
};

export type AuditStatusResp = { id: string; status: string; progress: number };

export type ApiAuditFull = {
  id: string;
  status: string;
  url: string;
  score: AuditScore;
  detectedStack: string | null;
  siteId: string | null;
  shareToken: string | null;
  createdAt: string;
  completedAt: string | null;
  issues: ApiIssue[];
  topActions: ApiTopAction[];
  pages: ApiPageSummary[];
  keywords: ApiKeyword[];
};

export type ApiSite = {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  latestAuditId: string | null;
  latestScore: number | null;
};

export type ApiCompetitor = {
  domain: string;
  tier: string | null;
  citationCount: number;
  sameRegion: boolean | null;
  sentiment: number | null;
};

export type ApiRecommendationAction = {
  title: string;
  why: string;
  affectedPrompts?: unknown;
  effort?: string;
  impact?: string;
  competitorEvidence?: unknown;
};

export type ApiCompetitorRun = {
  status: "NONE" | "PENDING" | "RUNNING" | "DONE" | "FAILED";
  runId: string | null;
  completedAt: string | null;
  competitors: ApiCompetitor[];
  recommendations: { actions: ApiRecommendationAction[] } | null;
};

export type ApiExpertReportStatus =
  | "NONE"
  | "PENDING"
  | "RUNNING"
  | "READY"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export type ApiExpertFinding = {
  title: string;
  detail: string;
  priority: "high" | "medium" | "low" | "info";
  evidenceIds: string[];
};

export type ApiExpertAction = {
  title: string;
  rationale: string;
  steps: string[];
  effort: "low" | "medium" | "high";
};

export type ApiExpertArtifact = {
  name: string;
  format: "json" | "xml" | "markdown" | "text";
  content: string;
};

export type ApiExpertEvidence = {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  capturedAt: string;
};

export type ApiExpertChapter = {
  expert: string;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";
  errorCode: string | null;
  completedAt: string | null;
  report: {
    title: string;
    summary: string;
    findings: ApiExpertFinding[];
    actions: ApiExpertAction[];
    limitations: string[];
    artifacts: ApiExpertArtifact[];
  } | null;
  evidence: ApiExpertEvidence[];
};

export type ApiExpertReport = {
  status: ApiExpertReportStatus;
  id: string | null;
  auditId: string | null;
  locale: "fr" | "en" | null;
  goal: string;
  createdAt: string | null;
  completedAt: string | null;
  progress: { completed: number; total: number };
  experts: ApiExpertChapter[];
};

export type EditorialPlatform = "LINKEDIN" | "REDDIT" | "X";

export type EditorialCalendarItemInput = {
  externalId?: string;
  kind: "SOCIAL" | "ARTICLE";
  topic: string;
  platforms?: EditorialPlatform[];
  format?: string;
  notes?: string;
  plannedFor: string;
};

export type ApiEditorialSlot = {
  id: string;
  externalId: string;
  kind: "SOCIAL" | "ARTICLE";
  topic: string;
  platforms: EditorialPlatform[];
  format: string | null;
  notes: string | null;
  plannedFor: string;
  status: "PLANNED" | "ARCHIVED";
};

export type ApiCalendarItem = {
  kind: "article" | "social" | "slot";
  id: string;
  siteId: string;
  siteName: string;
  title: string;
  platform?: string;
  slotKind?: "SOCIAL" | "ARTICLE";
  platforms?: string[];
  format?: string | null;
  notes?: string | null;
  status: "planned" | "scheduled" | "published" | "failed" | "preparing";
  at: string;
  error?: string;
};

export type ApiGhostSlot = {
  kind: "ghost-content" | "ghost-social";
  siteId: string;
  siteName: string;
  at: string;
};

export type ApiEditorialCalendar = {
  items: ApiCalendarItem[];
  ghosts: ApiGhostSlot[];
};

export type ApiEditorialCalendarImport = {
  created: number;
  updated: number;
  items: ApiEditorialSlot[];
  calendarPath: string;
};

export type Paginated<T> = { data: T[]; total: number; limit: number; offset: number };

// ─── Client ─────────────────────────────────────────────────────────────────

export class LightSpotClient {
  readonly base: string;
  private readonly key: string;

  private readonly mode: "api-key" | "oauth";

  constructor(key: string, base?: string, mode: "api-key" | "oauth" = "api-key") {
    this.key = key;
    this.mode = mode;
    this.base = (base && base.trim() ? base : DEFAULT_BASE).replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new LightSpotError(
        `Could not reach the LightSpot API (${this.base}): ${e instanceof Error ? e.message : String(e)}`,
        "network_error",
        0,
      );
    }

    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; retryAfter?: number } } | undefined)?.error;
      const code = err?.code ?? `http_${res.status}`;
      const message = err?.message ?? this.friendly(res.status) ?? `Request failed (HTTP ${res.status}).`;
      const headerRetry = Number(res.headers?.get?.("Retry-After"));
      const retryAfter = err?.retryAfter ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined);
      throw new LightSpotError(message, code, res.status, retryAfter);
    }

    return json as T;
  }

  private friendly(status: number): string | undefined {
    switch (status) {
      case 401:
        return this.mode === "oauth"
          ? "Your LightSpot access token expired or was revoked. Retry the request; if it keeps failing, reconnect LightSpot in Claude."
          : "Invalid or revoked API key. Check LIGHTSPOT_API_KEY (format lspai_live_…).";
      case 402:
        return "Monthly AI budget reached — audits are paused until the next cycle.";
      case 404:
        return "Resource not found.";
      case 429:
        return "Rate limit reached. Try again in a moment.";
      default:
        return undefined;
    }
  }

  private qs(params: Record<string, number | string | undefined>): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined);
    if (!entries.length) return "";
    return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  }

  // POST /v1/audits
  createAudit(input: { url: string; maxPages?: number; siteId?: string }): Promise<AuditCreated> {
    return this.request("POST", "/v1/audits", input);
  }

  // GET /v1/audits/:id/status
  getAuditStatus(id: string): Promise<AuditStatusResp> {
    return this.request("GET", `/v1/audits/${encodeURIComponent(id)}/status`);
  }

  // GET /v1/audits/:id
  getAudit(id: string): Promise<ApiAuditFull> {
    return this.request("GET", `/v1/audits/${encodeURIComponent(id)}`);
  }

  // GET /v1/sites
  listSites(params: { limit?: number; offset?: number } = {}): Promise<Paginated<ApiSite>> {
    return this.request("GET", `/v1/sites${this.qs(params)}`);
  }

  // GET /v1/sites/:id
  getSite(id: string): Promise<ApiSite & { recentAudits?: unknown[] }> {
    return this.request("GET", `/v1/sites/${encodeURIComponent(id)}`);
  }

  // GET /v1/sites/:id/audits
  listSiteAudits(
    id: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<Paginated<unknown>> {
    return this.request("GET", `/v1/sites/${encodeURIComponent(id)}/audits${this.qs(params)}`);
  }

  // GET /v1/sites/:id/competitors
  getCompetitors(id: string): Promise<ApiCompetitorRun> {
    return this.request("GET", `/v1/sites/${encodeURIComponent(id)}/competitors`);
  }

  // GET /v1/sites/:id/experts
  getExpertReport(
    id: string,
    params: { auditId?: string; expert?: string } = {},
  ): Promise<ApiExpertReport> {
    return this.request("GET", `/v1/sites/${encodeURIComponent(id)}/experts${this.qs(params)}`);
  }

  // GET /v1/sites/:id/editorial-calendar
  getEditorialCalendar(id: string, from: string, to: string): Promise<ApiEditorialCalendar> {
    return this.request(
      "GET",
      `/v1/sites/${encodeURIComponent(id)}/editorial-calendar${this.qs({ from, to })}`,
    );
  }

  // POST /v1/sites/:id/editorial-calendar
  createEditorialCalendar(
    id: string,
    items: EditorialCalendarItemInput[],
  ): Promise<ApiEditorialCalendarImport> {
    return this.request("POST", `/v1/sites/${encodeURIComponent(id)}/editorial-calendar`, {
      items,
    });
  }
}
