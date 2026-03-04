import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const DEFAULT_PORT = Number(process.env.PORT || 3000);

export function createApp() {
const app = express();

const NODE_ENV = process.env.NODE_ENV || "development";
const API_KEY = (process.env.BUILDERBOT_API_KEY || "").trim();
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").trim();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();

const runHistory = [];
const chatHistory = [];

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use((req, res, next) => {
  if (ALLOWED_ORIGIN && req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.use(express.static(publicDir));

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token || token !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  return next();
}

function safeNowId(prefix = "run") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function githubSearch(query, perPage = 15) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "inayanbuilderbot-masterpiece",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.max(1, Math.min(30, perPage))}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`github_search_failed:${r.status}`);
  const data = await r.json();
  return Array.isArray(data.items) ? data.items : [];
}

function computeUiEvidence(repo) {
  const desc = `${repo.description || ""} ${(repo.topics || []).join(" ")}`.toLowerCase();
  let evidence = 0;
  const hits = [];
  const checks = [
    ["dashboard", 3],
    ["chat", 3],
    ["ui", 2],
    ["web", 1],
    ["admin", 2],
    ["agent", 1],
  ];
  for (const [k, w] of checks) {
    if (desc.includes(k)) {
      evidence += w;
      hits.push(k);
    }
  }
  return { evidence, hits };
}

function scoreRepo(repo) {
  const stars = Number(repo.stargazers_count || 0);
  const forks = Number(repo.forks_count || 0);
  const updatedAt = Date.parse(repo.pushed_at || 0);
  const recencyDays = Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 86400000) : 9999;
  const recencyScore = Math.max(0, 20 - Math.min(20, recencyDays / 14));
  const ui = computeUiEvidence(repo);

  const frameworkOnly = /(sdk|framework|runtime|toolkit|library)/i.test(`${repo.name} ${repo.description || ""}`)
    && ui.evidence < 4;

  const base = Math.log10(Math.max(1, stars)) * 40 + Math.log10(Math.max(1, forks + 1)) * 10 + recencyScore + ui.evidence * 4;
  const penalty = frameworkOnly ? 20 : 0;
  const score = Math.round((base - penalty) * 100) / 100;

  return {
    score,
    uiEvidence: ui.evidence,
    uiHits: ui.hits,
    frameworkOnly,
  };
}

const ScoutSchema = z.object({
  queries: z.array(z.string().min(3)).min(1).max(8),
  perQuery: z.number().int().min(5).max(30).default(15),
  minStars: z.number().int().min(100).default(500),
  topK: z.number().int().min(3).max(25).default(10),
});

app.post("/api/v1/scout/run", authMiddleware, async (req, res) => {
  const parsed = ScoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

  const p = parsed.data;
  const all = [];
  for (const q of p.queries) {
    const repos = await githubSearch(q, p.perQuery);
    for (const r of repos) {
      if (r.archived || r.disabled) continue;
      if (Number(r.stargazers_count || 0) < p.minStars) continue;
      all.push(r);
    }
  }

  const dedup = new Map();
  for (const r of all) {
    const key = String(r.full_name || "").toLowerCase();
    if (!key || dedup.has(key)) continue;
    const s = scoreRepo(r);
    if (s.frameworkOnly) continue;
    if (s.uiEvidence < 4) continue;
    dedup.set(key, {
      full_name: r.full_name,
      html_url: r.html_url,
      description: r.description || "",
      stars: Number(r.stargazers_count || 0),
      forks: Number(r.forks_count || 0),
      language: r.language || null,
      pushed_at: r.pushed_at || null,
      score: s.score,
      uiEvidence: s.uiEvidence,
      uiHits: s.uiHits,
      topics: Array.isArray(r.topics) ? r.topics : [],
    });
  }

  const ranked = [...dedup.values()].sort((a, b) => b.score - a.score).slice(0, p.topK);
  const run = { id: safeNowId("scout"), type: "scout", createdAt: new Date().toISOString(), payload: p, output: ranked };
  runHistory.unshift(run);
  if (runHistory.length > 60) runHistory.length = 60;

  return res.json({ ok: true, runId: run.id, count: ranked.length, repos: ranked });
});

const BenchmarkSchema = z.object({
  repos: z.array(z.object({
    full_name: z.string(),
    stars: z.number().optional(),
    score: z.number().optional(),
    uiEvidence: z.number().optional(),
  })).min(1).max(25),
  weight_ui: z.number().min(0).max(1).default(0.55),
  weight_popularity: z.number().min(0).max(1).default(0.45),
});

