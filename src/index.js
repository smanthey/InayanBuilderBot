import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, ".data");
const runsFile = path.join(dataDir, "runs.json");
const builtinRepoIndexFile = path.join(rootDir, "data", "builtin-repo-index.json");
const envFile = path.join(rootDir, ".env");
const envExampleFile = path.join(rootDir, ".env.example");

const DEFAULT_PORT = Number(process.env.PORT || 3000);
const CLAW_ARCHITECT_ROOT = process.env.CLAW_ARCHITECT_ROOT || "/Users/tatsheen/claw-architect";

const appState = {
  runs: [],
  chats: [],
  chatSessions: {},
  providerMetrics: {},
  projectMemory: {},
};

const MAGIC_RUN_SCOUT_CACHE = new Map();
const MAGIC_RUN_BENCH_CACHE = new Map();
const PIPELINE_SCOUT_CACHE = new Map();
const PIPELINE_BENCH_CACHE = new Map();
const PIPELINE_GITHUB_CACHE = new Map();
const PIPELINE_REDDIT_CACHE = new Map();
const MAGIC_RUN_CACHE_TTL_MS = Number(process.env.MAGIC_RUN_CACHE_TTL_MS || 10 * 60 * 1000);
const MAGIC_RUN_MAX_BUDGET_USD = Number(process.env.MAGIC_RUN_MAX_BUDGET_USD || 25000);

function ensureDataStore() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(runsFile)) {
    fs.writeFileSync(
      runsFile,
      JSON.stringify({ runs: [], chats: [], chatSessions: {}, providerMetrics: {}, projectMemory: {} }, null, 2)
    );
  }
  try {
    const raw = JSON.parse(fs.readFileSync(runsFile, "utf8"));
    appState.runs = Array.isArray(raw.runs) ? raw.runs : [];
    appState.chats = Array.isArray(raw.chats) ? raw.chats : [];
    appState.chatSessions = raw && typeof raw.chatSessions === "object" && raw.chatSessions
      ? raw.chatSessions
      : {};
    appState.providerMetrics = raw && typeof raw.providerMetrics === "object" && raw.providerMetrics
      ? raw.providerMetrics
      : {};
    appState.projectMemory = raw && typeof raw.projectMemory === "object" && raw.projectMemory
      ? raw.projectMemory
      : {};
  } catch {
    appState.runs = [];
    appState.chats = [];
    appState.chatSessions = {};
    appState.providerMetrics = {};
    appState.projectMemory = {};
  }
}

function persistDataStore() {
  const sessions = Object.entries(appState.chatSessions || {})
    .slice(0, 100)
    .reduce((acc, [id, session]) => {
      acc[id] = {
        ...session,
        messages: Array.isArray(session?.messages) ? session.messages.slice(-100) : [],
      };
      return acc;
    }, {});
  fs.writeFileSync(
    runsFile,
    JSON.stringify(
      {
        runs: appState.runs.slice(0, 100),
        chats: appState.chats.slice(0, 300),
        chatSessions: sessions,
        providerMetrics: appState.providerMetrics || {},
        projectMemory: appState.projectMemory || {},
      },
      null,
      2
    )
  );
}

