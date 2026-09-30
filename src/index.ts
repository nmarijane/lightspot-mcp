#!/usr/bin/env node
// LightSpot.ai MCP server (stdio). Exposes the LightSpot SEO/GEO audit API as
// MCP tools so any MCP client (Claude, Cursor, …) can run audits, read
// results, and import an editorial plan. Auth: set LIGHTSPOT_API_KEY
// (lspai_live_…) in the server config.
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
import { z } from "zod";
import {
  LightSpotClient,
  LightSpotError,
  type ApiAuditFull,
  type ApiCompetitorRun,
  type ApiExpertReport,
} from "./client.js";

const API_KEY = process.env.LIGHTSPOT_API_KEY;
const BASE_URL = process.env.LIGHTSPOT_BASE_URL;

const client = API_KEY ? new LightSpotClient(API_KEY, BASE_URL) : null;

function requireClient(): LightSpotClient {
  if (!client) {
    throw new Error(
      "LIGHTSPOT_API_KEY non défini. Ajoutez votre clé (lspai_live_…) dans l'environnement du serveur MCP. " +
        "Créez-en une dans LightSpot → Réglages → API (plans Business/Enterprise).",
    );
  }
  return client;
}

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
      const retry = e.retryAfter ? ` Réessayez dans ${e.retryAfter}s.` : "";
      return fail(`${e.message} (code: ${e.code}).${retry}`);
    }
    return fail(e instanceof Error ? e.message : String(e));
  }
}

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
    competitors: r.competitors, // déjà triés par citationCount décroissant côté API
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
  NONE: "Aucune analyse d'experts n'existe pour ce site (ou cet audit). Elle se lance après un audit depuis l'app LightSpot ou via audit_and_wait, selon le plan.",
  PENDING: "L'analyse d'experts est en file d'attente. Réessayez dans quelques minutes.",
  RUNNING: "L'analyse d'experts est en cours (comptez ~5 minutes). Réessayez dans quelques minutes ; progress indique les experts déjà terminés.",
  FAILED: "L'analyse d'experts a échoué : aucun chapitre n'a abouti.",
  CANCELLED: "L'analyse d'experts a été annulée.",
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

const server = new McpServer({ name: "lightspot", version: "0.5.0" });

server.registerTool(
  "audit_and_wait",
  {
    title: "Audit a URL and wait for the result",
    description:
      "Lance un audit SEO & GEO LightSpot sur une URL, attend la fin, et renvoie un résumé (score, top actions, principaux problèmes). " +
      "Idéal pour « audite ce site et dis-moi quoi corriger ». Peut prendre 1 à 3 minutes ; au-delà du délai, renvoie l'id pour suivre via get_audit_status / get_audit.",
    inputSchema: {
      url: z.string().url().describe("URL à auditer (page d'accueil ou page précise)."),
      maxPages: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Nombre de pages à crawler (plafonné par votre plan)."),
    },
  },
  async ({ url, maxPages }) =>
    run(async () => {
      const c = requireClient();
      const created = await c.createAudit({ url, maxPages });
      const res = await c.pollUntilDone(created.id, { timeoutMs: 180_000, intervalMs: 3_000 });
      if (res.kind === "timeout") {
        return {
          status: "still_running",
          auditId: created.id,
          lastStatus: res.lastStatus,
          message:
            "L'audit n'est pas terminé dans le délai imparti. Suivez-le avec get_audit_status puis récupérez le résultat avec get_audit en passant cet auditId.",
        };
      }
      return summarize(res.audit);
    }),
);

server.registerTool(
  "run_audit",
  {
    title: "Start an audit (non-blocking)",
    description:
      "Démarre un audit SEO & GEO sur une URL sans attendre. Renvoie l'id et le statut. Utilisez get_audit_status pour suivre, get_audit pour les résultats.",
    inputSchema: {
      url: z.string().url().describe("URL à auditer."),
      maxPages: z.number().int().min(1).max(50).optional().describe("Nombre de pages à crawler."),
      siteId: z.string().optional().describe("Rattacher l'audit à un site existant (optionnel)."),
    },
  },
  async ({ url, maxPages, siteId }) => run(() => requireClient().createAudit({ url, maxPages, siteId })),
);

server.registerTool(
  "get_audit_status",
  {
    title: "Get audit status",
    description: "Statut léger d'un audit (PENDING/RUNNING/DONE/FAILED) avec une progression de 0 à 1.",
    inputSchema: { id: z.string().describe("Identifiant de l'audit.") },
  },
  async ({ id }) => run(() => requireClient().getAuditStatus(id)),
);

server.registerTool(
  "get_audit",
  {
    title: "Get audit results",
    description:
      "Récupère les résultats d'un audit : résumé par défaut (score, top actions, principaux problèmes), ou payload complet avec full=true (toutes les pages et tous les problèmes).",
    inputSchema: {
      id: z.string().describe("Identifiant de l'audit."),
      full: z.boolean().optional().describe("true pour le payload complet, sinon un résumé."),
    },
  },
  async ({ id, full }) =>
    run(async () => {
      const audit = await requireClient().getAudit(id);
      return full ? audit : summarize(audit);
    }),
);

server.registerTool(
  "list_sites",
  {
    title: "List your sites",
    description: "Liste paginée des sites de votre équipe LightSpot (avec leur dernier score).",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Taille de page (défaut 50)."),
      offset: z.number().int().min(0).optional().describe("Décalage de pagination."),
    },
  },
  async ({ limit, offset }) => run(() => requireClient().listSites({ limit, offset })),
);