app.post("/api/v1/benchmark/run", authMiddleware, (req, res) => {
  const parsed = BenchmarkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

  const p = parsed.data;
  const wUi = p.weight_ui;
  const wPop = p.weight_popularity;

  const maxStars = Math.max(...p.repos.map((r) => Number(r.stars || 0)), 1);
  const scored = p.repos.map((r) => {
    const ui = Number(r.uiEvidence || 0) / 12;
    const pop = Number(r.stars || 0) / maxStars;
    const normalized = Math.round((ui * wUi + pop * wPop) * 10000) / 100;
    return {
      ...r,
      benchmarkScore: normalized,
    };
  }).sort((a, b) => b.benchmarkScore - a.benchmarkScore);

  const run = { id: safeNowId("bench"), type: "benchmark", createdAt: new Date().toISOString(), payload: p, output: scored };
  runHistory.unshift(run);
  if (runHistory.length > 60) runHistory.length = 60;

  return res.json({ ok: true, runId: run.id, compared: scored.length, ranked: scored });
});

const BuildSchema = z.object({
  productName: z.string().min(2).max(100),
  userGoal: z.string().min(10).max(3000),
  selectedRepos: z.array(z.object({ full_name: z.string(), benchmarkScore: z.number().optional() })).min(1).max(10),
  stack: z.array(z.string().min(1).max(40)).min(1).max(12),
});

app.post("/api/v1/masterpiece/build", authMiddleware, (req, res) => {
  const parsed = BuildSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

  const p = parsed.data;
  const rankedRepos = [...p.selectedRepos].sort((a, b) => Number(b.benchmarkScore || 0) - Number(a.benchmarkScore || 0));

  const blueprint = {
    productName: p.productName,
    dedication: "Dedicated to Suro Jason Inaya.",
    objective: p.userGoal,
    foundation: {
      basedOn: "OpenClaw benchmark-first masterpiece workflow",
      topReferences: rankedRepos.slice(0, 5).map((r) => r.full_name),
      stack: p.stack,
    },
    buildPlan: [
      {
        phase: "Phase 1: Research + Lock",
        actions: [
          "Scout proven OSS repos with dashboard/chat modules",
          "Benchmark and prioritize by proven UI + adoption",
          "Lock architecture and reject framework-only low-signal patterns"
        ]
      },
      {
        phase: "Phase 2: Masterpiece Build",
        actions: [
          "Implement dashboard command center",
          "Implement integrated chat tool",
          "Add orchestration API and run history"
        ]
      },
      {
        phase: "Phase 3: Ship",
        actions: [
          "Run secret and security gates",
          "Run tests and smoke checks",
          "Publish install/ops/readme paperwork"
        ]
      }
    ],
    generatedAt: new Date().toISOString(),
  };

  const run = { id: safeNowId("masterpiece"), type: "masterpiece", createdAt: new Date().toISOString(), payload: p, output: blueprint };
  runHistory.unshift(run);
  if (runHistory.length > 60) runHistory.length = 60;

  return res.json({ ok: true, runId: run.id, blueprint });
});

const ChatSchema = z.object({
  message: z.string().min(2).max(2000),
  context: z.object({
    productName: z.string().optional(),
    stack: z.array(z.string()).optional(),
  }).optional(),
});

app.post("/api/v1/chat/reply", authMiddleware, (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

  const { message, context } = parsed.data;
  const lower = message.toLowerCase();

  let reply = "I can help you refine the masterpiece build. Ask for architecture, repo selection, benchmark weighting, or release checklist.";
  if (lower.includes("architecture")) {
    reply = "Architecture recommendation: split into dashboard-ui, chat-runtime, and orchestration-api modules with explicit contracts and test gates.";
  } else if (lower.includes("security") || lower.includes("secret")) {
    reply = "Security recommendation: enforce API key auth, origin allowlist, secret scan on every push, and no plaintext secrets in repo history.";
  } else if (lower.includes("benchmark")) {
    reply = "Benchmark recommendation: weight UI evidence and adoption, and exclude framework-only repos lacking dashboard/chat modules.";
  }

  const record = {
    id: safeNowId("chat"),
    at: new Date().toISOString(),
    message,
    context: context || null,
    reply,
  };

  chatHistory.unshift(record);
  if (chatHistory.length > 120) chatHistory.length = 120;

  return res.json({ ok: true, reply, chat: record });
});

app.get("/api/v1/chat/history", authMiddleware, (_req, res) => {
  return res.json({ ok: true, count: chatHistory.length, history: chatHistory });
});

app.get("/api/v1/runs", authMiddleware, (_req, res) => {
  return res.json({ ok: true, count: runHistory.length, runs: runHistory });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "inayanbuilderbot-masterpiece", env: NODE_ENV, time: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  const fp = path.join(publicDir, "index.html");
  if (!fs.existsSync(fp)) return res.status(404).send("Dashboard missing");
  return res.sendFile(fp);
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err?.message || err);
  return res.status(500).json({ ok: false, error: "internal_error" });
});

return app;
}

export function startServer(port = DEFAULT_PORT) {
  const app = createApp();
  return app.listen(port, () => {
    console.log(`InayanBuilderBot (Masterpiece Agent + Chat Tool) listening on http://localhost:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer(DEFAULT_PORT);
}