function nowId(prefix = "run") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function trimHistory() {
  if (appState.runs.length > 100) appState.runs.length = 100;
  if (appState.chats.length > 300) appState.chats.length = 300;
  const sessionIds = Object.keys(appState.chatSessions || {});
  if (sessionIds.length > 100) {
    const sorted = sessionIds
      .map((id) => ({ id, updatedAt: Date.parse(appState.chatSessions[id]?.updatedAt || 0) || 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map((s) => s.id);
    const keep = new Set(sorted);
    for (const id of sessionIds) {
      if (!keep.has(id)) delete appState.chatSessions[id];
    }
  }
  for (const id of Object.keys(appState.chatSessions || {})) {
    const messages = appState.chatSessions[id]?.messages;
    if (Array.isArray(messages) && messages.length > 100) {
      appState.chatSessions[id].messages = messages.slice(-100);
    }
  }
  const memoryKeys = Object.keys(appState.projectMemory || {});
  if (memoryKeys.length > 120) {
    const sorted = memoryKeys
      .map((id) => ({ id, updatedAt: Date.parse(appState.projectMemory[id]?.updatedAt || 0) || 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 120)
      .map((x) => x.id);
    const keep = new Set(sorted);
    for (const id of memoryKeys) {
      if (!keep.has(id)) delete appState.projectMemory[id];
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokenCount(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function estimateCostUsd(provider, inputTokens, outputTokens) {
  // Coarse defaults per 1k tokens, override with env when needed.
  const defaults = {
    openai_in: Number(process.env.OPENAI_COST_INPUT_PER_1K || 0.005),
    openai_out: Number(process.env.OPENAI_COST_OUTPUT_PER_1K || 0.015),
    deepseek_in: Number(process.env.DEEPSEEK_COST_INPUT_PER_1K || 0.0014),
    deepseek_out: Number(process.env.DEEPSEEK_COST_OUTPUT_PER_1K || 0.0028),
    anthropic_in: Number(process.env.ANTHROPIC_COST_INPUT_PER_1K || 0.003),
    anthropic_out: Number(process.env.ANTHROPIC_COST_OUTPUT_PER_1K || 0.015),
    gemini_in: Number(process.env.GEMINI_COST_INPUT_PER_1K || 0.00125),
    gemini_out: Number(process.env.GEMINI_COST_OUTPUT_PER_1K || 0.005),
  };
  const inRate = Number(defaults[`${provider}_in`] || 0);
  const outRate = Number(defaults[`${provider}_out`] || 0);
  const total = (Math.max(0, inputTokens) / 1000) * inRate + (Math.max(0, outputTokens) / 1000) * outRate;
  return Math.round(total * 1e6) / 1e6;
}

function ensureProviderMetric(provider) {
  if (!appState.providerMetrics[provider]) {
    appState.providerMetrics[provider] = {
      attempts: 0,
      success: 0,
      failed: 0,
      avgLatencyMs: null,
      avgEstimatedCostUsd: null,
      lastError: null,
      lastUsedAt: null,
    };
  }
  return appState.providerMetrics[provider];
}

function recordProviderMetric({ provider, ok, latencyMs, estimatedCostUsd, error }) {
  const metric = ensureProviderMetric(provider);
  metric.attempts += 1;
  if (ok) metric.success += 1;
  else metric.failed += 1;
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    metric.avgLatencyMs = metric.avgLatencyMs == null
      ? latencyMs
      : Math.round((metric.avgLatencyMs * 0.8 + latencyMs * 0.2) * 100) / 100;
  }
  if (Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0) {
    metric.avgEstimatedCostUsd = metric.avgEstimatedCostUsd == null
      ? estimatedCostUsd
      : Math.round((metric.avgEstimatedCostUsd * 0.8 + estimatedCostUsd * 0.2) * 1e6) / 1e6;
  }
  metric.lastUsedAt = new Date().toISOString();
  if (!ok) metric.lastError = String(error || "unknown_error").slice(0, 200);
}

function ensureChatSession(sessionId) {
  const now = new Date().toISOString();
  const id = sessionId || nowId("session");
  if (!appState.chatSessions[id]) {
    appState.chatSessions[id] = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }
  appState.chatSessions[id].updatedAt = now;
  return appState.chatSessions[id];
}

function appendSessionMessage(session, role, content, meta = {}) {
  session.messages.push({
    id: nowId("msg"),
    role,
    content: String(content || ""),
    at: new Date().toISOString(),
    meta,
  });
  session.updatedAt = new Date().toISOString();
}

function getSessionHistory(session, maxMessages = 8) {
  if (!session || !Array.isArray(session.messages)) return [];
  return session.messages.slice(-maxMessages).map((m) => ({
    role: m.role,
    content: m.content,
    at: m.at,
  }));
}

async function runCommand({ cmd, args, cwd, timeoutMs = 12 * 60 * 1000 }) {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += String(d || "");
    });
    child.stderr.on("data", (d) => {
      stderr += String(d || "");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: Number(code || 0) === 0 && !timedOut,
        code: Number(code || 0),
        timed_out: timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function parseTrailingJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  for (let i = raw.lastIndexOf("{"); i >= 0; i = raw.lastIndexOf("{", i - 1)) {
    try {
      return JSON.parse(raw.slice(i));
    } catch {
      // keep scanning
    }
  }
  return null;
}

function parseReleaseChecklistSummary(text) {
  const raw = String(text || "");
  const hard = raw.match(/Hard failures:\s*(\d+)/i);
  const blocked = raw.match(/Blocked checks:\s*(\d+)/i);
  const blockedLines = raw
    .split(/\r?\n/g)
    .map((line) => String(line || "").trim())
    .filter((line) => line.startsWith("- ") && line.includes(":") && /\(missing live\/prod environment variables\)/i.test(line))
    .slice(0, 25);

  return {
    hard_failures: Number(hard?.[1] || 0),
    env_blocked_checks: Number(blocked?.[1] || 0),
    blocked_items: blockedLines.map((line) => line.replace(/^- /, "")),
  };
}

function detectDependencyInstallHint(text) {
  const raw = String(text || "");
  const missingPkg = raw.match(/Cannot find package '([^']+)'/i);
  if (!missingPkg) return null;
  return {
    issue: "missing_local_dependency",
    package: missingPkg[1],
    suggested_fix: "Run npm ci in the failing repo before build/check steps.",
  };
}

function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/g)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    out[key] = value;
  }
  return out;
}

function readEnvFileSafe() {
  try {
    return fs.readFileSync(envFile, "utf8");
  } catch {
    return "";
  }
}

function ensureEnvFile() {
  if (fs.existsSync(envFile)) return;
  if (fs.existsSync(envExampleFile)) {
    fs.copyFileSync(envExampleFile, envFile);
    return;
  }
  fs.writeFileSync(envFile, "", "utf8");
}

function upsertEnvText(text, key, value) {
  const lines = String(text || "").split(/\r?\n/g);
  let found = false;
  const next = lines.map((line) => {
    if (!line || line.trim().startsWith("#")) return line;
    const idx = line.indexOf("=");
    if (idx <= 0) return line;
    const k = line.slice(0, idx).trim();
    if (k !== key) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) next.push(`${key}=${value}`);
  return `${next.join("\n").replace(/\n+$/g, "")}\n`;
}

function maskSecret(value, keepStart = 4, keepEnd = 2) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= keepStart + keepEnd) return `${"*".repeat(Math.max(0, s.length - 1))}${s.slice(-1)}`;
  return `${s.slice(0, keepStart)}${"*".repeat(Math.max(3, s.length - keepStart - keepEnd))}${s.slice(-keepEnd)}`;
}

function parseBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeProjectKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function deterministicHash(payload) {
  const json = JSON.stringify(payload);
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function deterministicRepoSort(repos) {
  return [...(Array.isArray(repos) ? repos : [])].sort((a, b) => {
    const as = Number(a?.benchmarkScore || a?.score || 0);
    const bs = Number(b?.benchmarkScore || b?.score || 0);
    if (bs !== as) return bs - as;
    const an = String(a?.full_name || a?.name || "");
    const bn = String(b?.full_name || b?.name || "");
    return an.localeCompare(bn);
  });
}

function buildEvidencePack({ githubReport, redditReport, fusion, top = 8 }) {
  return {
    github: Array.isArray(githubReport?.answers)
      ? githubReport.answers.slice(0, top).map((x) => ({
        title: x.title,
        rank_score: Number(x.rank_score || 0),
        url: x.html_url,
      }))
      : [],
    reddit: Array.isArray(redditReport?.results)
      ? redditReport.results.slice(0, top).map((x) => ({
        title: x.title,
        subreddit: x.subreddit,
        rank_score: Number(x.rank_score || 0),
        url: x.permalink || x.url || null,
      }))
      : [],
    fusion: Array.isArray(fusion?.leaderboard)
      ? fusion.leaderboard.slice(0, top).map((x) => ({
        repo: x.full_name,
        score: Number(x.fusionScore || 0),
        reasons: Array.isArray(x.reasons) ? x.reasons.slice(0, 4) : [],
      }))
      : [],
  };
}

function buildExecutableBlueprint({
  productName,
  userGoal,
  stack,
  selectedRepos,
  evidence,
  constraints,
}) {
  const assumptions = [
    "Top benchmarked repos represent feasible architecture patterns.",
    "Initial scope targets MVP shipping speed over full enterprise breadth.",
    "APIs and data contracts are versioned from day one.",
  ];
  const confidence = Math.min(
    0.95,
    0.55
      + Math.min(0.2, (Array.isArray(selectedRepos) ? selectedRepos.length : 0) * 0.02)
      + Math.min(0.2, ((evidence?.github?.length || 0) + (evidence?.reddit?.length || 0)) * 0.01)
  );

  const filePlan = [
    { path: "src/api/pipeline/magic-run.ts", purpose: "One-click orchestration endpoint + deterministic planner." },
    { path: "src/core/planning/evaluation.ts", purpose: "Quality scorecards and auto-repair gates." },
    { path: "src/core/planning/execution-bridge.ts", purpose: "Convert plans into owner-ready tasks." },
    { path: "src/core/planning/contract-parity.ts", purpose: "Route contract parity checks between frontend API calls and backend routes." },
    { path: "src/core/planning/project-memory.ts", purpose: "Persist decisions, rejected options, constraints." },
    { path: "src/ui/plan-editor.tsx", purpose: "Interactive constraint editing + plan diffs." },
    { path: "tests/e2e/magic-run.spec.ts", purpose: "Playwright E2E coverage for deterministic magic run flow." },
    { path: "tests/e2e/deploy-targets.spec.ts", purpose: "Playwright checks for Replit/Vercel deployment paths." },
    { path: "playwright.config.ts", purpose: "Browser test configuration for CI and local smoke lanes." },
  ];

  const apiContracts = [
    { method: "POST", path: "/api/v1/masterpiece/magic-run", body: "{ userGoal, productName?, stack?, constraints? }" },
    { method: "POST", path: "/api/v1/masterpiece/recompile", body: "{ runId, constraints, notes? }" },
    { method: "GET", path: "/api/v1/projects/:projectKey/memory", body: "none" },
  ];

  const dbMigrations = [
    "create table project_memory(project_key text primary key, payload jsonb, updated_at timestamptz);",
    "create table plan_versions(id text primary key, project_key text, constraints jsonb, output jsonb, created_at timestamptz);",
    "create table execution_tasks(id text primary key, project_key text, plan_id text, priority int, owner text, title text, acceptance jsonb);",
  ];

  const testPlan = [
    "Determinism: identical input produces identical plan hash + structure.",
    "Quality gate: low-score plans fail and return actionable remediation.",
    "API contract parity: frontend API calls are covered by backend routes or explicit aliases.",
    "Execution bridge: generated tasks include owner, priority, acceptance criteria.",
    "Memory continuity: prior decisions are loaded into next recompile.",
    "Playwright E2E: magic-run UI flow validates proof metrics and task export payloads.",
    "Playwright E2E: deployment split checks enforce Replit/Vercel route expectations.",
  ];

  const rollout = [
    "Feature flag MAGIC_RUN_V2=true for internal dogfood.",
    "Enable for 10% of sessions; monitor pass rate and latency.",
    "Promote to 100% once median run latency and quality thresholds are met.",
    "Keep rollback path to legacy /api/v1/masterpiece/pipeline/run.",
  ];

  return {
    productName,
    objective: userGoal,
    stack,
    constraints,
    selectedRepos: deterministicRepoSort(selectedRepos).slice(0, 8),
    confidence: Math.round(confidence * 1000) / 1000,
    assumptions,
    evidence,
    executable: {
      filePlan,
      apiContracts,
      dbMigrations,
      testPlan,
      rollout,
    },
  };
}

function evaluateBlueprint(blueprint) {
  const executable = blueprint?.executable || {};
  const hasContractParity =
    (executable.testPlan || []).some((x) => /contract parity|route contract|api contract/i.test(String(x)))
    || (executable.filePlan || []).some((x) => /contract-parity|contract parity/i.test(String(x?.path || x?.purpose || "")));
  const scores = {
    feasibility: executable.filePlan?.length ? 0.82 : 0.35,
    complexity: executable.apiContracts?.length ? 0.78 : 0.4,
    risk: executable.rollout?.length ? 0.75 : 0.42,
    costTime: Array.isArray(blueprint?.selectedRepos) && blueprint.selectedRepos.length >= 3 ? 0.74 : 0.45,
    dependencyCompleteness: executable.dbMigrations?.length && executable.testPlan?.length ? 0.81 : 0.46,
    contractParity: hasContractParity ? 0.82 : 0.35,
  };
  const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length;
  return {
    scores,
    score: Math.round(avg * 1000) / 1000,
    pass: avg >= 0.72,
  };
}

function buildExecutionBridge(blueprint) {
  const tasks = [
    {
      priority: 1,
      owner: "backend",
      title: "Implement magic-run deterministic orchestrator",
      estimateHours: 6,
      dependencies: [],
      acceptance_criteria: [
        "Endpoint exists and returns deterministic plan hash.",
        "Run completes in target latency envelope.",
      ],
    },
    {
      priority: 2,
      owner: "backend",
      title: "Implement quality gate + auto-repair",
      estimateHours: 5,
      dependencies: ["Implement magic-run deterministic orchestrator"],
      acceptance_criteria: [
        "Plans below threshold return remediation and repaired output.",
        "Evaluation scores attached to every plan response.",
      ],
    },
    {
      priority: 3,
      owner: "backend",
      title: "Enforce frontend-backend API contract parity checks",
      estimateHours: 5,
      dependencies: ["Implement quality gate + auto-repair"],
      acceptance_criteria: [
        "Automated scan detects frontend API endpoints without backend route coverage.",
        "Known alias mismatches are reported with suggested route mappings.",
      ],
    },
    {
      priority: 3,
      owner: "frontend",
      title: "Add interactive plan editor with diff",
      estimateHours: 8,
      dependencies: ["Implement quality gate + auto-repair"],
      acceptance_criteria: [
        "Users can edit budget/deadline/team-size and recompile.",
        "Diff view highlights changed phases and tasks.",
      ],
    },
    {
      priority: 4,
      owner: "platform",
      title: "Persist project memory and replay in subsequent runs",
      estimateHours: 6,
      dependencies: ["Implement magic-run deterministic orchestrator"],
      acceptance_criteria: [
        "Project memory API returns prior decisions and rejected options.",
        "Recompile endpoint consumes memory automatically.",
      ],
    },
    {
      priority: 5,
      owner: "qa",
      title: "Add Playwright E2E suite for magic-run + recompile",
      estimateHours: 6,
      dependencies: [
        "Implement magic-run deterministic orchestrator",
        "Add interactive plan editor with diff",
      ],
      acceptance_criteria: [
        "tests/e2e/magic-run.spec.ts passes in CI and local run.",
        "E2E asserts timeToFirstWowMs, planHash, and qualityScore are rendered.",
      ],
    },
    {
      priority: 5,
      owner: "qa",
      title: "Add deployment-target E2E coverage for Replit and Vercel flows",
      estimateHours: 4,
      dependencies: [
        "Add Playwright E2E suite for magic-run + recompile",
      ],
      acceptance_criteria: [
        "tests/e2e/deploy-targets.spec.ts validates Replit workflow command and Vercel API route contract.",
        "Failure output includes actionable diff for target mismatch.",
      ],
    },
  ];
  return {
    tasks,
    acceptance_summary: {
      total_tasks: tasks.length,
      must_pass: tasks.filter((t) => t.priority <= 2).length,
    },
    exports: {
      jira: {
        issues: tasks.map((t) => ({
          summary: t.title,
          description: `Owner: ${t.owner}\nEstimate: ${t.estimateHours}h\nDependencies: ${(t.dependencies || []).join(", ") || "none"}\nAcceptance:\n- ${t.acceptance_criteria.join("\n- ")}`,
          labels: ["magic-run", "execution-bridge", `owner-${t.owner}`],
          priority: t.priority <= 2 ? "High" : "Medium",
        })),
      },
      linear: {
        tasks: tasks.map((t) => ({
          title: t.title,
          description: `Estimate: ${t.estimateHours}h\nDependencies: ${(t.dependencies || []).join(", ") || "none"}`,
          assigneeTeam: t.owner,
          priority: t.priority,
          acceptanceCriteria: t.acceptance_criteria,
        })),
      },
      github: {
        issues: tasks.map((t) => ({
          title: `[P${t.priority}] ${t.title}`,
          body: [
            `Owner: ${t.owner}`,
            `Estimate: ${t.estimateHours}h`,
            `Dependencies: ${(t.dependencies || []).join(", ") || "none"}`,
            "",
            "## Acceptance Criteria",
            ...t.acceptance_criteria.map((x) => `- [ ] ${x}`),
          ].join("\n"),
          labels: ["magic-run", `owner:${t.owner}`],
        })),
      },
    },
    derived_from: {
      productName: blueprint?.productName || null,
      confidence: blueprint?.confidence || null,
    },
  };
}

function getCache(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MAGIC_RUN_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(cache, key, value) {
  cache.set(key, { at: Date.now(), value });
}

function topViralBenchmarkSeeds(limit = 12) {
  const repos = loadBuiltinRepoIndex();
  return repos
    .filter((r) => Array.isArray(r.categories) && r.categories.includes("viral_oss_benchmark"))
    .sort((a, b) => Number(b.stars || b.stargazers_count || 0) - Number(a.stars || a.stargazers_count || 0))
    .slice(0, limit)
    .map((r) => normalizeRepoForScoring(r));
}

function buildDecisionCitations({ selectedRepos, evidence }) {
  const githubTop = Array.isArray(evidence?.github) ? evidence.github.slice(0, 5) : [];
  const redditTop = Array.isArray(evidence?.reddit) ? evidence.reddit.slice(0, 5) : [];
  return {
    repo_selection: selectedRepos.map((r) => ({
      repo: r.full_name,
      citations: [
        ...githubTop.slice(0, 2).map((x) => ({ type: "github", title: x.title, url: x.url })),
        ...redditTop.slice(0, 1).map((x) => ({ type: "reddit", title: x.title, url: x.url })),
      ],
    })),
    risk_and_rollout: [
      ...githubTop.slice(0, 2).map((x) => ({ type: "github", title: x.title, url: x.url })),
      ...redditTop.slice(0, 2).map((x) => ({ type: "reddit", title: x.title, url: x.url })),
    ],
  };
}

const CitationSchema = z.object({
  type: z.enum(["github", "reddit"]),
  title: z.string().min(3),
  url: z.string().url(),
});

const ExecutionTaskSchema = z.object({
  priority: z.number().int().min(1).max(5),
  owner: z.string().min(2),
  title: z.string().min(4),
  estimateHours: z.number().min(0.5).max(200),
  dependencies: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string().min(4)).min(1),
});

const BlueprintSchema = z.object({
  productName: z.string().min(2),
  objective: z.string().min(10),
  stack: z.array(z.string().min(1)).min(1),
  selectedRepos: z.array(z.object({ full_name: z.string() })).min(1),
  confidence: z.number().min(0).max(1),
  assumptions: z.array(z.string()).min(1),
  executable: z.object({
    filePlan: z.array(z.object({ path: z.string().min(3), purpose: z.string().min(3) })).min(1),
    apiContracts: z.array(z.object({ method: z.string().min(3), path: z.string().min(3), body: z.string().min(1) })).min(1),
    dbMigrations: z.array(z.string().min(10)).min(1),
    testPlan: z.array(z.string().min(6)).min(1),
    rollout: z.array(z.string().min(6)).min(1),
  }),
  decisionCitations: z.object({
    repo_selection: z.array(z.object({
      repo: z.string(),
      citations: z.array(CitationSchema).min(1),
    })).min(1),
    risk_and_rollout: z.array(CitationSchema).min(1),
  }),
});

async function checkGithubToken(token) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, detail: "missing_token" };
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${t}`,
        "User-Agent": "inayanbuilderbot-onboard",
      },
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, detail: `github_http_${res.status}:${txt.slice(0, 180)}` };
    }
    const data = await res.json();
    const remaining = Number(data?.rate?.remaining ?? -1);
    return { ok: true, detail: `ok_remaining_${remaining}` };
  } catch (err) {
    return { ok: false, detail: String(err?.message || err).slice(0, 180) };
  }
}

async function checkPostgresTcp({ host, port, timeoutMs = 3000 }) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => close({ ok: true, detail: "tcp_connect_ok" }));
    socket.once("timeout", () => close({ ok: false, detail: "tcp_timeout" }));
    socket.once("error", (err) => close({ ok: false, detail: String(err?.message || err).slice(0, 180) }));
  });
}

function readOpenClawScripts(clawArchitectRoot) {
  try {
    const pkgPath = path.join(clawArchitectRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const scripts = pkg && typeof pkg.scripts === "object" ? pkg.scripts : {};
    return Object.keys(scripts);
  } catch {
    return [];
  }
}

function detectOpenClawCapabilities(clawArchitectRoot) {
  const rootExists = fs.existsSync(clawArchitectRoot);
  const scripts = rootExists ? readOpenClawScripts(clawArchitectRoot) : [];
  const has = (name) => scripts.includes(name);
  return {
    mode: rootExists ? "connected" : "disconnected",
    rootExists,
    clawArchitectRoot,
    scriptsAvailable: scripts.length,
    canIndexSync: has("index:sync:agent"),
    canReadinessPulse: has("repo:readiness:pulse"),
    canDashboardScout: has("dashboard:repo:scout"),
    scriptNames: scripts
      .filter((s) => /index:sync:agent|repo:readiness:pulse|dashboard:repo:scout/.test(s))
      .sort(),
  };
}

function authMiddleware(apiKey) {
  return (req, res, next) => {
    if (!apiKey) return next();
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token || token !== apiKey) return res.status(401).json({ ok: false, error: "unauthorized" });
    return next();
  };
}

async function githubSearch({ query, perPage, githubToken }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "inayanbuilderbot-masterpiece",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.max(1, Math.min(30, perPage))}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`github_search_failed:${r.status}:${body.slice(0, 200)}`);
  }
  const data = await r.json();
  return Array.isArray(data.items) ? data.items : [];
}

async function githubIssueSearch({ query, perPage, githubToken }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "inayanbuilderbot-masterpiece",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const q = `${query} in:title,body is:issue -is:pr`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=comments&order=desc&per_page=${Math.max(1, Math.min(30, perPage))}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`github_issue_search_failed:${r.status}:${body.slice(0, 200)}`);
  }
  const data = await r.json();
  return Array.isArray(data.items) ? data.items : [];
}

function extractCodeSnippetsFromMarkdown(markdown, maxSnippets = 2, maxChars = 420) {
  const text = String(markdown || "");
  const blocks = [];
  const regex = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  let match = regex.exec(text);
  while (match && blocks.length < maxSnippets) {
    const body = String(match[1] || "").trim();
    if (body) blocks.push(body.slice(0, maxChars));
    match = regex.exec(text);
  }
  return blocks;
}

function clipText(value, max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function scoreGithubAnswer(item, queryTokens = []) {
  const title = String(item?.title || "");
  const body = String(item?.body || "");
  const text = `${title}\n${body}`.toLowerCase();
  const termHits = queryTokens.filter((t) => text.includes(t)).length;
  const comments = Number(item?.comments || 0);
  const reactions = Number(item?.reactions?.total_count || 0);
  const freshnessDays = Math.max(
    0,
    (Date.now() - (Date.parse(item?.updated_at || item?.created_at || 0) || 0)) / 86400000
  );
  const freshness = Math.max(0, 18 - Math.min(18, freshnessDays / 14));
  const score = Math.round((Math.log10(Math.max(1, comments + 1)) * 28 + Math.log10(Math.max(1, reactions + 1)) * 24 + termHits * 8 + freshness) * 100) / 100;
  return {
    rank_score: score,
    matched_terms: queryTokens.filter((t) => text.includes(t)).slice(0, 10),
  };
}

async function runGithubResearch({
  query,
  perPage = 20,
  maxResults = 40,
  githubToken,
}) {
  const queryTokens = [...new Set(tokenizeSearchText(query))].slice(0, 24);
  const [reposResult, issuesResult] = await Promise.allSettled([
    githubSearch({ query, perPage, githubToken }),
    githubIssueSearch({ query, perPage, githubToken }),
  ]);

  const repos = reposResult.status === "fulfilled" ? reposResult.value : [];
  const issues = issuesResult.status === "fulfilled" ? issuesResult.value : [];
  const sourceErrors = [];
  if (reposResult.status === "rejected") {
    sourceErrors.push({ source: "repo_search", error: String(reposResult.reason?.message || reposResult.reason || "repo_search_failed") });
  }
  if (issuesResult.status === "rejected") {
    sourceErrors.push({ source: "issue_search", error: String(issuesResult.reason?.message || issuesResult.reason || "issue_search_failed") });
  }
  if (!repos.length && !issues.length) {
    throw new Error(`github_research_unavailable:${sourceErrors.map((e) => e.error).join("|").slice(0, 500)}`);
  }

  const repoResults = repos.slice(0, maxResults).map((repo) => {
    const scored = scoreRepo(repo);
    return {
      full_name: repo.full_name,
      html_url: repo.html_url,
      description: clipText(repo.description || "", 360),
      stars: Number(repo.stargazers_count || 0),
      forks: Number(repo.forks_count || 0),
      language: repo.language || null,
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      uiEvidence: scored.uiEvidence,
      breakPatternEvidence: scored.breakPatternEvidence,
      breakPatternHits: scored.breakPatternHits,
      score: scored.score,
    };
  });

  const answerRows = issues
    .map((it) => {
      const s = scoreGithubAnswer(it, queryTokens);
      return {
        title: clipText(it.title || "", 220),
        html_url: it.html_url || "",
        repository_url: it.repository_url || "",
        comments: Number(it.comments || 0),
        updated_at: it.updated_at || null,
        rank_score: s.rank_score,
        matched_terms: s.matched_terms,
        code_snippets: extractCodeSnippetsFromMarkdown(it.body || "", 2, 420),
      };
    })
    .sort((a, b) => Number(b.rank_score || 0) - Number(a.rank_score || 0))
    .slice(0, maxResults);

  return {
    summary: {
      generated_at: new Date().toISOString(),
      query,
      repo_hits: repoResults.length,
      answer_hits: answerRows.length,
      top_terms: queryTokens,
      source_errors: sourceErrors,
      github_token_configured: Boolean(githubToken),
    },
    repos: repoResults,
    answers: answerRows,
  };
}

function computeUiEvidence(repo) {
  const text = `${repo.name || ""} ${repo.description || ""} ${(repo.topics || []).join(" ")} ${(repo.signals || []).join(" ")} ${(repo.categories || []).join(" ")}`.toLowerCase();
  const checks = [
    ["dashboard", 3],
    ["chat", 3],
    ["chat ui", 3],
    ["webui", 3],
    ["agent ui", 3],
    ["web ui", 2],
    ["admin", 2],
    ["multi-provider", 2],
    ["self-hosted", 2],
    ["mcp", 2],
    ["conversation", 1],
    ["session", 1],
    ["streaming", 1],
    ["nextjs", 1],
    ["react", 1],
    ["workflow", 1],
  ];
  let evidence = 0;
  const hits = [];
  for (const [term, weight] of checks) {
    if (text.includes(term)) {
      evidence += weight;
      hits.push(term);
    }
  }
  return { evidence, hits };
}

function computeBreakPatternEvidence(repo) {
  const text = `${repo.full_name || ""} ${repo.name || ""} ${repo.description || ""} ${(repo.topics || []).join(" ")} ${(repo.signals || []).join(" ")} ${(repo.categories || []).join(" ")}`.toLowerCase();
  const checks = [
    ["stripe webhook", 4],
    ["stripe-signature", 4],
    ["x-stripe-signature", 4],
    ["constructevent", 4],
    ["webhook signature", 3],
    ["signature verification", 3],
    ["raw body", 2],
    ["idempotency", 3],
    ["replay attack", 2],
    ["contract test", 2],
    ["supertest", 2],
    ["playwright", 2],
    ["api parity", 3],
    ["route map", 2],
    ["admin api", 2],
    ["onboarding", 1],
    ["ticketing", 1],
    ["rollback", 1],
  ];
  let evidence = 0;
  const hits = [];
  for (const [term, weight] of checks) {
    if (text.includes(term)) {
      evidence += weight;
      hits.push(term);
    }
  }
  return { evidence, hits };
}

function normalizeContractPath(value) {
  const raw = String(value || "").trim();
  if (!raw || !raw.startsWith("/")) return "";
  let p = raw.split("?")[0].split("#")[0];
  p = p.replace(/\/\$\{[^/]+\}/g, "/:param");
  p = p.replace(/\/\[[^\]/]+\]/g, "/:param");
  p = p.replace(/\/:[A-Za-z0-9_]+/g, "/:param");
  p = p.replace(/\/+/g, "/");
  p = p.replace(/\/$/, "");
  return p || "/";
}

function walkRepoFiles(repoPath, { maxFiles = 5000, maxFileBytes = 1024 * 1024 } = {}) {
  const files = [];
  const stack = [repoPath];
  const ignoredDirs = new Set([
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".cache",
    ".vercel",
  ]);
  const allowedExtensions = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".html"]);
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > 0 && st.size <= maxFileBytes) files.push(full);
      } catch {
        // Skip unreadable files.
      }
    }
  }
  return files;
}

function extractFrontendApiEndpoints(text) {
  const out = new Set();
  const source = String(text || "");
  const fetchRegex = /fetch\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const axiosRegex = /\b(?:axios|client)\.(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const genericRegex = /["'`](\/api\/[^"'`]+)["'`]/g;
  for (const regex of [fetchRegex, axiosRegex, genericRegex]) {
    let match = regex.exec(source);
    while (match) {
      const normalized = normalizeContractPath(match[1]);
      if (normalized.startsWith("/api/")) out.add(normalized);
      match = regex.exec(source);
    }
  }
  return out;
}

function extractBackendApiRoutes(text) {
  const out = new Set();
  const source = String(text || "");
  const routeRegex = /\b(?:app|router)\.(?:get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let match = routeRegex.exec(source);
  while (match) {
    const normalized = normalizeContractPath(match[1]);
    if (normalized.startsWith("/api/")) out.add(normalized);
    match = routeRegex.exec(source);
  }
  return out;
}

function findAliasBackendRoute(frontendPath, backendRoutes) {
  const aliases = [
    frontendPath.replace(/\/ticket(\/|$)/g, "/tickets$1"),
    frontendPath.replace(/\/tickets(\/|$)/g, "/ticket$1"),
    frontendPath.replace(/\/admin\//g, "/"),
    frontendPath.replace(/\/:param/g, "/:id"),
  ]
    .map((x) => normalizeContractPath(x))
    .filter(Boolean);
  for (const alias of aliases) {
    if (backendRoutes.has(alias)) return alias;
  }
  return null;
}

function analyzeRepoContractGap({ repoPath, maxFiles = 5000, maxFileBytes = 1024 * 1024 }) {
  const files = walkRepoFiles(repoPath, { maxFiles, maxFileBytes });
  const frontend = new Set();
  const backend = new Set();
  const frontendFiles = [];
  const backendFiles = [];

  for (const file of files) {
    const rel = path.relative(repoPath, file);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fHits = extractFrontendApiEndpoints(text);
    if (fHits.size > 0) {
      frontendFiles.push(rel);
      for (const x of fHits) frontend.add(x);
    }
    const bHits = extractBackendApiRoutes(text);
    if (bHits.size > 0) {
      backendFiles.push(rel);
      for (const x of bHits) backend.add(x);
    }
  }

  const missingBackend = [];
  const probableAliasMatches = [];
  for (const endpoint of [...frontend].sort()) {
    if (backend.has(endpoint)) continue;
    const alias = findAliasBackendRoute(endpoint, backend);
    if (alias) {
      probableAliasMatches.push({ frontend: endpoint, backendAlias: alias });
      continue;
    }
    missingBackend.push(endpoint);
  }

  const coverage = frontend.size
    ? Math.max(0, Math.min(1, (frontend.size - missingBackend.length) / frontend.size))
    : 1;

  return {
    scannedFiles: files.length,
    frontendFiles: frontendFiles.length,
    backendFiles: backendFiles.length,
    frontendEndpoints: [...frontend].sort(),
    backendRoutes: [...backend].sort(),
    missingBackend,
    probableAliasMatches,
    coverageScore: Math.round(coverage * 1000) / 1000,
    coveragePct: Math.round(coverage * 10000) / 100,
  };
}

function scoreRepo(repo) {
  const stars = Number(repo.stargazers_count || repo.stars || 0);
  const forks = Number(repo.forks_count || repo.forks || 0);
  const updatedAt = Date.parse(repo.pushed_at || 0);
  const recencyDays = Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 86400000) : 9999;
  const recencyScore = Math.max(0, 25 - Math.min(25, recencyDays / 10));
  const ui = computeUiEvidence(repo);
  const breakPatterns = computeBreakPatternEvidence(repo);

  const text = `${repo.name || ""} ${repo.description || ""} ${(repo.topics || []).join(" ")}`.toLowerCase();
  const frameworkOnly = /(sdk|framework|runtime|toolkit|library|engine|starter|template)/i.test(text)
    && ui.evidence < 6
    && !/(dashboard|webui|chat ui|chatbot|admin ui|self-hosted)/i.test(text);

  const score =
    Math.log10(Math.max(1, stars)) * 42 +
    Math.log10(Math.max(1, forks + 1)) * 10 +
    recencyScore +
    ui.evidence * 4 -
    (frameworkOnly ? 22 : 0) +
    breakPatterns.evidence * 2.2;

  return {
    score: Math.round(score * 100) / 100,
    uiEvidence: ui.evidence,
    uiHits: ui.hits,
    breakPatternEvidence: breakPatterns.evidence,
    breakPatternHits: breakPatterns.hits,
    frameworkOnly,
  };
}

function benchmarkRepos(repos, weightUi = 0.58, weightPopularity = 0.42) {
  const maxStars = Math.max(...repos.map((r) => Number(r.stars || r.stargazers_count || 0)), 1);
  const maxBreakPatternEvidence = Math.max(...repos.map((r) => Number(r.breakPatternEvidence || 0)), 1);
  return repos
    .map((r) => {
      const uiNorm = Math.min(1, Number(r.uiEvidence || 0) / 14);
      const popNorm = Number(r.stars || r.stargazers_count || 0) / maxStars;
      const breakPatternNorm = Number(r.breakPatternEvidence || 0) / maxBreakPatternEvidence;
      const breakPatternWeight = 0.16;
      const benchmarkScore = Math.round(
        (uiNorm * (weightUi * (1 - breakPatternWeight))
          + popNorm * (weightPopularity * (1 - breakPatternWeight))
          + breakPatternNorm * breakPatternWeight) * 10000
      ) / 100;
      return { ...r, benchmarkScore };
    })
    .sort((a, b) => b.benchmarkScore - a.benchmarkScore);
}

function runBuiltinAdvancedIndexing({ repos, queries, minStars, topK }) {
  const candidates = Array.isArray(repos) ? repos : [];
  const scored = candidates
    .map((repo) => {
      const base = scoreRepo({
        full_name: repo.full_name,
        name: repo.name,
        description: repo.description,
        stargazers_count: repo.stars || repo.stargazers_count,
        forks_count: repo.forks || repo.forks_count,
        pushed_at: repo.pushed_at,
        topics: repo.topics || [],
      });
      const provenanceBonus = Array.isArray(repo.uiHits) && repo.uiHits.length >= 2 ? 4 : 0;
      return {
        ...repo,
        indexScore: Math.round((base.score + provenanceBonus) * 100) / 100,
        breakPatternEvidence: base.breakPatternEvidence,
        breakPatternHits: base.breakPatternHits,
        frameworkOnly: base.frameworkOnly,
      };
    })
    .filter((repo) => !repo.frameworkOnly)
    .sort((a, b) => Number(b.indexScore || 0) - Number(a.indexScore || 0));

  const shortlisted = scored
    .filter((repo) => Number(repo.uiEvidence || 0) >= 5)
    .slice(0, Math.max(6, Math.min(20, topK * 2)));

  const benchmarked = benchmarkRepos(shortlisted, 0.62, 0.38).slice(0, Math.max(6, topK));
  return {
    mode: "builtin",
    criteria: {
      queries,
      minStars,
      topK,
      mustHaveUiEvidenceAtLeast: 5,
      excludeFrameworkOnly: true,
    },
    indexedCount: scored.length,
    shortlistedCount: shortlisted.length,
    benchmarkedCount: benchmarked.length,
    benchmarkedTop: benchmarked.slice(0, Math.min(8, benchmarked.length)).map((r) => ({
      full_name: r.full_name,
      benchmarkScore: r.benchmarkScore,
      uiEvidence: r.uiEvidence,
      stars: r.stars || r.stargazers_count || 0,
    })),
  };
}

function normalizeRepoForScoring(repo) {
  return {
    full_name: repo.full_name,
    name: repo.name || String(repo.full_name || "").split("/").pop() || "",
    html_url: repo.html_url,
    description: repo.description || "",
    stargazers_count: Number(repo.stargazers_count || repo.stars || 0),
    forks_count: Number(repo.forks_count || repo.forks || 0),
    language: repo.language || null,
    pushed_at: repo.pushed_at || null,
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    signals: Array.isArray(repo.signals) ? repo.signals : [],
    categories: Array.isArray(repo.categories) ? repo.categories : [],
  };
}

function tokenizeQueries(queries = []) {
  const stop = new Set(["and", "or", "the", "for", "with", "that", "from", "this", "have", "into", "your", "agent", "repo", "repos"]);
  const tokens = [];
  for (const q of Array.isArray(queries) ? queries : []) {
    for (const t of String(q || "").toLowerCase().split(/[^a-z0-9+.-]+/g)) {
      if (t.length < 3 || stop.has(t)) continue;
      tokens.push(t);
    }
  }
  return [...new Set(tokens)];
}

function loadBuiltinRepoIndex() {
  const payload = readJsonSafe(builtinRepoIndexFile);
  return Array.isArray(payload?.repos) ? payload.repos : [];
}

function queryBuiltinRepoIndex({ queries, minStars = 500, topK = 12 }) {
  const repos = loadBuiltinRepoIndex();
  if (!repos.length) return [];

  const queryTokens = tokenizeQueries(queries);
  const ranked = repos
    .map((repo) => {
      const normalized = normalizeRepoForScoring(repo);
      const base = scoreRepo(normalized);
      const haystack = `${normalized.full_name} ${normalized.description} ${normalized.topics.join(" ")} ${normalized.signals.join(" ")} ${normalized.categories.join(" ")}`.toLowerCase();
      const queryMatches = queryTokens.filter((t) => haystack.includes(t)).length;
      const provenUi = normalized.signals.includes("proven_dashboard_chat_ui") ? 5 : 0;
      const mcpBonus = normalized.signals.includes("mcp") ? 2 : 0;
      const score = Math.round((base.score + queryMatches * 3.5 + provenUi + mcpBonus) * 100) / 100;
      return {
        ...normalized,
        stars: normalized.stargazers_count,
        forks: normalized.forks_count,
        score,
        uiEvidence: base.uiEvidence,
        uiHits: base.uiHits,
        frameworkOnly: base.frameworkOnly,
      };
    })
    .filter((repo) => repo.stargazers_count >= minStars)
    .filter((repo) => !repo.frameworkOnly && repo.uiEvidence >= 5)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, Math.max(topK * 3, 24));
}

async function discoverScoutRepos({ queries, perQuery, minStars, topK, seedRepos, githubToken }) {
  if (Array.isArray(seedRepos) && seedRepos.length > 0) return seedRepos;

  const discovered = queryBuiltinRepoIndex({ queries, minStars, topK });
  const minNeeded = Math.max(topK, Math.min(30, perQuery * Math.max(1, queries.length)));
  if (discovered.length >= minNeeded) return discovered;

  for (const q of queries) {
    try {
      const items = await githubSearch({ query: q, perPage: perQuery, githubToken });
      discovered.push(...items);
    } catch {
      // Keep pipeline resilient when GitHub API is unavailable/rate-limited.
    }
  }
  return discovered;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function extractLatestRedditReport({ latestPipeline, latestRedditRun }) {
  if (latestRedditRun?.output && Array.isArray(latestRedditRun.output.results)) return latestRedditRun.output;
  if (latestPipeline?.output?.reddit && Array.isArray(latestPipeline.output.reddit.results)) return latestPipeline.output.reddit;
  return null;
}

function roundNumber(value, decimals = 3) {
  const n = Number(value || 0);
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

function buildWeightedRedditEvidence(redditReport, maxItems = 10) {
  const results = Array.isArray(redditReport?.results) ? redditReport.results : [];
  const sourceErrors = Array.isArray(redditReport?.summary?.source_errors) ? redditReport.summary.source_errors : [];
  const sourceReliable = sourceErrors.length === 0;

  const weighted = results
    .map((r) => {
      const rank = Math.max(0, Number(r.rank_score || 0));
      const matchedTerms = Array.isArray(r.matched_terms) ? r.matched_terms : [];
      const termCoverage = Math.min(0.35, matchedTerms.length * 0.06);
      const sourceFactor = sourceReliable ? 1 : 0.82;
      const baseWeight = Math.min(1.25, rank / 100) * sourceFactor + termCoverage;
      const validated = Boolean(r.permalink || r.url)
        && !Boolean(r.over_18)
        && rank >= 28
        && (sourceReliable || rank >= 48);
      return {
        title: clipText(r.title || "", 220),
        subreddit: r.subreddit || null,
        permalink: r.permalink || r.url || null,
        rank_score: roundNumber(rank, 2),
        matched_terms: matchedTerms.slice(0, 12),
        relevance_weight: roundNumber(Math.max(0, Math.min(1.5, baseWeight)), 3),
        validated,
      };
    })
    .filter((r) => r.title && r.permalink)
    .sort((a, b) => Number(b.relevance_weight || 0) - Number(a.relevance_weight || 0))
    .slice(0, maxItems);

  const validatedCount = weighted.filter((w) => w.validated).length;
  const meanWeight = weighted.length
    ? roundNumber(weighted.reduce((sum, w) => sum + Number(w.relevance_weight || 0), 0) / weighted.length, 3)
    : 0;

  return {
    weighted,
    summary: {
      source_reliable: sourceReliable,
      source_error_count: sourceErrors.length,
      indexed_posts: Number(redditReport?.summary?.indexed_posts || 0),
      weighted_count: weighted.length,
      validated_count: validatedCount,
      mean_relevance_weight: meanWeight,
    },
  };
}

function buildFusionLeaderboard({
  benchmarkRepos,
  githubReport,
  redditReport,
  topK = 10,
}) {
  const repos = Array.isArray(benchmarkRepos) ? benchmarkRepos : [];
  const githubRepos = Array.isArray(githubReport?.repos) ? githubReport.repos : [];
  const githubAnswers = Array.isArray(githubReport?.answers) ? githubReport.answers : [];
  const redditWeighted = buildWeightedRedditEvidence(redditReport, 20).weighted;

  const ghRepoMap = new Map(
    githubRepos.map((r) => [String(r.full_name || "").toLowerCase(), r]).filter(([k]) => Boolean(k))
  );

  const githubTermWeights = new Map();
  for (const a of githubAnswers) {
    const w = Math.max(0, Number(a.rank_score || 0)) / 100;
    for (const t of Array.isArray(a.matched_terms) ? a.matched_terms : []) {
      githubTermWeights.set(t, (githubTermWeights.get(t) || 0) + w);
    }
  }

  const redditTermWeights = new Map();
  for (const s of redditWeighted) {
    const w = Math.max(0, Number(s.relevance_weight || 0));
    for (const t of Array.isArray(s.matched_terms) ? s.matched_terms : []) {
      redditTermWeights.set(t, (redditTermWeights.get(t) || 0) + w);
    }
  }

  const leaderboard = repos.map((repo) => {
    const key = String(repo.full_name || "").toLowerCase();
    const text = `${repo.full_name || ""} ${repo.name || ""} ${repo.description || ""} ${(repo.topics || []).join(" ")}`.toLowerCase();
    const tokens = [...new Set(tokenizeSearchText(text))];

    const baseBenchmark = Math.max(0, Number(repo.benchmarkScore || 0));
    const indexSignal = Math.max(0, Number(repo.score || 0)) / 5;
    const uiSignal = Math.max(0, Number(repo.uiEvidence || 0)) * 1.8;
    const breakPatternSignal = Math.min(12, Math.max(0, Number(repo.breakPatternEvidence || 0)) * 1.4);

    const ghRepo = ghRepoMap.get(key);
    const githubRepoBoost = ghRepo
      ? Math.min(14, Math.max(1, Number(ghRepo.score || 0) / 18))
      : 0;
    const githubTermAlignment = Math.min(
      12,
      tokens.reduce((sum, t) => sum + Number(githubTermWeights.get(t) || 0), 0)
    );
    const redditTermAlignment = Math.min(
      14,
      tokens.reduce((sum, t) => sum + Number(redditTermWeights.get(t) || 0), 0)
    );

    const fusionScore = roundNumber(
      baseBenchmark * 0.58
      + indexSignal * 0.14
      + uiSignal * 0.1
      + breakPatternSignal * 0.08
      + githubRepoBoost * 0.08
      + githubTermAlignment * 0.04
      + redditTermAlignment * 0.06,
      2
    );

    const reasons = [];
    if (baseBenchmark >= 60) reasons.push("strong benchmark score");
    if (Number(repo.uiEvidence || 0) >= 8) reasons.push("high dashboard/chat UI evidence");
    if (Number(repo.breakPatternEvidence || 0) >= 4) reasons.push("strong webhook/security break-pattern coverage");
    if (githubRepoBoost >= 4) reasons.push("validated by GitHub repo research");
    if (githubTermAlignment >= 3) reasons.push("aligned with high-signal GitHub answer terms");
    if (redditTermAlignment >= 3) reasons.push("aligned with validated Reddit build signals");
    if (!reasons.length) reasons.push("solid baseline benchmark and index profile");

    return {
      full_name: repo.full_name,
      benchmarkScore: roundNumber(baseBenchmark, 2),
      fusionScore,
      breakdown: {
        baseBenchmark: roundNumber(baseBenchmark * 0.58, 2),
        indexSignal: roundNumber(indexSignal * 0.14, 2),
        uiSignal: roundNumber(uiSignal * 0.1, 2),
        breakPatternSignal: roundNumber(breakPatternSignal * 0.08, 2),
        githubRepoBoost: roundNumber(githubRepoBoost * 0.08, 2),
        githubTermAlignment: roundNumber(githubTermAlignment * 0.04, 2),
        redditTermAlignment: roundNumber(redditTermAlignment * 0.06, 2),
      },
      reasons,
    };
  }).sort((a, b) => Number(b.fusionScore || 0) - Number(a.fusionScore || 0))
    .slice(0, topK);

  return {
    generated_at: new Date().toISOString(),
    summary: {
      input_benchmark_count: repos.length,
      github_repo_hits: githubRepos.length,
      github_answer_hits: githubAnswers.length,
      reddit_weighted_hits: redditWeighted.length,
      leaderboard_count: leaderboard.length,
    },
    leaderboard,
  };
}

function collectRepoIntelContext({ latestPipeline, allRuns, clawArchitectRoot }) {
  const latestScout = allRuns.find((r) => r.type === "scout");
  const latestBench = allRuns.find((r) => r.type === "benchmark");
  const latestReddit = allRuns.find((r) => r.type === "reddit_research");
  const latestGithubResearch = allRuns.find((r) => r.type === "github_research");
  const latestFusion = allRuns.find((r) => r.type === "fusion_research");
  const latestRedditReport = extractLatestRedditReport({ latestPipeline, latestRedditRun: latestReddit });
  const redditWeighted = buildWeightedRedditEvidence(latestRedditReport, 10);

  const pipelineRepos = Array.isArray(latestPipeline?.output?.blueprint?.selectedRepos)
    ? latestPipeline.output.blueprint.selectedRepos.map((r) => r.full_name).slice(0, 8)
    : [];
  const scoutRepos = Array.isArray(latestScout?.output)
    ? latestScout.output.map((r) => r.full_name).slice(0, 8)
    : [];
  const benchRepos = Array.isArray(latestBench?.output)
    ? latestBench.output.map((r) => ({ full_name: r.full_name, benchmarkScore: r.benchmarkScore })).slice(0, 8)
    : [];

  const externalIntel = {
    dashboard_scout_top: [],
    readiness_weakest: [],
  };

  const scoutPath = path.join(clawArchitectRoot, "scripts", "reports", "dashboard-chatbot-repo-scout-latest.json");
  const readinessPath = path.join(clawArchitectRoot, "scripts", "reports", "repo-readiness-pulse-latest.json");

  const externalScout = readJsonSafe(scoutPath);
  if (Array.isArray(externalScout?.top_selected)) {
    externalIntel.dashboard_scout_top = externalScout.top_selected
      .slice(0, 8)
      .map((r) => ({ full_name: r.full_name, rank_score: r.rank_score, ui_score: r.ui_score }));
  }

  const externalReadiness = readJsonSafe(readinessPath);
  if (Array.isArray(externalReadiness?.repos)) {
    externalIntel.readiness_weakest = externalReadiness.repos
      .slice()
      .sort((a, b) => Number(a?.score?.total || 0) - Number(b?.score?.total || 0))
      .slice(0, 8)
      .map((r) => ({ repo: r.repo, score: r?.score?.total, reasons: r.reasons || [] }));
  }

  return {
    pipeline_top_repos: pipelineRepos,
    scout_top_repos: scoutRepos,
    benchmark_top_repos: benchRepos,
    reddit_top_signals: Array.isArray(latestRedditReport?.results)
      ? latestRedditReport.results.slice(0, 8).map((r) => ({
        title: r.title,
        subreddit: r.subreddit,
        rank_score: r.rank_score,
        permalink: r.permalink || r.url,
      }))
      : [],
    reddit_evidence_weighted: redditWeighted.weighted,
    reddit_validation_summary: redditWeighted.summary,
    github_top_answers: Array.isArray(latestGithubResearch?.output?.answers)
      ? latestGithubResearch.output.answers.slice(0, 8).map((a) => ({
        title: a.title,
        rank_score: a.rank_score,
        html_url: a.html_url,
      }))
      : [],
    fusion_top_repos: Array.isArray(latestPipeline?.output?.fusion?.leaderboard)
      ? latestPipeline.output.fusion.leaderboard.slice(0, 8)
      : Array.isArray(latestFusion?.output?.leaderboard)
        ? latestFusion.output.leaderboard.slice(0, 8)
        : [],
    external: externalIntel,
  };
}

function getLatestResearchBundle(allRuns = []) {
  const latestPipeline = allRuns.find((r) => r.type === "pipeline");
  const latestBenchmark = allRuns.find((r) => r.type === "benchmark");
  const latestGithub = allRuns.find((r) => r.type === "github_research");
  const latestReddit = allRuns.find((r) => r.type === "reddit_research");

  const benchmarkRepos = Array.isArray(latestPipeline?.output?.benchmark)
    ? latestPipeline.output.benchmark
    : Array.isArray(latestBenchmark?.output)
      ? latestBenchmark.output
      : [];
  const githubReport = latestPipeline?.output?.github || latestGithub?.output || null;
  const redditReport = latestPipeline?.output?.reddit || latestReddit?.output || null;

  return {
    latestPipeline,
    benchmarkRepos,
    githubReport,
    redditReport,
  };
}

function parseEnvList(raw) {
  return String(raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function buildRedditAuthProfiles({
  defaultUserAgent,
  explicitProfilesJson,
  userAgentsCsv,
  accessTokensCsv,
}) {
  const explicitRaw = String(explicitProfilesJson || "").trim();
  if (explicitRaw) {
    try {
      const parsed = JSON.parse(explicitRaw);
      if (Array.isArray(parsed) && parsed.length) {
        const cleaned = parsed
          .map((p, i) => ({
            id: String(p?.id || `profile_${i + 1}`),
            userAgent: String(p?.userAgent || p?.user_agent || defaultUserAgent),
            accessToken: String(p?.accessToken || p?.access_token || ""),
          }))
          .filter((p) => p.userAgent || p.accessToken);
        if (cleaned.length) return cleaned;
      }
    } catch {
      // Fall through to CSV-based profile parsing.
    }
  }

  const uas = parseEnvList(userAgentsCsv);
  const toks = parseEnvList(accessTokensCsv);
  const userAgents = uas.length ? uas : [defaultUserAgent];
  const accessTokens = toks.length ? toks : [""];
  const size = Math.max(userAgents.length, accessTokens.length);
  const profiles = [];
  for (let i = 0; i < size; i += 1) {
    profiles.push({
      id: `profile_${i + 1}`,
      userAgent: userAgents[i % userAgents.length] || defaultUserAgent,
      accessToken: accessTokens[i % accessTokens.length] || "",
    });
  }
  return profiles;
}

async function fetchTextWithTimeout(url, { timeoutMs = 12000, userAgent, accessToken } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const headers = {
      "User-Agent": userAgent || "inayanbuilderbot-reddit/1.0",
      Accept: "application/json, application/xml, text/xml;q=0.9, */*;q=0.8",
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body,
      latencyMs: Date.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: "",
      latencyMs: Date.now() - started,
      error: String(error?.message || error || "request_failed"),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, opts = {}) {
  const textRes = await fetchTextWithTimeout(url, opts);
  if (!textRes.ok) return { ...textRes, data: null };
  try {
    return { ...textRes, data: JSON.parse(textRes.body || "null") };
  } catch {
    return { ...textRes, ok: false, error: "invalid_json", data: null };
  }
}

function shouldRetryRedditWithNextProfile(result) {
  const status = Number(result?.status || 0);
  if (status === 401 || status === 403 || status === 429) return true;
  const err = String(result?.error || "").toLowerCase();
  return err.includes("abort") || err.includes("timeout") || err.includes("network");
}

async function fetchTextWithProfileFallback(url, { authProfiles, timeoutMs = 12000, sourceHealth, source }) {
  const errors = [];
  const profiles = Array.isArray(authProfiles) && authProfiles.length
    ? authProfiles
    : [{ id: "profile_1", userAgent: "inayanbuilderbot-reddit/1.0", accessToken: "" }];

  for (let i = 0; i < profiles.length; i += 1) {
    const profile = profiles[i];
    const result = await fetchTextWithTimeout(url, {
      timeoutMs,
      userAgent: profile.userAgent,
      accessToken: profile.accessToken,
    });
    sourceHealth.push({
      source,
      profileId: profile.id,
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.ok ? null : String(result.error || "request_failed"),
    });
    if (result.ok) return { ...result, profileId: profile.id, fallbackErrors: errors };
    errors.push(`${profile.id}:${result.error || `HTTP ${result.status || 0}`}`);
    if (!shouldRetryRedditWithNextProfile(result)) {
      return { ...result, profileId: profile.id, fallbackErrors: errors };
    }
    await sleep(Math.min(1000, 120 + i * 120));
  }

  return {
    ok: false,
    status: 0,
    body: "",
    latencyMs: 0,
    error: errors.join(" | ") || "all_auth_profiles_failed",
    profileId: null,
    fallbackErrors: errors,
  };
}

async function fetchJsonWithProfileFallback(url, opts) {
  const textRes = await fetchTextWithProfileFallback(url, opts);
  if (!textRes.ok) return { ...textRes, data: null };
  try {
    return { ...textRes, data: JSON.parse(textRes.body || "null") };
  } catch {
    return { ...textRes, ok: false, error: "invalid_json", data: null };
  }
}

function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml || "").split(/<item>/i).slice(1);
  for (const block of blocks) {
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) || [])[1] || "";
    const link = (block.match(/<link>(.*?)<\/link>/i) || [])[1] || "";
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/i) || [])[1] || "";
    if (title && link) items.push({ title, link, pubDate });
  }
  return items;
}

function normalizeRedditJsonPost(data) {
  return {
    id: data?.id || null,
    title: data?.title || "",
    subreddit: data?.subreddit || null,
    author: data?.author || null,
    permalink: data?.permalink ? `https://www.reddit.com${data.permalink}` : null,
    url: data?.url || null,
    selftext: data?.selftext || "",
    created_utc: Number(data?.created_utc || 0),
    score: Number(data?.score || 0),
    comments: Number(data?.num_comments || 0),
    upvote_ratio: Number(data?.upvote_ratio || 0),
    over_18: Boolean(data?.over_18),
    source: data?.source || "reddit_json",
  };
}

function normalizeRssRedditPost(item, subreddit) {
  return {
    id: null,
    title: item?.title || "",
    subreddit,
    author: null,
    permalink: item?.link || null,
    url: item?.link || null,
    selftext: "",
    created_utc: item?.pubDate ? Math.floor(Date.parse(item.pubDate) / 1000) : 0,
    score: 0,
    comments: 0,
    upvote_ratio: 0.5,
    over_18: false,
    source: "rss",
  };
}

function tokenizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9+._-]+/g)
    .filter((t) => t && t.length >= 3);
}

