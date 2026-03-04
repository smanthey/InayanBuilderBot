import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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

const DEFAULT_PORT = Number(process.env.PORT || 3000);
const CLAW_ARCHITECT_ROOT = process.env.CLAW_ARCHITECT_ROOT || "/Users/tatsheen/claw-architect";

const appState = {
  runs: [],
  chats: [],
  chatSessions: {},
  providerMetrics: {},
};

function ensureDataStore() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(runsFile)) {
    fs.writeFileSync(
      runsFile,
      JSON.stringify({ runs: [], chats: [], chatSessions: {}, providerMetrics: {} }, null, 2)
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
  } catch {
    appState.runs = [];
    appState.chats = [];
    appState.chatSessions = {};
    appState.providerMetrics = {};
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

function computeUiEvidence(repo) {
  const text = `${repo.name || ""} ${repo.description || ""} ${(repo.topics || []).join(" ")}`.toLowerCase();
  const checks = [
    ["dashboard", 3],
    ["chat", 3],
    ["web ui", 2],
    ["admin", 2],
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

function scoreRepo(repo) {
  const stars = Number(repo.stargazers_count || repo.stars || 0);
  const forks = Number(repo.forks_count || repo.forks || 0);
  const updatedAt = Date.parse(repo.pushed_at || 0);
  const recencyDays = Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 86400000) : 9999;
  const recencyScore = Math.max(0, 25 - Math.min(25, recencyDays / 10));
  const ui = computeUiEvidence(repo);

  const frameworkOnly = /(sdk|framework|runtime|toolkit|library|engine)/i.test(`${repo.name || ""} ${repo.description || ""}`)
    && ui.evidence < 5;

  const score =
    Math.log10(Math.max(1, stars)) * 42 +
    Math.log10(Math.max(1, forks + 1)) * 10 +
    recencyScore +
    ui.evidence * 4 -
    (frameworkOnly ? 22 : 0);

  return {
    score: Math.round(score * 100) / 100,
    uiEvidence: ui.evidence,
    uiHits: ui.hits,
    frameworkOnly,
  };
}

function benchmarkRepos(repos, weightUi = 0.58, weightPopularity = 0.42) {
  const maxStars = Math.max(...repos.map((r) => Number(r.stars || r.stargazers_count || 0)), 1);
  return repos
    .map((r) => {
      const uiNorm = Math.min(1, Number(r.uiEvidence || 0) / 14);
      const popNorm = Number(r.stars || r.stargazers_count || 0) / maxStars;
      const benchmarkScore = Math.round((uiNorm * weightUi + popNorm * weightPopularity) * 10000) / 100;
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

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectRepoIntelContext({ latestPipeline, allRuns, clawArchitectRoot }) {
  const latestScout = allRuns.find((r) => r.type === "scout");
  const latestBench = allRuns.find((r) => r.type === "benchmark");

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
    external: externalIntel,
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
    "Never invent secrets. Never return API keys.",
  ].join(" ");

  const userPrompt = JSON.stringify({
    message,
    context: context || {},
    session_history: Array.isArray(sessionHistory) ? sessionHistory : [],
    repo_intel_context: intel,
    guidance_focus: [
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
    stars: z.number().optional(),
    stargazers_count: z.number().optional(),
    uiEvidence: z.number().optional(),
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
  seedRepos: ScoutSchema.shape.seedRepos,
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
  const EXTERNAL_INDEXING_MODE = (process.env.EXTERNAL_INDEXING_MODE || "auto").trim().toLowerCase();
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

  app.post("/api/v1/scout/run", requireAuth, async (req, res) => {
    try {
      const parsed = ScoutSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });

      const p = parsed.data;
      const discovered = [];
      if (Array.isArray(p.seedRepos) && p.seedRepos.length > 0) {
        discovered.push(...p.seedRepos);
      } else {
        for (const q of p.queries) {
          const items = await githubSearch({ query: q, perPage: p.perQuery, githubToken: GITHUB_TOKEN });
          for (const item of items) {
            if (item.archived || item.disabled) continue;
            if (Number(item.stargazers_count || 0) < p.minStars) continue;
            discovered.push(item);
          }
        }
      }

      const dedup = new Map();
      for (const repo of discovered) {
        const key = String(repo.full_name || "").toLowerCase();
        if (!key || dedup.has(key)) continue;
        const scored = scoreRepo(repo);
        if (scored.frameworkOnly) continue;
        if (scored.uiEvidence < 5) continue;
        dedup.set(key, {
          full_name: repo.full_name,
          name: repo.name,
          html_url: repo.html_url,
          description: repo.description || "",
          stars: Number(repo.stargazers_count || 0),
          forks: Number(repo.forks_count || 0),
          language: repo.language || null,
          pushed_at: repo.pushed_at || null,
          topics: Array.isArray(repo.topics) ? repo.topics : [],
          score: scored.score,
          uiEvidence: scored.uiEvidence,
          uiHits: scored.uiHits,
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

    const scoutPayload = {
      queries: p.queries,
      perQuery: 15,
      minStars: p.minStars,
      topK: p.topK,
      seedRepos: p.seedRepos,
    };

    let scoutRepos = [];
    try {
      const discovered = [];
      if (Array.isArray(p.seedRepos) && p.seedRepos.length > 0) {
        discovered.push(...p.seedRepos);
      } else {
        for (const q of p.queries) {
          const items = await githubSearch({ query: q, perPage: 15, githubToken: GITHUB_TOKEN });
          discovered.push(...items);
        }
      }

      const dedup = new Map();
      for (const repo of discovered) {
        const key = String(repo.full_name || "").toLowerCase();
        if (!key || dedup.has(key)) continue;
        const scored = scoreRepo(repo);
        if (Number(repo.stargazers_count || 0) < p.minStars) continue;
        if (scored.frameworkOnly || scored.uiEvidence < 5) continue;
        dedup.set(key, {
          full_name: repo.full_name,
          name: repo.name,
          html_url: repo.html_url,
          description: repo.description || "",
          stars: Number(repo.stargazers_count || 0),
          forks: Number(repo.forks_count || 0),
          language: repo.language || null,
          pushed_at: repo.pushed_at || null,
          topics: Array.isArray(repo.topics) ? repo.topics : [],
          score: scored.score,
          uiEvidence: scored.uiEvidence,
          uiHits: scored.uiHits,
        });
      }
      scoutRepos = [...dedup.values()].sort((a, b) => b.score - a.score).slice(0, p.topK);
      stageResults.push({ stage: "scout", ok: true, detail: { count: scoutRepos.length, payload: scoutPayload } });
    } catch (err) {
      stageResults.push({ stage: "scout", ok: false, detail: { error: String(err?.message || err), payload: scoutPayload } });
    }

    let benchmarkRanked = [];
    if (scoutRepos.length > 0) {
      benchmarkRanked = benchmarkRepos(scoutRepos, 0.58, 0.42);
      stageResults.push({ stage: "benchmark", ok: true, detail: { count: benchmarkRanked.length } });
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
        ];

        for (const s of extSteps) {
          const r = await runCommand({ cmd: s.cmd, args: s.args, cwd: CLAW_ARCHITECT_ROOT, timeoutMs: 15 * 60 * 1000 });
          const parsedJson = parseTrailingJson(`${r.stdout}\n${r.stderr}`);
          stageResults.push({
            stage: `external_${s.name}`,
            ok: r.ok,
            detail: {
              code: r.code,
              timed_out: r.timed_out,
              parsed: parsedJson,
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
        external_stages: stageResults.filter((s) => s.stage.startsWith("external_")).length,
      },
      generatedAt: new Date().toISOString(),
    };

    const ok = stageResults.every((s) => s.ok || s.stage.startsWith("external_"));
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
        blueprint,
      },
    };

    appState.runs.unshift(run);
    trimHistory();
    persistDataStore();

    return res.json({ ok, runId, stageResults, scout: scoutRepos, benchmark: benchmarkRanked, blueprint });
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