server.registerTool(
  "get_site",
  {
    title: "Get a site",
    description: "Métadonnées d'un site et ses audits récents.",
    inputSchema: { id: z.string().describe("Identifiant du site.") },
  },
  async ({ id }) => run(() => requireClient().getSite(id)),
);

server.registerTool(
  "list_site_audits",
  {
    title: "List a site's audit history",
    description: "Historique paginé des audits d'un site.",
    inputSchema: {
      id: z.string().describe("Identifiant du site."),
      limit: z.number().int().min(1).max(100).optional().describe("Taille de page (défaut 50)."),
      offset: z.number().int().min(0).optional().describe("Décalage de pagination."),
    },
  },
  async ({ id, limit, offset }) => run(() => requireClient().listSiteAudits(id, { limit, offset })),
);

server.registerTool(
  "get_competitors",
  {
    title: "Get a site's competitor analysis",
    description:
      "Récupère la dernière analyse concurrentielle existante d'un site (concurrents détectés, tiers, citations, recommandations). " +
      'Ne déclenche PAS de nouvelle analyse — si aucune n\'a encore été lancée depuis l\'app, renvoie status: "NONE".',
    inputSchema: { siteId: z.string().describe("Identifiant du site.") },
  },
  async ({ siteId }) =>
    run(async () => summarizeCompetitors(await requireClient().getCompetitors(siteId))),
);

server.registerTool(
  "get_expert_report",
  {
    title: "Get a site's expert report",
    description:
      "Récupère le dernier rapport de nos 8 experts (SEO technique, qualité éditoriale, SEO/GEO, données structurées, sitemaps, performance, analyse visuelle, autorité de marque) produit après un audit d'un site : " +
      "constats priorisés, actions recommandées avec leurs étapes, limites et artefacts prêts à appliquer (JSON-LD, sitemap…). " +
      "Résumé par défaut (constats + actions) ; full=true ajoute la justification des actions, les limites, les artefacts et les preuves ; expert=… limite la lecture à un seul expert (utile avec full=true pour lire un chapitre complet sans tout charger). " +
      "auditId cible l'analyse d'un audit précis, sinon la plus récente du site. " +
      'Ne déclenche PAS d\'analyse — si aucune n\'existe, renvoie status: "NONE" ; PENDING/RUNNING = réessayer plus tard.',
    inputSchema: {
      siteId: z.string().describe("Identifiant du site LightSpot."),
      auditId: z.string().optional().describe("Identifiant d'un audit précis (sinon la dernière analyse du site)."),
      expert: z.enum(EXPERT_KEYS).optional().describe("Ne renvoyer que ce chapitre d'expert."),
      full: z
        .boolean()
        .optional()
        .describe("true pour le rapport complet (justifications, limites, artefacts, preuves), sinon un résumé."),
    },
  },
  async ({ siteId, auditId, expert, full }) =>
    run(async () => {
      const report = await requireClient().getExpertReport(siteId, { auditId, expert });
      const hint = EXPERT_REPORT_HINTS[report.status];
      const body = full ? report : summarizeExpertReport(report);
      return hint ? { ...body, message: hint } : body;
    }),
);

server.registerTool(
  "get_editorial_calendar",
  {
    title: "Read a site's editorial calendar",
    description:
      "Lit le calendrier éditorial LightSpot d'un site sur une période : créneaux importés, contenus en préparation, planifiés ou publiés, et prochaines exécutions autopilot.",
    inputSchema: {
      siteId: z.string().describe("Identifiant du site LightSpot."),
      from: z
        .string()
        .describe("Début inclus de la période, au format ISO 8601 avec fuseau."),
      to: z
        .string()
        .describe("Fin exclue de la période, au format ISO 8601 avec fuseau (366 jours maximum)."),
    },
  },
  async ({ siteId, from, to }) =>
    run(() => requireClient().getEditorialCalendar(siteId, from, to)),
);

server.registerTool(
  "create_editorial_calendar",
  {
    title: "Create or update an editorial calendar",
    description:
      "Importe jusqu'à 50 créneaux éditoriaux datés dans le calendrier d'un site LightSpot. " +
      "L'import est idempotent : externalId permet de mettre un créneau à jour sans doublon. " +
      "Cette action crée uniquement le planning ; elle ne génère, ne planifie et ne publie aucun contenu et ne consomme aucun crédit IA.",
    inputSchema: {
      siteId: z.string().describe("Identifiant du site LightSpot."),
      items: z
        .array(
          z.object({
            externalId: z
              .string()
              .min(1)
              .max(160)
              .optional()
              .describe("Identifiant stable optionnel pour les réimports."),
            kind: z.enum(["SOCIAL", "ARTICLE"]).describe("Type de contenu envisagé."),
            topic: z.string().min(1).max(300).describe("Sujet ou titre du créneau."),
            platforms: z
              .array(z.enum(["LINKEDIN", "REDDIT", "X"]))
              .max(3)
              .optional()
              .describe("Obligatoire pour SOCIAL, vide ou omis pour ARTICLE."),
            format: z
              .string()
              .min(1)
              .max(80)
              .optional()
              .describe("Format éditorial : post, carousel, thread, guide…"),
            notes: z
              .string()
              .min(1)
              .max(1_000)
              .optional()
              .describe("Angle, objectif, CTA ou consignes de rédaction."),
            plannedFor: z
              .string()
              .describe("Date future au format ISO 8601 avec fuseau."),
          }),
        )
        .min(1)
        .max(50)
        .describe("Créneaux à afficher dans le calendrier LightSpot."),
    },
  },
  async ({ siteId, items }) =>
    run(() => requireClient().createEditorialCalendar(siteId, items)),
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