function rankRedditScore(post) {
  return Number(post.score || 0) + Number(post.comments || 0) * 0.25;
}

function qualityBoostReddit(post, preferredKeywords = []) {
  const txt = `${post.title || ""} ${post.selftext || ""}`.toLowerCase();
  let boost = 0;
  for (const kw of preferredKeywords) {
    if (txt.includes(String(kw || "").toLowerCase())) boost += 20;
  }
  return boost;
}

function scoreRedditPost(post, queryTokens = [], preferredKeywords = []) {
  const txt = `${post.title || ""} ${post.selftext || ""}`.toLowerCase();
  const matchedTerms = queryTokens.filter((t) => txt.includes(t));
  const freshness = post.created_utc
    ? Math.max(0, 20 - Math.min(20, (Date.now() / 1000 - post.created_utc) / (3600 * 24 * 14)))
    : 0;
  const quality = rankRedditScore(post) + qualityBoostReddit(post, preferredKeywords);
  const ratioBonus = Math.max(0, Math.min(10, Number(post.upvote_ratio || 0) * 10));
  const rank_score = Math.round(Math.max(0, quality + freshness + ratioBonus + matchedTerms.length * 8) * 100) / 100;
  return { ...post, rank_score, matched_terms: matchedTerms.slice(0, 12) };
}

async function fetchRedditSubredditWithFallback({
  subreddit,
  query,
  timeWindow,
  limitPerSubreddit,
  authProfiles,
  timeoutMs,
  sourceHealth,
}) {
  const attempts = [
    {
      source: "reddit_top",
      url: `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=${encodeURIComponent(timeWindow)}&limit=${limitPerSubreddit}&raw_json=1`,
    },
    {
      source: "old_reddit_top",
      url: `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=${encodeURIComponent(timeWindow)}&limit=${limitPerSubreddit}&raw_json=1`,
    },
    {
      source: "hot",
      url: `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=${limitPerSubreddit}&raw_json=1`,
    },
    {
      source: "new",
      url: `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=${limitPerSubreddit}&raw_json=1`,
    },
  ];

  const errors = [];
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const result = await fetchJsonWithProfileFallback(attempt.url, {
      authProfiles,
      timeoutMs,
      sourceHealth,
      source: attempt.source,
    });
    if (!result.ok) {
      errors.push(`${attempt.source}:${result.error || `HTTP ${result.status || 0}`}`);
      await sleep(Math.min(1000, 120 + i * 120));
      continue;
    }
    const children = Array.isArray(result?.data?.data?.children) ? result.data.data.children : [];
    const posts = children
      .map((c) => normalizeRedditJsonPost({ ...(c?.data || {}), source: attempt.source }))
      .filter((p) => p.title);
    if (posts.length) {
      return { ok: true, source: attempt.source, status: result.status, posts, errors };
    }
    errors.push(`${attempt.source}:empty`);
  }

  const rssUrl = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=${encodeURIComponent(timeWindow)}`;
  const rss = await fetchTextWithProfileFallback(rssUrl, {
    authProfiles,
    timeoutMs,
    sourceHealth,
    source: "rss",
  });
  if (!rss.ok) {
    errors.push(`rss:${rss.error || `HTTP ${rss.status || 0}`}`);
    return { ok: false, source: "none", status: rss.status || 0, posts: [], errors };
  }

  const items = parseRssItems(rss.body).slice(0, limitPerSubreddit);
  if (!items.length) {
    errors.push("rss:empty");
    return { ok: false, source: "none", status: rss.status || 0, posts: [], errors };
  }

  return {
    ok: true,
    source: "rss",
    status: rss.status,
    posts: items.map((it) => normalizeRssRedditPost(it, subreddit)),
    errors,
  };
}

async function runRedditResearch({
  query,
  subreddits,
  limitPerSubreddit,
  timeWindow,
  maxResults,
  redditUserAgent,
  redditAuthProfiles,
  redditRequestTimeoutMs,
}) {
  const sourceHealth = [];
  const authProfiles = Array.isArray(redditAuthProfiles) && redditAuthProfiles.length
    ? redditAuthProfiles
    : [{ id: "profile_1", userAgent: redditUserAgent, accessToken: "" }];
  const queryTokens = [...new Set(tokenizeSearchText(query))].slice(0, 24);
  const preferredKeywords = ["dashboard", "chat", "benchmark", "workflow", "agent", "ui"];
  const rows = [];
  const sourceErrors = [];

  for (const subreddit of subreddits) {
    const res = await fetchRedditSubredditWithFallback({
      subreddit,
      query,
      timeWindow,
      limitPerSubreddit,
      authProfiles,
      timeoutMs: redditRequestTimeoutMs,
      sourceHealth,
    });
    if (!res.ok) {
      sourceErrors.push({ subreddit, error: (res.errors || []).join(" | ") || "all_fallbacks_failed" });
      continue;
    }
    for (const post of res.posts) {
      rows.push(scoreRedditPost(post, queryTokens, preferredKeywords));
    }
  }

  const dedup = new Map();
  for (const row of rows) {
    const key = String(row.id || row.permalink || row.url || "");
    if (!key || dedup.has(key)) continue;
    dedup.set(key, row);
  }
  const ranked = [...dedup.values()]
    .sort((a, b) => Number(b.rank_score || 0) - Number(a.rank_score || 0))
    .slice(0, maxResults);

  return {
    summary: {
      generated_at: new Date().toISOString(),
      query,
      subreddits,
      limit_per_subreddit: limitPerSubreddit,
      time_window: timeWindow,
      indexed_posts: ranked.length,
      source_errors: sourceErrors,
      top_terms: queryTokens,
      source_health: sourceHealth,
      auth_profiles: authProfiles.map((p) => ({ id: p.id, hasAccessToken: Boolean(p.accessToken) })),
    },
    results: ranked,
  };
}

async function requestChatCompletion({
  provider,
  apiKey,
  model,
  messages,
  temperature = 0.3,
  timeoutMs = 45000,
}) {
  const endpoint =
    provider === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : "https://api.deepseek.com/chat/completions";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`${provider}_chat_failed:${response.status}:${txt.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error(`${provider}_chat_empty_response`);
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function requestAnthropicCompletion({
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.3,
  timeoutMs = 45000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`anthropic_chat_failed:${response.status}:${txt.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = Array.isArray(data?.content)
      ? data.content.find((x) => x?.type === "text")?.text
      : null;
    if (!content || typeof content !== "string") {
      throw new Error("anthropic_chat_empty_response");
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function requestGeminiCompletion({
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.3,
  timeoutMs = 45000,
}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
          },
        ],
        generationConfig: {
          temperature,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`gemini_chat_failed:${response.status}:${txt.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content || typeof content !== "string") {
      throw new Error("gemini_chat_empty_response");
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function generateModelReply({
  message,
  context,
  latestPipeline,
  allRuns,
  clawArchitectRoot,
  providerPreference,
  modelOverride,
  temperature,
  openaiApiKey,
  deepseekApiKey,
  anthropicApiKey,
  geminiApiKey,
  openaiModel,
  deepseekModel,
  anthropicModel,
  geminiModel,
  providerMetrics,
  providerStatus,
  sessionHistory,
}) {
  const intel = collectRepoIntelContext({
    latestPipeline,
    allRuns,
    clawArchitectRoot,
  });

  const systemPrompt = [
    "You are InayanBuilderBot, a production-grade Masterpiece Agent + Chat Tool.",
    "Dedication: built for Suro Jason Inaya.",
    "Be concise, technical, and execution-focused.",
    "Prioritize benchmark-first decisions, robust implementation plans, and security best practices.",
    "When validated Reddit evidence exists with high relevance_weight, prioritize that evidence over generic assumptions.",
    "Prefer recommendations that cite validated subreddit signals and linked posts when they directly support the build decision.",
    "Never invent secrets. Never return API keys.",
  ].join(" ");

  const userPrompt = JSON.stringify({
    message,
    context: context || {},
    session_history: Array.isArray(sessionHistory) ? sessionHistory : [],
    repo_intel_context: intel,
    reddit_prioritization_policy: {
      prioritize_validated_reddit_when_weight_at_least: 0.55,
      fallback_to_general_guidance_when_reddit_signal_weak: true,
    },
    guidance_focus: [
      "validated reddit evidence weighting",
      "indexing strategy",
      "repo benchmark compare",
      "masterpiece build sequencing",
      "security and release quality gates",
    ],
  });

  const allProviders = ["openai", "deepseek", "anthropic", "gemini"];
  const configuredProviders = allProviders.filter((p) => providerStatus?.providers?.[p]?.configured);
  const preferenceOrder =
    providerPreference === "openai"
      ? ["openai", "deepseek", "anthropic", "gemini"]
      : providerPreference === "deepseek"
        ? ["deepseek", "openai", "anthropic", "gemini"]
        : providerPreference === "anthropic"
          ? ["anthropic", "openai", "deepseek", "gemini"]
          : providerPreference === "gemini"
            ? ["gemini", "openai", "deepseek", "anthropic"]
            : ["openai", "deepseek", "anthropic", "gemini"];
  const providerScore = (provider) => {
    const m = providerMetrics?.[provider];
    if (!m || !m.attempts) return 0;
    const successRate = m.success / Math.max(1, m.attempts);
    const latencyPenalty = Number.isFinite(m.avgLatencyMs) ? m.avgLatencyMs / 2500 : 0.4;
    const costPenalty = Number.isFinite(m.avgEstimatedCostUsd) ? m.avgEstimatedCostUsd / 0.02 : 0.4;
    return successRate * 3 - latencyPenalty - costPenalty;
  };
  const orderedProviders = providerPreference === "auto"
    ? [...configuredProviders].sort((a, b) => {
      const delta = providerScore(b) - providerScore(a);
      if (Math.abs(delta) > 0.01) return delta;
      return preferenceOrder.indexOf(a) - preferenceOrder.indexOf(b);
    })
    : preferenceOrder;

  const errors = [];
  for (const provider of orderedProviders) {
    try {
      const attemptStarted = Date.now();
      let reply = "";
      let resolvedModel = modelOverride || "";
      if (provider === "openai") {
        if (!openaiApiKey) throw new Error("openai_key_missing");
        resolvedModel = modelOverride || openaiModel;
        reply = await requestChatCompletion({
          provider: "openai",
          apiKey: openaiApiKey,
          model: resolvedModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature,
        });
      }
      else if (provider === "deepseek") {
        if (!deepseekApiKey) throw new Error("deepseek_key_missing");
        resolvedModel = modelOverride || deepseekModel;
        reply = await requestChatCompletion({
          provider: "deepseek",
          apiKey: deepseekApiKey,
          model: resolvedModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature,
        });
      }
      else if (provider === "anthropic") {
        if (!anthropicApiKey) throw new Error("anthropic_key_missing");
        resolvedModel = modelOverride || anthropicModel;
        reply = await requestAnthropicCompletion({
          apiKey: anthropicApiKey,
          model: resolvedModel,
          systemPrompt,
          userPrompt,
          temperature,
        });
      }
      else {
        if (!geminiApiKey) throw new Error("gemini_key_missing");
        resolvedModel = modelOverride || geminiModel;
        reply = await requestGeminiCompletion({
          apiKey: geminiApiKey,
          model: resolvedModel,
          systemPrompt,
          userPrompt,
          temperature,
        });
      }

      const latencyMs = Date.now() - attemptStarted;
      const inputTokens = estimateTokenCount(`${systemPrompt}\n${userPrompt}`);
      const outputTokens = estimateTokenCount(reply);
      const estimatedCostUsd = estimateCostUsd(provider, inputTokens, outputTokens);
      recordProviderMetric({ provider, ok: true, latencyMs, estimatedCostUsd });
      return {
        reply,
        provider,
        model: resolvedModel,
        latencyMs,
        estimatedCostUsd,
        inputTokens,
        outputTokens,
      };
    } catch (err) {
      const msg = String(err?.message || err);
      recordProviderMetric({ provider, ok: false, latencyMs: null, estimatedCostUsd: null, error: msg });
      errors.push(String(err?.message || err));
    }
  }

  throw new Error(`chat_model_unavailable:${errors.join("|").slice(0, 500)}`);
}

function normalizeProviderPreference(provider) {
  const normalized = String(provider || "auto").trim().toLowerCase();
  if (normalized === "claude") return "anthropic";
  if (normalized === "google") return "gemini";
  if (["auto", "openai", "deepseek", "anthropic", "gemini"].includes(normalized)) return normalized;
  return "auto";
}

function buildProviderStatus({
  openaiApiKey,
  deepseekApiKey,
  anthropicApiKey,
  geminiApiKey,
  openaiModel,
  deepseekModel,
  anthropicModel,
  geminiModel,
}) {
  return {
    providers: {
      openai: { configured: Boolean(openaiApiKey), defaultModel: openaiModel },
      deepseek: { configured: Boolean(deepseekApiKey), defaultModel: deepseekModel },
      anthropic: { configured: Boolean(anthropicApiKey), defaultModel: anthropicModel, aliases: ["claude"] },
      gemini: { configured: Boolean(geminiApiKey), defaultModel: geminiModel, aliases: ["google"] },
    },
    aliases: {
      claude: "anthropic",
      google: "gemini",
    },
  };
}

const ScoutSchema = z.object({
  queries: z.array(z.string().min(3)).min(1).max(10),
  perQuery: z.number().int().min(5).max(30).default(15),
  minStars: z.number().int().min(100).default(500),
  topK: z.number().int().min(3).max(30).default(12),
  seedRepos: z
    .array(
      z.object({
        full_name: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        stargazers_count: z.number().optional(),
        forks_count: z.number().optional(),
        pushed_at: z.string().optional(),
        topics: z.array(z.string()).optional(),
      })
    )
    .optional(),
});

const BenchmarkSchema = z.object({
  repos: z.array(z.object({
    full_name: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    stars: z.number().optional(),
    stargazers_count: z.number().optional(),
    uiEvidence: z.number().optional(),
    topics: z.array(z.string()).optional(),
    breakPatternEvidence: z.number().optional(),
    breakPatternHits: z.array(z.string()).optional(),
  })).min(1).max(30),
  weight_ui: z.number().min(0).max(1).default(0.58),
  weight_popularity: z.number().min(0).max(1).default(0.42),
});

const MasterpieceBuildSchema = z.object({
  productName: z.string().min(2).max(120),
  userGoal: z.string().min(10).max(4000),
  selectedRepos: z.array(z.object({ full_name: z.string(), benchmarkScore: z.number().optional() })).min(1).max(12),
  stack: z.array(z.string().min(1).max(80)).min(1).max(20),
});

const PipelineSchema = z.object({
  productName: z.string().min(2).max(120),
  userGoal: z.string().min(10).max(4000),
  stack: z.array(z.string().min(1).max(80)).min(1).max(20),
  queries: z.array(z.string().min(3)).min(1).max(10),
  minStars: z.number().int().min(100).max(500000).default(500),
  topK: z.number().int().min(3).max(30).default(10),
  runExternal: z.boolean().default(true),
  runGithubResearch: z.boolean().default(true),
  runRedditResearch: z.boolean().default(true),
  github: z.object({
    query: z.string().min(2).max(300).optional(),
    perPage: z.number().int().min(5).max(30).default(20),
    maxResults: z.number().int().min(5).max(120).default(40),
  }).optional(),
  reddit: z.object({
    query: z.string().min(2).max(300).optional(),
    subreddits: z.array(z.string().min(2).max(60)).min(1).max(30).optional(),
    limitPerSubreddit: z.number().int().min(3).max(100).default(25),
    timeWindow: z.string().min(1).max(20).default("year"),
    maxResults: z.number().int().min(5).max(200).default(60),
  }).optional(),
  seedRepos: ScoutSchema.shape.seedRepos,
});

const MagicRunSchema = z.object({
  productName: z.string().min(2).max(120).default("InayanBuilder"),
  userGoal: z.string().min(10).max(4000),
  stack: z.array(z.string().min(1).max(80)).min(1).max(20).default(["node", "typescript", "postgres", "react"]),
  idempotencyKey: z.string().min(8).max(120).optional(),
  timeoutTier: z.enum(["fast", "standard", "deep"]).default("fast"),
  constraints: z.object({
    budgetUsd: z.number().int().min(0).max(500000).default(5000),
    deadlineDays: z.number().int().min(1).max(365).default(14),
    teamSize: z.number().int().min(1).max(50).default(2),
  }).default({ budgetUsd: 5000, deadlineDays: 14, teamSize: 2 }),
  deterministic: z.boolean().default(true),
});

const RecompileSchema = z.object({
  runId: z.string().min(4).max(120),
  constraints: z.object({
    budgetUsd: z.number().int().min(0).max(500000).optional(),
    deadlineDays: z.number().int().min(1).max(365).optional(),
    teamSize: z.number().int().min(1).max(50).optional(),
  }).default({}),
  notes: z.string().max(2000).optional(),
});

const RedditSearchSchema = z.object({
  query: z.string().min(2).max(300),
  subreddits: z.array(z.string().min(2).max(60)).min(1).max(30).optional(),
  limitPerSubreddit: z.number().int().min(3).max(100).default(25),
  timeWindow: z.string().min(1).max(20).default("year"),
  maxResults: z.number().int().min(5).max(200).default(60),
});

const GithubResearchSchema = z.object({
  query: z.string().min(2).max(300),
  perPage: z.number().int().min(5).max(30).default(20),
  maxResults: z.number().int().min(5).max(120).default(40),
});

const FusionResearchSchema = z.object({
  topK: z.number().int().min(3).max(30).default(10),
  useLatestRuns: z.boolean().default(true),
});

const ChatSchema = z.object({
  message: z.string().min(2).max(3000),
  provider: z
    .enum(["auto", "openai", "deepseek", "anthropic", "claude", "gemini", "google"])
    .default("auto")
    .transform((value) => normalizeProviderPreference(value)),
  model: z.string().min(1).max(120).optional(),
  temperature: z.number().min(0).max(2).default(0.3),
  sessionId: z.string().min(2).max(120).optional(),
  context: z.object({
    productName: z.string().optional(),
    stack: z.array(z.string()).optional(),
  }).optional(),
});

const OpenClawScoutSchema = z.object({
  limit: z.number().int().min(5).max(50).default(12),
  minStars: z.number().int().min(100).max(500000).default(500),
  perQuery: z.number().int().min(5).max(50).default(20),
  uiProbeLimit: z.number().int().min(10).max(100).default(45),
});

const OpenClawReadinessSchema = z.object({
  minScore: z.number().int().min(1).max(100).default(80),
  limit: z.number().int().min(1).max(100).default(20),
});

const RepoContractGapSchema = z.object({
  repoPath: z.string().min(1).max(600),
  maxFiles: z.number().int().min(10).max(20000).default(5000),
  maxFileBytes: z.number().int().min(1024).max(5 * 1024 * 1024).default(1024 * 1024),
});

const OnboardSetupSchema = z.object({
  generateApiKey: z.boolean().default(true),
  builderbotApiKey: z.string().min(8).max(120).optional(),
  githubToken: z.string().min(10).max(200).optional(),
  postgres: z.object({
    host: z.string().min(1).max(200).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(5432),
    user: z.string().min(1).max(120).default("postgres"),
    password: z.string().min(1).max(200),
    db: z.string().min(1).max(120).default("postgres"),
  }).optional(),
  runChecks: z.boolean().default(true),
});

export function createApp() {
  ensureDataStore();

  const app = express();
  const NODE_ENV = process.env.NODE_ENV || "development";
  const API_KEY = (process.env.BUILDERBOT_API_KEY || "").trim();
  const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").trim();
  const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
  const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
  const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
  const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "").trim();
  const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim();
  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY || "").trim();
  const OPENAI_CHAT_MODEL = (process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini").trim();
  const DEEPSEEK_CHAT_MODEL = (process.env.DEEPSEEK_CHAT_MODEL || "deepseek-chat").trim();
  const ANTHROPIC_CHAT_MODEL = (process.env.ANTHROPIC_CHAT_MODEL || process.env.CLAUDE_CHAT_MODEL || "claude-3-5-sonnet-latest").trim();
  const GEMINI_CHAT_MODEL = (process.env.GEMINI_CHAT_MODEL || process.env.GOOGLE_CHAT_MODEL || "gemini-1.5-pro").trim();
  const REDDIT_USER_AGENT = (process.env.REDDIT_USER_AGENT || "inayanbuilderbot-reddit/1.0").trim();
  const REDDIT_AUTH_PROFILES = (process.env.REDDIT_AUTH_PROFILES || "").trim();
  const REDDIT_USER_AGENTS = (process.env.REDDIT_USER_AGENTS || process.env.REDDIT_USER_AGENT_PROFILES || "").trim();
  const REDDIT_ACCESS_TOKENS = (process.env.REDDIT_ACCESS_TOKENS || process.env.REDDIT_ACCESS_TOKEN_PROFILES || "").trim();
  const REDDIT_DEFAULT_SUBREDDITS = parseEnvList(
    process.env.REDDIT_DEFAULT_SUBREDDITS
      || "AI_Agents,LocalLLaMA,MachineLearning,programming,webdev,OpenAI,ClaudeAI"
  );
  const REDDIT_REQUEST_TIMEOUT_MS = Math.max(
    2500,
    Number(process.env.REDDIT_REQUEST_TIMEOUT_MS || "12000") || 12000
  );
  const redditAuthProfiles = buildRedditAuthProfiles({
    defaultUserAgent: REDDIT_USER_AGENT,
    explicitProfilesJson: REDDIT_AUTH_PROFILES,
    userAgentsCsv: REDDIT_USER_AGENTS,
    accessTokensCsv: REDDIT_ACCESS_TOKENS,
  });
  const EXTERNAL_INDEXING_MODE = (process.env.EXTERNAL_INDEXING_MODE || "builtin").trim().toLowerCase();
  const providerStatus = buildProviderStatus({
    openaiApiKey: OPENAI_API_KEY,
    deepseekApiKey: DEEPSEEK_API_KEY,
    anthropicApiKey: ANTHROPIC_API_KEY,
    geminiApiKey: GEMINI_API_KEY,
    openaiModel: OPENAI_CHAT_MODEL,
    deepseekModel: DEEPSEEK_CHAT_MODEL,
    anthropicModel: ANTHROPIC_CHAT_MODEL,
    geminiModel: GEMINI_CHAT_MODEL,
  });

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false }));
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

  const requireAuth = authMiddleware(API_KEY);
  const requireSetupAuth = (req, res, next) => {
    const key = String(process.env.BUILDERBOT_API_KEY || "").trim();
    if (!key) return next();
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token || token !== key) return res.status(401).json({ ok: false, error: "unauthorized" });
    return next();
  };
  const openClawCaps = detectOpenClawCapabilities(CLAW_ARCHITECT_ROOT);

  const runOpenClawScript = async ({ scriptName, args = [], timeoutMs = 15 * 60 * 1000 }) => {
    if (!openClawCaps.rootExists) {
      return {
        ok: false,
        code: 1,
        error: `openclaw_root_missing:${CLAW_ARCHITECT_ROOT}`,
      };
    }
    if (!openClawCaps.scriptNames.includes(scriptName) && !openClawCaps[{
      "index:sync:agent": "canIndexSync",
      "repo:readiness:pulse": "canReadinessPulse",
      "dashboard:repo:scout": "canDashboardScout",
    }[scriptName] || ""]) {
      return {
        ok: false,
        code: 1,
        error: `openclaw_script_unavailable:${scriptName}`,
      };
    }
    const result = await runCommand({
      cmd: "npm",
      args: ["run", "-s", scriptName, ...(args.length ? ["--", ...args] : [])],
      cwd: CLAW_ARCHITECT_ROOT,
      timeoutMs,
    });
    return {
      ...result,
      parsed: parseTrailingJson(`${result.stdout}\n${result.stderr}`),
      stdout_tail: String(result.stdout || "").slice(-1200),
      stderr_tail: String(result.stderr || "").slice(-1200),
    };
  };

  const getSetupStatus = () => {
    const envFromFile = parseEnvText(readEnvFileSafe());
    const env = { ...envFromFile, ...process.env };
    const githubToken = String(env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || "").trim();
    const pgPass = String(env.POSTGRES_PASSWORD || env.CLAW_DB_PASSWORD || "").trim();
    return {
      builderbotApiKeyConfigured: Boolean(String(env.BUILDERBOT_API_KEY || "").trim()),
      githubTokenConfigured: Boolean(githubToken),
      postgresConfigured: Boolean(pgPass) && Boolean(String(env.POSTGRES_HOST || env.CLAW_DB_HOST || "").trim()),
      envPath: envFile,
      masked: {
        githubToken: githubToken ? maskSecret(githubToken) : "",
        postgresHost: String(env.POSTGRES_HOST || env.CLAW_DB_HOST || ""),
        postgresPort: Number(env.POSTGRES_PORT || env.CLAW_DB_PORT || 5432),
        postgresUser: String(env.POSTGRES_USER || env.CLAW_DB_USER || ""),
        postgresDb: String(env.POSTGRES_DB || env.CLAW_DB_NAME || ""),
      },
    };
  };

  app.get("/api/v1/setup/status", requireSetupAuth, (_req, res) => {
    return res.json({ ok: true, setup: getSetupStatus() });
  });

  app.post("/api/v1/setup/onboard", requireSetupAuth, async (req, res) => {
    const parsed = OnboardSetupSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
    const p = parsed.data;

    ensureEnvFile();
    let envText = readEnvFileSafe();
    const changedKeys = [];

    const generatedKey = p.generateApiKey
      ? `ibb_${crypto.randomBytes(24).toString("hex")}`
      : (p.builderbotApiKey ? String(p.builderbotApiKey).trim() : "");
    if (generatedKey) {
      envText = upsertEnvText(envText, "BUILDERBOT_API_KEY", generatedKey);
      process.env.BUILDERBOT_API_KEY = generatedKey;
      changedKeys.push("BUILDERBOT_API_KEY");
    }

    if (p.githubToken) {
      const githubToken = String(p.githubToken).trim();
      envText = upsertEnvText(envText, "GITHUB_TOKEN", githubToken);
      envText = upsertEnvText(envText, "GITHUB_PERSONAL_ACCESS_TOKEN", githubToken);
      process.env.GITHUB_TOKEN = githubToken;
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = githubToken;
      changedKeys.push("GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN");
    }

    if (p.postgres) {
      envText = upsertEnvText(envText, "POSTGRES_HOST", String(p.postgres.host));
      envText = upsertEnvText(envText, "POSTGRES_PORT", String(p.postgres.port));
      envText = upsertEnvText(envText, "POSTGRES_USER", String(p.postgres.user));
      envText = upsertEnvText(envText, "POSTGRES_PASSWORD", String(p.postgres.password));
      envText = upsertEnvText(envText, "POSTGRES_DB", String(p.postgres.db));
      process.env.POSTGRES_HOST = String(p.postgres.host);
      process.env.POSTGRES_PORT = String(p.postgres.port);
      process.env.POSTGRES_USER = String(p.postgres.user);
      process.env.POSTGRES_PASSWORD = String(p.postgres.password);
      process.env.POSTGRES_DB = String(p.postgres.db);
      changedKeys.push("POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB");
    }

    fs.writeFileSync(envFile, envText, "utf8");

    const checks = {};
    if (p.runChecks) {
      const setup = getSetupStatus();
      checks.github = await checkGithubToken(process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN);
      checks.postgres = await checkPostgresTcp({
        host: setup.masked.postgresHost || "127.0.0.1",
        port: setup.masked.postgresPort || 5432,
      });
      const mcp = await runCommand({
        cmd: "npm",
        args: ["run", "-s", "mcp:health"],
        cwd: rootDir,
        timeoutMs: 120000,
      });
      checks.mcpHealth = {
        ok: mcp.ok,
        code: mcp.code,
        timed_out: mcp.timed_out,
        stdout_tail: String(mcp.stdout || "").slice(-800),
        stderr_tail: String(mcp.stderr || "").slice(-800),
      };
    }

    return res.json({
      ok: true,
      changedKeys: [...new Set(changedKeys)],
      setup: getSetupStatus(),
      generated: {
        builderbotApiKey: generatedKey ? maskSecret(generatedKey) : "",
      },
      checks,
      note: "Secrets were saved to local .env only and masked in this response.",
    });
  });

  app.get("/api/v1/indexing/capabilities", requireAuth, (_req, res) => {
    return res.json({ ok: true, indexing: { ...openClawCaps, builtinAdvancedIndexing: true } });
  });

  app.post("/api/v1/indexing/sync", requireAuth, async (_req, res) => {
    const result = await runOpenClawScript({ scriptName: "index:sync:agent", args: [] });
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: "index_sync_failed", detail: result.error || result.stderr_tail || "index_sync_failed", result });
    }
    return res.json({ ok: true, task: "index_sync", result });
  });

  app.post("/api/v1/indexing/readiness", requireAuth, async (req, res) => {
    const parsed = OpenClawReadinessSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
    const p = parsed.data;
    const result = await runOpenClawScript({
      scriptName: "repo:readiness:pulse",
      args: ["--min-score", String(p.minScore), "--limit", String(p.limit)],
    });
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: "readiness_failed", detail: result.error || result.stderr_tail || "readiness_failed", result });
    }
    return res.json({ ok: true, task: "readiness", params: p, result });
  });

  app.post("/api/v1/indexing/dashboard-scout", requireAuth, async (req, res) => {
    const parsed = OpenClawScoutSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
    const p = parsed.data;
    const result = await runOpenClawScript({
      scriptName: "dashboard:repo:scout",
      args: [
        "--limit", String(p.limit),
        "--min-stars", String(p.minStars),
        "--per-query", String(p.perQuery),
        "--ui-probe-limit", String(p.uiProbeLimit),
      ],
    });
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: "dashboard_scout_failed", detail: result.error || result.stderr_tail || "dashboard_scout_failed", result });
    }
    return res.json({ ok: true, task: "dashboard_scout", params: p, result });
  });

  app.post("/api/v1/repos/contract-gap", requireAuth, (req, res) => {
    const parsed = RepoContractGapSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
    const p = parsed.data;
    const repoPath = path.resolve(String(p.repoPath || ""));
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return res.status(404).json({ ok: false, error: "repo_not_found", repoPath });
    }
    const report = analyzeRepoContractGap({
      repoPath,
      maxFiles: p.maxFiles,
      maxFileBytes: p.maxFileBytes,
    });
    return res.json({
      ok: true,
      repoPath,
      coverageScore: report.coverageScore,
      coveragePct: report.coveragePct,
      missingBackendCount: report.missingBackend.length,
      probableAliasCount: report.probableAliasMatches.length,
      report,
    });
  });

  app.get("/api/v1/github/capabilities", requireAuth, (_req, res) => {
    return res.json({
      ok: true,
      github: {
        enabled: true,
        tokenConfigured: Boolean(GITHUB_TOKEN),
        endpoints: {
          repo_search: "/search/repositories",
          issue_search: "/search/issues",
        },
      },
    });
  });

  app.post("/api/v1/github/research", requireAuth, async (req, res) => {
    const parsed = GithubResearchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    try {
      const p = parsed.data;
      const report = await runGithubResearch({
        query: p.query,
        perPage: p.perPage,
        maxResults: p.maxResults,
        githubToken: GITHUB_TOKEN,
      });
      const run = {
        id: nowId("github"),
        type: "github_research",
        createdAt: new Date().toISOString(),
        payload: p,
        output: report,
      };
      appState.runs.unshift(run);
      trimHistory();
      persistDataStore();

      return res.json({
        ok: true,
        runId: run.id,
        summary: report.summary,
        repos: report.repos,
        answers: report.answers,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "github_research_failed",
        detail: String(err?.message || err),
      });
    }
  });

  app.get("/api/v1/reddit/capabilities", requireAuth, (_req, res) => {
    return res.json({
      ok: true,
      reddit: {
        enabled: true,
        defaultSubreddits: REDDIT_DEFAULT_SUBREDDITS,
        requestTimeoutMs: REDDIT_REQUEST_TIMEOUT_MS,
        authProfiles: redditAuthProfiles.map((p) => ({
          id: p.id,
          userAgentConfigured: Boolean(p.userAgent),
          accessTokenConfigured: Boolean(p.accessToken),
        })),
        sourceOrder: ["reddit_top", "old_reddit_top", "hot", "new", "rss"],
      },
    });
  });

  app.post("/api/v1/reddit/search", requireAuth, async (req, res) => {
    const parsed = RedditSearchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    try {
      const p = parsed.data;
      const subreddits = Array.isArray(p.subreddits) && p.subreddits.length
        ? p.subreddits
        : REDDIT_DEFAULT_SUBREDDITS;
      const report = await runRedditResearch({
        query: p.query,
        subreddits,
        limitPerSubreddit: p.limitPerSubreddit,
        timeWindow: p.timeWindow,
        maxResults: p.maxResults,
        redditUserAgent: REDDIT_USER_AGENT,
        redditAuthProfiles,
        redditRequestTimeoutMs: REDDIT_REQUEST_TIMEOUT_MS,
      });

      const run = {
        id: nowId("reddit"),
        type: "reddit_research",
        createdAt: new Date().toISOString(),
        payload: { ...p, subreddits },
        output: report,
      };
      appState.runs.unshift(run);
      trimHistory();
      persistDataStore();

      return res.json({
        ok: true,
        runId: run.id,
        summary: report.summary,
        results: report.results,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "reddit_search_failed",
        detail: String(err?.message || err),
      });
    }
  });

  app.post("/api/v1/research/fusion", requireAuth, async (req, res) => {
    const parsed = FusionResearchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    const p = parsed.data;
    const bundle = getLatestResearchBundle(appState.runs);
    if (!bundle.benchmarkRepos.length) {
      return res.status(404).json({
        ok: false,
        error: "fusion_inputs_missing",
        detail: "Run /api/v1/masterpiece/pipeline/run or /api/v1/benchmark/run first.",
      });
    }

    const fusion = buildFusionLeaderboard({
      benchmarkRepos: bundle.benchmarkRepos,
      githubReport: bundle.githubReport,
      redditReport: bundle.redditReport,
      topK: p.topK,
    });

    const run = {
      id: nowId("fusion"),
      type: "fusion_research",
      createdAt: new Date().toISOString(),
      payload: p,
      output: fusion,
    };
    appState.runs.unshift(run);
    trimHistory();
    persistDataStore();

    return res.json({
      ok: true,
      runId: run.id,
      fusion,
      sources: {
        benchmark_count: bundle.benchmarkRepos.length,
        has_github: Boolean(bundle.githubReport),
        has_reddit: Boolean(bundle.redditReport),
      },
    });
  });

  app.post("/api/v1/scout/run", requireAuth, async (req, res) => {
    try {
      const parsed = ScoutSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

      const p = parsed.data;
      const discovered = await discoverScoutRepos({
        queries: p.queries,
        perQuery: p.perQuery,
        minStars: p.minStars,
        topK: p.topK,
        seedRepos: p.seedRepos,
        githubToken: GITHUB_TOKEN,
      });

      const dedup = new Map();
      for (const repo of discovered) {
        const key = String(repo.full_name || "").toLowerCase();
        if (!key || dedup.has(key)) continue;
        if (repo.archived || repo.disabled) continue;
        const scored = scoreRepo(repo);
        if (Number(repo.stargazers_count || repo.stars || 0) < p.minStars) continue;
        if (scored.frameworkOnly) continue;
        if (scored.uiEvidence < 5) continue;
        dedup.set(key, {
          full_name: repo.full_name,
          name: repo.name,
          html_url: repo.html_url,
          description: repo.description || "",
          stars: Number(repo.stargazers_count || repo.stars || 0),
          forks: Number(repo.forks_count || repo.forks || 0),
          language: repo.language || null,
          pushed_at: repo.pushed_at || null,
          topics: Array.isArray(repo.topics) ? repo.topics : [],
          score: scored.score,
          uiEvidence: scored.uiEvidence,
          uiHits: scored.uiHits,
          breakPatternEvidence: scored.breakPatternEvidence,
          breakPatternHits: scored.breakPatternHits,
        });
      }

      const repos = [...dedup.values()].sort((a, b) => b.score - a.score).slice(0, p.topK);
      const run = { id: nowId("scout"), type: "scout", createdAt: new Date().toISOString(), payload: p, output: repos };
      appState.runs.unshift(run);
      trimHistory();
      persistDataStore();

      return res.json({ ok: true, runId: run.id, count: repos.length, repos });
    } catch (err) {
      return res.status(500).json({ ok: false, error: "scout_failed", detail: String(err?.message || err) });
    }
  });

  app.post("/api/v1/benchmark/run", requireAuth, (req, res) => {
    const parsed = BenchmarkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    const p = parsed.data;
    const ranked = benchmarkRepos(p.repos, p.weight_ui, p.weight_popularity);
    const run = { id: nowId("bench"), type: "benchmark", createdAt: new Date().toISOString(), payload: p, output: ranked };
    appState.runs.unshift(run);
    trimHistory();
    persistDataStore();

    return res.json({ ok: true, runId: run.id, compared: ranked.length, ranked });
  });

  app.post("/api/v1/masterpiece/build", requireAuth, (req, res) => {
    const parsed = MasterpieceBuildSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    const p = parsed.data;
    const rankedRepos = [...p.selectedRepos].sort((a, b) => Number(b.benchmarkScore || 0) - Number(a.benchmarkScore || 0));

    const blueprint = {
      productName: p.productName,
      dedication: "Dedicated to Suro Jason Inaya.",
      objective: p.userGoal,
      foundation: {
        basedOn: "OpenClaw benchmark-first masterpiece workflow",
        topReferences: rankedRepos.slice(0, 6).map((r) => r.full_name),
        stack: p.stack,
      },
      buildPlan: [
        {
          phase: "Phase 1: Index + Research Lock",
          actions: [
            "Index target codebases and local mirrors",
            "Scout proven dashboard/chat repos",
            "Benchmark compare and lock top architectures"
          ]
        },
        {
          phase: "Phase 2: Production Build",
          actions: [
            "Build dashboard command center",
            "Build integrated chat tool",
            "Implement orchestration API + run artifacts"
          ]
        },
        {
          phase: "Phase 3: Hardening + Release",
          actions: [
            "Run security and secrets gates",
            "Run tests and smoke checks",
            "Publish installation + operations paperwork"
          ]
        }
      ],
      generatedAt: new Date().toISOString(),
    };

    const run = { id: nowId("masterpiece"), type: "masterpiece", createdAt: new Date().toISOString(), payload: p, output: blueprint };
    appState.runs.unshift(run);
    trimHistory();
    persistDataStore();

    return res.json({ ok: true, runId: run.id, blueprint });
  });

  app.post("/api/v1/masterpiece/pipeline/run", requireAuth, async (req, res) => {
    const parsed = PipelineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    const p = parsed.data;
    const runId = nowId("pipeline");
    const startedAt = new Date().toISOString();
    const stageResults = [];
    let githubReport = null;
    let redditReport = null;

    const scoutPayload = {
      queries: p.queries,
      perQuery: 15,
      minStars: p.minStars,
      topK: p.topK,
      seedRepos: p.seedRepos,
    };

    const scoutCacheKey = deterministicHash({
      stage: "pipeline_scout",
      queries: p.queries,
      minStars: p.minStars,
      topK: p.topK,
      seedRepos: Array.isArray(p.seedRepos) ? p.seedRepos.map((r) => r.full_name || r.name || "").sort() : [],
    });

    let scoutRepos = getCache(PIPELINE_SCOUT_CACHE, scoutCacheKey) || [];
    let scoutCached = true;
    if (!scoutRepos.length) {
      scoutCached = false;
      try {
        const discovered = await discoverScoutRepos({
          queries: p.queries,
          perQuery: 15,
          minStars: p.minStars,
          topK: p.topK,
          seedRepos: p.seedRepos,
          githubToken: GITHUB_TOKEN,
        });

        const dedup = new Map();
        for (const repo of discovered) {
          const key = String(repo.full_name || "").toLowerCase();
          if (!key || dedup.has(key)) continue;
          if (repo.archived || repo.disabled) continue;
          const scored = scoreRepo(repo);
          if (Number(repo.stargazers_count || repo.stars || 0) < p.minStars) continue;
          if (scored.frameworkOnly || scored.uiEvidence < 5) continue;
          dedup.set(key, {
            full_name: repo.full_name,
            name: repo.name,
            html_url: repo.html_url,
            description: repo.description || "",
            stars: Number(repo.stargazers_count || repo.stars || 0),
            forks: Number(repo.forks_count || repo.forks || 0),
            language: repo.language || null,
            pushed_at: repo.pushed_at || null,
            topics: Array.isArray(repo.topics) ? repo.topics : [],
            score: scored.score,
            uiEvidence: scored.uiEvidence,
            uiHits: scored.uiHits,
            breakPatternEvidence: scored.breakPatternEvidence,
            breakPatternHits: scored.breakPatternHits,
          });
        }
        scoutRepos = [...dedup.values()].sort((a, b) => b.score - a.score).slice(0, p.topK);
        setCache(PIPELINE_SCOUT_CACHE, scoutCacheKey, scoutRepos);
      } catch (err) {
        stageResults.push({ stage: "scout", ok: false, detail: { error: String(err?.message || err), payload: scoutPayload } });
      }
    }
    if (scoutRepos.length > 0) {
      stageResults.push({ stage: "scout", ok: true, detail: { count: scoutRepos.length, payload: scoutPayload, cached: scoutCached } });
    }

    let benchmarkRanked = [];
    if (scoutRepos.length > 0) {
      const benchCacheKey = deterministicHash({
        stage: "pipeline_benchmark",
        repos: scoutRepos.map((r) => [r.full_name, Number(r.stars || 0), Number(r.score || 0)]),
      });
      benchmarkRanked = getCache(PIPELINE_BENCH_CACHE, benchCacheKey) || [];
      let benchCached = true;
      if (!benchmarkRanked.length) {
        benchCached = false;
        benchmarkRanked = benchmarkRepos(scoutRepos, 0.58, 0.42);
        setCache(PIPELINE_BENCH_CACHE, benchCacheKey, benchmarkRanked);
      }
      stageResults.push({ stage: "benchmark", ok: true, detail: { count: benchmarkRanked.length, cached: benchCached } });
    } else {
      stageResults.push({ stage: "benchmark", ok: false, detail: { error: "no_scout_repos" } });
    }

    if (p.runExternal) {
      const rootExists = fs.existsSync(CLAW_ARCHITECT_ROOT);
      const useOpenClaw = EXTERNAL_INDEXING_MODE === "openclaw" || (EXTERNAL_INDEXING_MODE === "auto" && rootExists);

      if (useOpenClaw && rootExists) {
        const extSteps = [
          { name: "index_sync", cmd: "npm", args: ["run", "-s", "index:sync:agent"] },
          { name: "repo_readiness", cmd: "npm", args: ["run", "-s", "repo:readiness:pulse", "--", "--min-score", "80", "--limit", "20"] },
          { name: "dashboard_scout", cmd: "npm", args: ["run", "-s", "dashboard:repo:scout", "--", "--limit", String(Math.max(8, p.topK)), "--min-stars", String(p.minStars), "--per-query", "20", "--ui-probe-limit", "45"] },
          { name: "release_four_repos_check", cmd: "node", args: ["scripts/release-checklist-four-repos.js", "--check"] },
        ];

        for (const s of extSteps) {
          const r = await runCommand({ cmd: s.cmd, args: s.args, cwd: CLAW_ARCHITECT_ROOT, timeoutMs: 15 * 60 * 1000 });
          const parsedJson = parseTrailingJson(`${r.stdout}\n${r.stderr}`);
          const releaseSummary = s.name === "release_four_repos_check"
            ? parseReleaseChecklistSummary(`${r.stdout}\n${r.stderr}`)
            : null;
          const dependencyHint = detectDependencyInstallHint(`${r.stdout}\n${r.stderr}`);
          stageResults.push({
            stage: `external_${s.name}`,
            ok: r.ok,
            detail: {
              code: r.code,
              timed_out: r.timed_out,
              parsed: parsedJson,
              release_summary: releaseSummary,
              dependency_hint: dependencyHint,
              stdout_tail: String(r.stdout || "").slice(-1200),
              stderr_tail: String(r.stderr || "").slice(-1200),
            },
          });
        }
      } else {
        const builtin = runBuiltinAdvancedIndexing({
          repos: benchmarkRanked.length ? benchmarkRanked : scoutRepos,
          queries: p.queries,
          minStars: p.minStars,
          topK: p.topK,
        });
        stageResults.push({
          stage: "external_builtin_indexing",
          ok: true,
          detail: builtin,
        });
      }
    }

    if (p.runGithubResearch) {
      const githubQuery = String(
        p?.github?.query
        || `${p.productName} ${p.userGoal} ${p.queries.join(" ")}`
      ).slice(0, 300);
      const githubCacheKey = deterministicHash({
        stage: "github_research",
        githubQuery,
        perPage: Number(p?.github?.perPage || 20),
        maxResults: Number(p?.github?.maxResults || 40),
      });
      try {
        githubReport = getCache(PIPELINE_GITHUB_CACHE, githubCacheKey);
        let cached = true;
        if (!githubReport) {
          cached = false;
          githubReport = await runGithubResearch({
            query: githubQuery,
            perPage: Number(p?.github?.perPage || 20),
            maxResults: Number(p?.github?.maxResults || 40),
            githubToken: GITHUB_TOKEN,
          });
          setCache(PIPELINE_GITHUB_CACHE, githubCacheKey, githubReport);
        }
        stageResults.push({
          stage: "github_research",
          ok: true,
          detail: {
            query: githubQuery,
            cached,
            repo_hits: Number(githubReport?.summary?.repo_hits || 0),
            answer_hits: Number(githubReport?.summary?.answer_hits || 0),
          },
        });
      } catch (err) {
        try {
          const fallbackQuery = String(p.queries?.[0] || p.productName || "ai builder").slice(0, 120);
          githubReport = await runGithubResearch({
            query: fallbackQuery,
            perPage: 12,
            maxResults: 24,
            githubToken: GITHUB_TOKEN,
          });
          const fallbackKey = deterministicHash({
            stage: "github_research",
            githubQuery: fallbackQuery,
            perPage: 12,
            maxResults: 24,
          });
          setCache(PIPELINE_GITHUB_CACHE, fallbackKey, githubReport);
          stageResults.push({
            stage: "github_research",
            ok: true,
            detail: {
              query: githubQuery,
              fallback_query: fallbackQuery,
              degraded: true,
              repo_hits: Number(githubReport?.summary?.repo_hits || 0),
              answer_hits: Number(githubReport?.summary?.answer_hits || 0),
            },
          });
        } catch (fallbackErr) {
          stageResults.push({
            stage: "github_research",
            ok: false,
            detail: {
              error: String(err?.message || err),
              fallback_error: String(fallbackErr?.message || fallbackErr),
            },
          });
        }
      }
    }

    if (p.runRedditResearch) {
      const redditQuery = String(
        p?.reddit?.query
        || `${p.productName} ${p.userGoal} ${p.queries.join(" ")} dashboard chat ui`
      ).slice(0, 300);
      const redditSubreddits = Array.isArray(p?.reddit?.subreddits) && p.reddit.subreddits.length
        ? p.reddit.subreddits
        : REDDIT_DEFAULT_SUBREDDITS;
      const redditCacheKey = deterministicHash({
        stage: "reddit_research",
        redditQuery,
        redditSubreddits,
        limitPerSubreddit: Number(p?.reddit?.limitPerSubreddit || 25),
        timeWindow: String(p?.reddit?.timeWindow || "year"),
        maxResults: Number(p?.reddit?.maxResults || 60),
      });
      try {
        redditReport = getCache(PIPELINE_REDDIT_CACHE, redditCacheKey);
        let cached = true;
        if (!redditReport) {
          cached = false;
          redditReport = await runRedditResearch({
            query: redditQuery,
            subreddits: redditSubreddits,
            limitPerSubreddit: Number(p?.reddit?.limitPerSubreddit || 25),
            timeWindow: String(p?.reddit?.timeWindow || "year"),
            maxResults: Number(p?.reddit?.maxResults || 60),
            redditUserAgent: REDDIT_USER_AGENT,
            redditAuthProfiles,
            redditRequestTimeoutMs: REDDIT_REQUEST_TIMEOUT_MS,
          });
          setCache(PIPELINE_REDDIT_CACHE, redditCacheKey, redditReport);
        }
        stageResults.push({
          stage: "reddit_research",
          ok: true,
          detail: {
            query: redditQuery,
            cached,
            indexed_posts: Number(redditReport?.summary?.indexed_posts || 0),
            source_errors: Array.isArray(redditReport?.summary?.source_errors) ? redditReport.summary.source_errors.length : 0,
          },
        });
      } catch (err) {
        stageResults.push({
          stage: "reddit_research",
          ok: false,
          detail: {
            error: String(err?.message || err),
          },
        });
      }
    }

    const fusion = buildFusionLeaderboard({
      benchmarkRepos: benchmarkRanked,
      githubReport,
      redditReport,
      topK: Math.max(5, Math.min(15, p.topK)),
    });
    stageResults.push({
      stage: "fusion_research",
      ok: true,
      detail: {
        leaderboard_count: Number(fusion?.summary?.leaderboard_count || 0),
        github_repo_hits: Number(fusion?.summary?.github_repo_hits || 0),
        reddit_weighted_hits: Number(fusion?.summary?.reddit_weighted_hits || 0),
      },
    });

    const selectedRepos = benchmarkRanked.slice(0, Math.min(6, benchmarkRanked.length)).map((r) => ({
      full_name: r.full_name,
      benchmarkScore: r.benchmarkScore,
    }));

    const blueprint = {
      productName: p.productName,
      dedication: "Dedicated to Suro Jason Inaya.",
      objective: p.userGoal,
      stack: p.stack,
      selectedRepos,
      summary: {
        scout_count: scoutRepos.length,
        benchmark_count: benchmarkRanked.length,
        github_repo_hits: Number(githubReport?.summary?.repo_hits || 0),
        github_answer_hits: Number(githubReport?.summary?.answer_hits || 0),
        reddit_indexed_posts: Number(redditReport?.summary?.indexed_posts || 0),
        fusion_leaderboard_count: Number(fusion?.summary?.leaderboard_count || 0),
        external_stages: stageResults.filter((s) => s.stage.startsWith("external_")).length,
      },
      fusionTop: Array.isArray(fusion?.leaderboard)
        ? fusion.leaderboard.slice(0, 8)
        : [],
      githubAnswerTop: Array.isArray(githubReport?.answers)
        ? githubReport.answers.slice(0, 8).map((a) => ({
          title: a.title,
          rank_score: a.rank_score,
          html_url: a.html_url,
          code_snippet_preview: Array.isArray(a.code_snippets) && a.code_snippets.length
            ? String(a.code_snippets[0]).slice(0, 180)
            : "",
        }))
        : [],
      redditSignalTop: Array.isArray(redditReport?.results)
        ? redditReport.results.slice(0, 8).map((r) => ({
          title: r.title,
          subreddit: r.subreddit,
          rank_score: r.rank_score,
          permalink: r.permalink || r.url,
        }))
        : [],
      generatedAt: new Date().toISOString(),
    };

    const ok = stageResults.every(
      (s) => s.ok || s.stage.startsWith("external_") || s.stage === "reddit_research" || s.stage === "github_research"
    );
    const run = {
      id: runId,
      type: "pipeline",
      createdAt: startedAt,
      payload: p,
      output: {
        ok,
        stageResults,
        scout: scoutRepos,
        benchmark: benchmarkRanked,
        github: githubReport,
        reddit: redditReport,
        fusion,
        blueprint,
      },
    };

    appState.runs.unshift(run);
    trimHistory();
    persistDataStore();

    return res.json({
      ok,
      runId,
      stageResults,
      scout: scoutRepos,
      benchmark: benchmarkRanked,
      github: githubReport,
      reddit: redditReport,
      fusion,
      blueprint,
    });
  });

  app.post("/api/v1/masterpiece/magic-run", requireAuth, async (req, res) => {
    const parsed = MagicRunSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    const p = parsed.data;
    if (Number(p?.constraints?.budgetUsd || 0) > MAGIC_RUN_MAX_BUDGET_USD) {
      return res.status(400).json({
        ok: false,
        error: "budget_cap_exceeded",
        detail: `budgetUsd exceeds cap (${MAGIC_RUN_MAX_BUDGET_USD})`,
      });
    }

    const idempotencyKey = String(p.idempotencyKey || "").trim();
    if (idempotencyKey) {
      const prior = appState.runs.find((r) => r.type === "magic_pipeline" && String(r?.payload?.idempotencyKey || "") === idempotencyKey);
      if (prior?.output) {
        return res.json({ ok: true, runId: prior.id, idempotentReplay: true, ...prior.output });
      }
    }

    const startedMs = Date.now();
    const queries = [
      `${p.productName} open source agent builder`,
      `${p.productName} dashboard chat workflow`,
      "best open source AI builder orchestration",
    ];
    const timeoutTierConfig = {
      fast: { perQuery: 12, topK: 10, maxResults: 30, redditLimit: 16 },
      standard: { perQuery: 18, topK: 12, maxResults: 45, redditLimit: 24 },
      deep: { perQuery: 24, topK: 14, maxResults: 60, redditLimit: 32 },
    }[p.timeoutTier || "fast"];

    const seedRepos = topViralBenchmarkSeeds(12);
    const scoutCacheKey = deterministicHash({
      mode: "magic_scout",
      timeoutTier: p.timeoutTier,
      queries,
      seedRepos: seedRepos.map((r) => r.full_name),
    });

    let scoutRepos = getCache(MAGIC_RUN_SCOUT_CACHE, scoutCacheKey) || [];
    try {
      if (!scoutRepos.length) {
        const discovered = await discoverScoutRepos({
          queries,
          perQuery: timeoutTierConfig.perQuery,
          minStars: 500,
          topK: timeoutTierConfig.topK,
          seedRepos,
          githubToken: GITHUB_TOKEN,
        });
        scoutRepos = deterministicRepoSort(discovered)
          .filter((r) => Number(r.stargazers_count || r.stars || 0) >= 500)
          .slice(0, timeoutTierConfig.topK)
          .map((r) => ({
            full_name: r.full_name,
            name: r.name,
            stars: Number(r.stargazers_count || r.stars || 0),
            forks: Number(r.forks_count || r.forks || 0),
            description: r.description || "",
            topics: Array.isArray(r.topics) ? r.topics : [],
          }));
        setCache(MAGIC_RUN_SCOUT_CACHE, scoutCacheKey, scoutRepos);
      }
    } catch (err) {
      return res.status(502).json({ ok: false, error: "magic_scout_failed", detail: String(err?.message || err) });
    }

    const benchCacheKey = deterministicHash({
      mode: "magic_bench",
      scout: scoutRepos.map((r) => [r.full_name, Number(r.stars || 0), Number(r.uiEvidence || 0)]),
    });
    let benchmark = getCache(MAGIC_RUN_BENCH_CACHE, benchCacheKey);
    if (!benchmark) {
      benchmark = deterministicRepoSort(benchmarkRepos(scoutRepos, 0.62, 0.38)).slice(0, timeoutTierConfig.topK);
      setCache(MAGIC_RUN_BENCH_CACHE, benchCacheKey, benchmark);
    }

    let githubReport = null;
    let redditReport = null;
    try {
      githubReport = await runGithubResearch({
        query: `${p.productName} ${p.userGoal}`.slice(0, 260),
        perPage: 20,
        maxResults: timeoutTierConfig.maxResults,
        githubToken: GITHUB_TOKEN,
      });
    } catch {
      githubReport = null;
    }
    try {
      redditReport = await runRedditResearch({
        query: `${p.productName} ${p.userGoal} builder workflow`.slice(0, 260),
        subreddits: REDDIT_DEFAULT_SUBREDDITS,
        limitPerSubreddit: timeoutTierConfig.redditLimit,
        timeWindow: "year",
        maxResults: timeoutTierConfig.maxResults,
        redditUserAgent: REDDIT_USER_AGENT,
        redditAuthProfiles,
        redditRequestTimeoutMs: REDDIT_REQUEST_TIMEOUT_MS,
      });
    } catch {
      redditReport = null;
    }

    const fusion = buildFusionLeaderboard({
      benchmarkRepos: benchmark,
      githubReport,
      redditReport,
      topK: 10,
    });

    const selectedRepos = deterministicRepoSort(
      Array.isArray(fusion?.leaderboard) && fusion.leaderboard.length
        ? fusion.leaderboard.map((x) => ({ full_name: x.full_name, benchmarkScore: x.fusionScore }))
        : benchmark
    ).slice(0, 6);
    const evidence = buildEvidencePack({ githubReport, redditReport, fusion });
    const decisionCitations = buildDecisionCitations({ selectedRepos, evidence });

    const baseBlueprint = buildExecutableBlueprint({
      productName: p.productName,
      userGoal: p.userGoal,
      stack: p.stack,
      selectedRepos,
      evidence,
      constraints: p.constraints,
    });
    baseBlueprint.decisionCitations = decisionCitations;

    let evaluation = evaluateBlueprint(baseBlueprint);
    const autoRepair = [];
    let blueprint = baseBlueprint;
    if (!evaluation.pass) {
      autoRepair.push("Added conservative rollout and stricter test coverage requirements.");
      blueprint = {
        ...baseBlueprint,
        executable: {
          ...baseBlueprint.executable,
          testPlan: [...(baseBlueprint.executable?.testPlan || []), "Run golden-input determinism tests on every release."],
          rollout: [...(baseBlueprint.executable?.rollout || []), "Fail closed if quality score is below threshold in production."],
        },
      };
      evaluation = evaluateBlueprint(blueprint);
    }

    const blueprintValidation = BlueprintSchema.safeParse(blueprint);
    if (!blueprintValidation.success) {
      return res.status(422).json({
        ok: false,
        error: "blueprint_invalid",
        details: blueprintValidation.error.flatten(),
      });
    }

    const executionBridge = buildExecutionBridge(blueprint);
    const taskValidation = z.array(ExecutionTaskSchema).safeParse(executionBridge.tasks);
    if (!taskValidation.success) {
      return res.status(422).json({
        ok: false,
        error: "execution_tasks_invalid",
        details: taskValidation.error.flatten(),
      });
    }
    const projectKey = normalizeProjectKey(p.productName);
    const planHash = deterministicHash({
      productName: p.productName,
      userGoal: p.userGoal,
      stack: p.stack,
      constraints: p.constraints,
      selectedRepos: selectedRepos.map((r) => r.full_name),
    });

    const memory = appState.projectMemory[projectKey] || {
      decisions: [],
      acceptedDecisions: [],
      rejectedOptions: [],
      hardConstraints: {},
      constraints: {},
      history: [],
    };
    const updatedMemory = {
      ...memory,
      projectKey,
      updatedAt: new Date().toISOString(),
      hardConstraints: {
        ...(memory.hardConstraints || {}),
        budgetUsd: p.constraints.budgetUsd,
        deadlineDays: p.constraints.deadlineDays,
        teamSize: p.constraints.teamSize,
      },
      constraints: p.constraints,
      decisions: [
        ...memory.decisions.slice(-20),
        `Selected top repos: ${selectedRepos.map((r) => r.full_name).join(", ")}`,
      ].slice(-30),
      acceptedDecisions: [
        ...(Array.isArray(memory.acceptedDecisions) ? memory.acceptedDecisions.slice(-20) : []),
        {
          at: new Date().toISOString(),
          decision: "repo_selection",
          value: selectedRepos.map((r) => r.full_name),
          citations: decisionCitations.repo_selection,
        },
      ].slice(-30),
      rejectedOptions: Array.isArray(memory.rejectedOptions) ? memory.rejectedOptions.slice(-30) : [],
      history: [
        ...(Array.isArray(memory.history) ? memory.history.slice(-20) : []),
        { at: new Date().toISOString(), planHash, runType: "magic_run", score: evaluation.score },
      ].slice(-30),
      latestPlanHash: planHash,
    };
    appState.projectMemory[projectKey] = updatedMemory;

    const output = {
      mode: "magic_run_v2",
      productFocus: "deterministic_magic_run",
      planHash,
      deterministic: Boolean(p.deterministic),
      timeToFirstWowMs: Date.now() - startedMs,
      qualityScore: evaluation.score,
      constraints: p.constraints,
      blueprint,
      evaluation,
      autoRepair,
      executionBridge,
      benchmark,
      fusion,
      evidence,
      projectMemory: {
        projectKey,
        latestPlanHash: updatedMemory.latestPlanHash,
        decisionCount: updatedMemory.decisions.length,
      },
      markdownPlan: [
        `# ${p.productName} - Magic Run Plan`,
        "",
        `Goal: ${p.userGoal}`,
        `Plan Hash: ${planHash}`,
        `Quality Score: ${evaluation.score}`,
        "",
        "## Top Repos",
        ...selectedRepos.map((r) => `- ${r.full_name} (${Number(r.benchmarkScore || 0).toFixed(2)})`),
        "",
        "## Execution Tasks",
        ...executionBridge.tasks.map((t) => `- [P${t.priority}] ${t.owner}: ${t.title}`),
      ].join("\n"),
    };

    const run = {
      id: nowId("magic"),
      type: "magic_pipeline",
      createdAt: new Date().toISOString(),
      payload: p,
      output,
    };
    appState.runs.unshift(run);
    trimHistory();
    persistDataStore();
    return res.json({ ok: true, runId: run.id, ...output });
  });

  app.post("/api/v1/masterpiece/recompile", requireAuth, (req, res) => {
    const parsed = RecompileSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
    const p = parsed.data;
    const base = appState.runs.find((r) => r.id === p.runId && r.type === "magic_pipeline");
    if (!base) return res.status(404).json({ ok: false, error: "run_not_found" });

    const prior = base.output || {};
    const mergedConstraints = {
      ...(prior.constraints || {}),
      ...(appState.projectMemory[normalizeProjectKey(prior?.blueprint?.productName || "")]?.hardConstraints || {}),
      ...(p.constraints || {}),
    };
    const selectedRepos = deterministicRepoSort(prior?.blueprint?.selectedRepos || []).slice(0, 6);
    const blueprint = buildExecutableBlueprint({
      productName: prior?.blueprint?.productName || base.payload?.productName || "InayanBuilder",
      userGoal: prior?.blueprint?.objective || base.payload?.userGoal || "",
      stack: prior?.blueprint?.stack || base.payload?.stack || [],
      selectedRepos,
      evidence: prior?.evidence || { github: [], reddit: [], fusion: [] },
      constraints: mergedConstraints,
    });
    blueprint.decisionCitations = buildDecisionCitations({
      selectedRepos,
      evidence: prior?.evidence || { github: [], reddit: [], fusion: [] },
    });
    const evaluation = evaluateBlueprint(blueprint);
    const executionBridge = buildExecutionBridge(blueprint);
    const diff = {
      constraints_before: prior.constraints || {},
      constraints_after: mergedConstraints,
      changed_fields: Object.keys(mergedConstraints).filter((k) => JSON.stringify((prior.constraints || {})[k]) !== JSON.stringify(mergedConstraints[k])),
      memory_applied: appState.projectMemory[normalizeProjectKey(prior?.blueprint?.productName || "")]?.hardConstraints || {},
    };
    const planHash = deterministicHash({
      runId: p.runId,
      constraints: mergedConstraints,
      selectedRepos: selectedRepos.map((r) => r.full_name),
      notes: p.notes || "",
    });

    const run = {
      id: nowId("recompile"),
      type: "magic_recompile",
      createdAt: new Date().toISOString(),
      payload: p,
      output: {
        planHash,
        qualityScore: evaluation.score,
        diff,
        blueprint,
        evaluation,
        executionBridge,
      },
    };
    appState.runs.unshift(run);
    trimHistory();
    persistDataStore();
    return res.json({ ok: true, runId: run.id, ...run.output });
  });

  app.get("/api/v1/masterpiece/magic-run/demo", requireAuth, (_req, res) => {
    const selectedRepos = topViralBenchmarkSeeds(6).map((r) => ({
      full_name: r.full_name,
      benchmarkScore: roundNumber(Math.log10(Math.max(1, Number(r.stargazers_count || 1))) * 22, 2),
    }));
    const evidence = {
      github: [
        { title: "Open-source agent runtime patterns", rank_score: 0.91, url: "https://github.com/anthropics/claude-code" },
        { title: "MCP ecosystem traction", rank_score: 0.89, url: "https://github.com/punkpeye/awesome-mcp-servers" },
      ],
      reddit: [
        { title: "Practical MCP integrations with measurable utility", subreddit: "LocalLLaMA", rank_score: 0.85, url: "https://www.reddit.com/r/LocalLLaMA/" },
      ],
      fusion: selectedRepos.slice(0, 4).map((r) => ({ repo: r.full_name, score: Number(r.benchmarkScore || 0), reasons: ["high OSS signal"] })),
    };
    const decisionCitations = buildDecisionCitations({ selectedRepos, evidence });
    const blueprint = buildExecutableBlueprint({
      productName: "InayanBuilder Demo",
      userGoal: "Build a deterministic AI builder pipeline that outputs executable plans from market signals.",
      stack: ["node", "typescript", "postgres", "react"],
      selectedRepos,
      evidence,
      constraints: { budgetUsd: 5000, deadlineDays: 14, teamSize: 2 },
    });
    blueprint.decisionCitations = decisionCitations;
    const evaluation = evaluateBlueprint(blueprint);
    const executionBridge = buildExecutionBridge(blueprint);
    const planHash = deterministicHash({ demo: true, repos: selectedRepos.map((r) => r.full_name) });
    return res.json({
      ok: true,
      demo: true,
      productFocus: "deterministic_magic_run",
      planHash,
      deterministic: true,
      timeToFirstWowMs: 200,
      qualityScore: evaluation.score,
      blueprint,
      evaluation,
      executionBridge,
      markdownPlan: [
        "# InayanBuilder Demo - Deterministic Magic Run",
        "",
        `Plan Hash: ${planHash}`,
        `Quality Score: ${evaluation.score}`,
      ].join("\n"),
    });
  });

  app.get("/api/v1/product/focus", requireAuth, (_req, res) => {
    return res.json({
      ok: true,
      primaryExperience: "deterministic_magic_run",
      hiddenByDefault: [
        "/api/v1/scout/run",
        "/api/v1/benchmark/run",
        "/api/v1/github/research",
        "/api/v1/reddit/search",
      ],
      rationale: "single headline flow for fastest activation and clearer product signal",
    });
  });

  app.get("/api/v1/projects/:projectKey/memory", requireAuth, (req, res) => {
    const key = normalizeProjectKey(req.params.projectKey);
    const memory = appState.projectMemory[key];
    if (!memory) return res.status(404).json({ ok: false, error: "project_memory_not_found" });
    return res.json({ ok: true, projectKey: key, memory });
  });

  const redactSensitiveError = (value) => String(value || "")
    .replace(/Bearer\\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "[REDACTED_KEY]");

  const executeChatReply = async ({ message, context, provider, model, temperature, sessionId }) => {
    if (!OPENAI_API_KEY && !DEEPSEEK_API_KEY && !ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
      const err = new Error("chat_model_not_configured");
      err.status = 503;
      throw err;
    }
    const latestPipeline = appState.runs.find((r) => r.type === "pipeline");
    const session = ensureChatSession(sessionId);
    appendSessionMessage(session, "user", message);
    const modelResult = await generateModelReply({
      message,
      context,
      latestPipeline,
      allRuns: appState.runs,
      clawArchitectRoot: CLAW_ARCHITECT_ROOT,
      providerPreference: provider,
      modelOverride: model,
      temperature,
      openaiApiKey: OPENAI_API_KEY,
      deepseekApiKey: DEEPSEEK_API_KEY,
      anthropicApiKey: ANTHROPIC_API_KEY,
      geminiApiKey: GEMINI_API_KEY,
      openaiModel: OPENAI_CHAT_MODEL,
      deepseekModel: DEEPSEEK_CHAT_MODEL,
      anthropicModel: ANTHROPIC_CHAT_MODEL,
      geminiModel: GEMINI_CHAT_MODEL,
      providerMetrics: appState.providerMetrics,
      providerStatus,
      sessionHistory: getSessionHistory(session, 8),
    });
    appendSessionMessage(session, "assistant", modelResult.reply, {
      provider: modelResult.provider,
      model: modelResult.model,
      latencyMs: modelResult.latencyMs,
      estimatedCostUsd: modelResult.estimatedCostUsd,
      inputTokens: modelResult.inputTokens,
      outputTokens: modelResult.outputTokens,
    });
    const chat = {
      id: nowId("chat"),
      sessionId: session.id,
      at: new Date().toISOString(),
      message,
      context: context || null,
      reply: modelResult.reply,
      provider: modelResult.provider,
      model: modelResult.model,
      latencyMs: modelResult.latencyMs,
      estimatedCostUsd: modelResult.estimatedCostUsd,
      inputTokens: modelResult.inputTokens,
      outputTokens: modelResult.outputTokens,
    };
    appState.chats.unshift(chat);
    trimHistory();
    persistDataStore();
    return { chat, session, modelResult };
  };

  app.post("/api/v1/chat/reply", requireAuth, async (req, res) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

    const { message, context, provider, model, temperature, sessionId } = parsed.data;
    try {
      const result = await executeChatReply({ message, context, provider, model, temperature, sessionId });
      return res.json({
        ok: true,
        reply: result.modelResult.reply,
        sessionId: result.session.id,
        provider: result.modelResult.provider,
        model: result.modelResult.model,
        latencyMs: result.modelResult.latencyMs,
        estimatedCostUsd: result.modelResult.estimatedCostUsd,
        chat: result.chat,
      });
    } catch (err) {
      if (err?.status === 503 && String(err?.message) === "chat_model_not_configured") {
        return res.status(503).json({
          ok: false,
          error: "chat_model_not_configured",
          detail: "Set OPENAI_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in environment.",
        });
      }
      return res.status(502).json({
        ok: false,
        error: "chat_provider_failed",
        detail: redactSensitiveError(String(err?.message || err)),
      });
    }
  });

  app.post("/api/v1/chat/reply/stream", requireAuth, async (req, res) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
    const { message, context, provider, model, temperature, sessionId } = parsed.data;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendEvt = (event, payload) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const result = await executeChatReply({ message, context, provider, model, temperature, sessionId });
      sendEvt("start", {
        sessionId: result.session.id,
        provider: result.modelResult.provider,
        model: result.modelResult.model,
      });
      const text = String(result.modelResult.reply || "");
      const parts = text.match(/.{1,28}(\s|$)/g) || [text];
      for (const rawPart of parts) {
        const delta = rawPart || "";
        if (!delta) continue;
        sendEvt("chunk", { delta });
        await sleep(12);
      }
      sendEvt("done", {
        reply: text,
        sessionId: result.session.id,
        provider: result.modelResult.provider,
        model: result.modelResult.model,
        latencyMs: result.modelResult.latencyMs,
        estimatedCostUsd: result.modelResult.estimatedCostUsd,
      });
      return res.end();
    } catch (err) {
      const code = err?.status === 503 ? "chat_model_not_configured" : "chat_provider_failed";
      sendEvt("error", {
        code,
        detail: redactSensitiveError(String(err?.message || err)),
      });
      return res.end();
    }
  });

  app.get("/api/v1/chat/history", requireAuth, (_req, res) => {
    return res.json({ ok: true, count: appState.chats.length, history: appState.chats });
  });

  app.get("/api/v1/chat/sessions", requireAuth, (_req, res) => {
    const sessions = Object.values(appState.chatSessions || {})
      .map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
        lastMessage: Array.isArray(s.messages) && s.messages.length
          ? String(s.messages[s.messages.length - 1]?.content || "").slice(0, 120)
          : "",
      }))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    return res.json({ ok: true, count: sessions.length, sessions });
  });

  app.get("/api/v1/chat/sessions/:sessionId", requireAuth, (req, res) => {
    const id = String(req.params.sessionId || "");
    const session = appState.chatSessions[id];
    if (!session) return res.status(404).json({ ok: false, error: "session_not_found" });
    return res.json({ ok: true, session });
  });

  app.get("/api/v1/runs", requireAuth, (_req, res) => {
    return res.json({ ok: true, count: appState.runs.length, runs: appState.runs });
  });

  app.get("/api/v1/chat/providers", requireAuth, (_req, res) => {
    return res.json({ ok: true, ...providerStatus, metrics: appState.providerMetrics });
  });

  app.get("/health", (_req, res) => {
    const configuredCount = Object.values(providerStatus.providers).filter((p) => p.configured).length;
    return res.json({
      ok: true,
      service: "inayanbuilderbot-masterpiece",
      env: NODE_ENV,
      claw_architect_root: CLAW_ARCHITECT_ROOT,
      chat_provider_count: configuredCount,
      time: new Date().toISOString(),
    });
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
