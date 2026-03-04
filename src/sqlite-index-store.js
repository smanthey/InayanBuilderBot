import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function nowIso() {
  return new Date().toISOString();
}

function toJson(value) {
  try {
    return JSON.stringify(value == null ? null : value);
  } catch {
    return "null";
  }
}

function likeQuery(input) {
  return `%${String(input || "").trim().toLowerCase()}%`;
}

function parseMaybeJson(text, fallback = null) {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sanitizeRepo(repo = {}) {
  return {
    full_name: String(repo.full_name || "").trim(),
    name: String(repo.name || String(repo.full_name || "").split("/").pop() || "").trim(),
    description: String(repo.description || "").slice(0, 1000),
    stars: Number(repo.stargazers_count || repo.stars || 0) || 0,
    language: repo.language ? String(repo.language).slice(0, 80) : null,
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 40) : [],
    signals: Array.isArray(repo.signals) ? repo.signals.slice(0, 80) : [],
    categories: Array.isArray(repo.categories) ? repo.categories.slice(0, 80) : [],
  };
}

export function createSqliteIndexStore({
  dbPath,
  enabled = true,
} = {}) {
  if (!enabled) {
    return { enabled: false, reason: "disabled" };
  }

  const resolvedPath = path.resolve(String(dbPath || "./.data/inayan-index.db"));
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      full_name TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      stars INTEGER NOT NULL DEFAULT 0,
      language TEXT,
      topics_json TEXT NOT NULL DEFAULT '[]',
      signals_json TEXT NOT NULL DEFAULT '[]',
      categories_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      full_name TEXT NOT NULL,
      benchmark_score REAL,
      fusion_score REAL,
      ui_evidence REAL,
      break_pattern_evidence REAL,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_github (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      repo_full_name TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      score REAL NOT NULL DEFAULT 0,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_reddit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      subreddit TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      score REAL NOT NULL DEFAULT 0,
      relevance_weight REAL NOT NULL DEFAULT 0,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_memory (
      project_key TEXT PRIMARY KEY,
      accepted_decisions_json TEXT NOT NULL DEFAULT '[]',
      rejected_options_json TEXT NOT NULL DEFAULT '[]',
      hard_constraints_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS query_cache (
      cache_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      query TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stars DESC);
    CREATE INDEX IF NOT EXISTS idx_repos_updated ON repos(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_run_id ON repo_snapshots(run_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_github_query ON evidence_github(query);
    CREATE INDEX IF NOT EXISTS idx_evidence_reddit_query ON evidence_reddit(query);
    CREATE INDEX IF NOT EXISTS idx_query_cache_source ON query_cache(source);
  `);

  const upsertRepoStmt = db.prepare(`
    INSERT INTO repos (
      full_name, name, description, stars, language, topics_json, signals_json, categories_json, source, last_seen_at, created_at, updated_at
    ) VALUES (
      @full_name, @name, @description, @stars, @language, @topics_json, @signals_json, @categories_json, @source, @last_seen_at, @created_at, @updated_at
    )
    ON CONFLICT(full_name) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      stars = excluded.stars,
      language = excluded.language,
      topics_json = excluded.topics_json,
      signals_json = excluded.signals_json,
      categories_json = excluded.categories_json,
      source = excluded.source,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at;
  `);

  const insertSnapshotStmt = db.prepare(`
    INSERT INTO repo_snapshots (
      run_id, stage, full_name, benchmark_score, fusion_score, ui_evidence, break_pattern_evidence, captured_at
    ) VALUES (
      @run_id, @stage, @full_name, @benchmark_score, @fusion_score, @ui_evidence, @break_pattern_evidence, @captured_at
    );
  `);

  const insertGithubEvidenceStmt = db.prepare(`
    INSERT INTO evidence_github (
      query, repo_full_name, title, url, snippet, score, captured_at
    ) VALUES (
      @query, @repo_full_name, @title, @url, @snippet, @score, @captured_at
    );
  `);

  const insertRedditEvidenceStmt = db.prepare(`
    INSERT INTO evidence_reddit (
      query, subreddit, title, url, snippet, score, relevance_weight, captured_at
    ) VALUES (
      @query, @subreddit, @title, @url, @snippet, @score, @relevance_weight, @captured_at
    );
  `);

  const upsertProjectMemoryStmt = db.prepare(`
    INSERT INTO project_memory (
      project_key, accepted_decisions_json, rejected_options_json, hard_constraints_json, updated_at, created_at
    ) VALUES (
      @project_key, @accepted_decisions_json, @rejected_options_json, @hard_constraints_json, @updated_at, @created_at
    )
    ON CONFLICT(project_key) DO UPDATE SET
      accepted_decisions_json = excluded.accepted_decisions_json,
      rejected_options_json = excluded.rejected_options_json,
      hard_constraints_json = excluded.hard_constraints_json,
      updated_at = excluded.updated_at;
  `);

  const upsertQueryCacheStmt = db.prepare(`
    INSERT INTO query_cache (
      cache_key, source, query, payload_json, expires_at, updated_at, created_at
    ) VALUES (
      @cache_key, @source, @query, @payload_json, @expires_at, @updated_at, @created_at
    )
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at;
  `);

  const txUpsertRepos = db.transaction((repos, source) => {
    const now = nowIso();
    for (const raw of repos) {
      const r = sanitizeRepo(raw);
      if (!r.full_name) continue;
      upsertRepoStmt.run({
        ...r,
        source: String(source || "unknown"),
        topics_json: toJson(r.topics),
        signals_json: toJson(r.signals),
        categories_json: toJson(r.categories),
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      });
    }
  });

  const txInsertSnapshots = db.transaction((snapshots) => {
    const capturedAt = nowIso();
    for (const s of snapshots) {
      if (!s?.full_name || !s?.run_id || !s?.stage) continue;
      insertSnapshotStmt.run({
        run_id: String(s.run_id),
        stage: String(s.stage),
        full_name: String(s.full_name),
        benchmark_score: Number(s.benchmark_score || 0) || 0,
        fusion_score: Number(s.fusion_score || 0) || 0,
        ui_evidence: Number(s.ui_evidence || 0) || 0,
        break_pattern_evidence: Number(s.break_pattern_evidence || 0) || 0,
        captured_at: capturedAt,
      });
    }
  });

  const txInsertGithubEvidence = db.transaction((query, repos, answers) => {
    const capturedAt = nowIso();
    for (const row of Array.isArray(repos) ? repos : []) {
      insertGithubEvidenceStmt.run({
        query: String(query || ""),
        repo_full_name: String(row?.full_name || ""),
        title: String(row?.full_name || "repo"),
        url: String(row?.html_url || ""),
        snippet: String(row?.description || "").slice(0, 1200),
        score: Number(row?.score || row?.stargazers_count || 0) || 0,
        captured_at: capturedAt,
      });
    }
    for (const row of Array.isArray(answers) ? answers : []) {
      insertGithubEvidenceStmt.run({
        query: String(query || ""),
        repo_full_name: String(row?.repository || row?.repo || ""),
        title: String(row?.title || row?.url || "issue_or_pr"),
        url: String(row?.url || ""),
        snippet: String(row?.snippet || row?.body || "").slice(0, 1200),
        score: Number(row?.score || 0) || 0,
        captured_at: capturedAt,
      });
    }
  });

  const txInsertRedditEvidence = db.transaction((query, posts) => {
    const capturedAt = nowIso();
    for (const row of Array.isArray(posts) ? posts : []) {
      insertRedditEvidenceStmt.run({
        query: String(query || ""),
        subreddit: String(row?.subreddit || ""),
        title: String(row?.title || "").slice(0, 600),
        url: String(row?.url || row?.permalink || ""),
        snippet: String(row?.selftext || row?.body || "").slice(0, 1200),
        score: Number(row?.score || row?.rank_score || 0) || 0,
        relevance_weight: Number(row?.relevance_weight || 0) || 0,
        captured_at: capturedAt,
      });
    }
  });

  return {
    enabled: true,
    dbPath: resolvedPath,
    close() {
      db.close();
    },
    refreshRepos({ repos = [], source = "unknown" } = {}) {
      txUpsertRepos(Array.isArray(repos) ? repos : [], source);
      return { insertedOrUpdated: Array.isArray(repos) ? repos.length : 0 };
    },
    saveSnapshots({ runId, stage, repos = [] } = {}) {
      const rows = (Array.isArray(repos) ? repos : []).map((r) => ({
        run_id: String(runId || ""),
        stage: String(stage || ""),
        full_name: String(r?.full_name || ""),
        benchmark_score: Number(r?.benchmarkScore || r?.benchmark_score || 0),
        fusion_score: Number(r?.fusionScore || r?.fusion_score || 0),
        ui_evidence: Number(r?.uiEvidence || r?.ui_evidence || 0),
        break_pattern_evidence: Number(r?.breakPatternEvidence || r?.break_pattern_evidence || 0),
      }));
      txInsertSnapshots(rows);
      return { inserted: rows.length };
    },
    saveGithubEvidence({ query, report } = {}) {
      txInsertGithubEvidence(String(query || ""), report?.repo_results || report?.repos || [], report?.answer_results || report?.answers || []);
    },
    saveRedditEvidence({ query, report } = {}) {
      txInsertRedditEvidence(String(query || ""), report?.posts || report?.results || []);
    },
    upsertProjectMemory({ projectKey, memory } = {}) {
      if (!projectKey) return;
      const now = nowIso();
      upsertProjectMemoryStmt.run({
        project_key: String(projectKey),
        accepted_decisions_json: toJson(memory?.acceptedDecisions || []),
        rejected_options_json: toJson(memory?.rejectedOptions || []),
        hard_constraints_json: toJson(memory?.hardConstraints || {}),
        updated_at: now,
        created_at: now,
      });
    },
    setQueryCache({ cacheKey, source, query, payload, ttlSeconds = 900 } = {}) {
      if (!cacheKey || !source) return;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + Math.max(1, Number(ttlSeconds || 900)) * 1000);
      upsertQueryCacheStmt.run({
        cache_key: String(cacheKey),
        source: String(source),
        query: String(query || ""),
        payload_json: toJson(payload || {}),
        expires_at: expiresAt.toISOString(),
        updated_at: now.toISOString(),
        created_at: now.toISOString(),
      });
    },
    getQueryCache({ cacheKey } = {}) {
      if (!cacheKey) return null;
      const row = db.prepare("SELECT payload_json, expires_at FROM query_cache WHERE cache_key = ?").get(String(cacheKey));
      if (!row) return null;
      if (Date.parse(String(row.expires_at || "")) <= Date.now()) return null;
      return parseMaybeJson(row.payload_json, null);
    },
    search({ q, limit = 20 } = {}) {
      const query = String(q || "").trim();
      if (!query) {
        return { repos: [], githubEvidence: [], redditEvidence: [] };
      }
      const max = Math.max(1, Math.min(100, Number(limit || 20)));
      const like = likeQuery(query);
      const repos = db.prepare(`
        SELECT full_name, name, description, stars, language, topics_json, signals_json, categories_json, source, updated_at
        FROM repos
        WHERE lower(full_name) LIKE @like OR lower(name) LIKE @like OR lower(description) LIKE @like
        ORDER BY stars DESC, updated_at DESC
        LIMIT @limit
      `).all({ like, limit: max }).map((row) => ({
        ...row,
        topics: parseMaybeJson(row.topics_json, []),
        signals: parseMaybeJson(row.signals_json, []),
        categories: parseMaybeJson(row.categories_json, []),
      }));
      const githubEvidence = db.prepare(`
        SELECT query, repo_full_name, title, url, snippet, score, captured_at
        FROM evidence_github
        WHERE lower(query) LIKE @like OR lower(title) LIKE @like OR lower(snippet) LIKE @like
        ORDER BY captured_at DESC
        LIMIT @limit
      `).all({ like, limit: max });
      const redditEvidence = db.prepare(`
        SELECT query, subreddit, title, url, snippet, score, relevance_weight, captured_at
        FROM evidence_reddit
        WHERE lower(query) LIKE @like OR lower(title) LIKE @like OR lower(snippet) LIKE @like
        ORDER BY captured_at DESC
        LIMIT @limit
      `).all({ like, limit: max });
      return { repos, githubEvidence, redditEvidence };
    },
    stats() {
      const counts = {
        repos: db.prepare("SELECT COUNT(*) as c FROM repos").get().c || 0,
        snapshots: db.prepare("SELECT COUNT(*) as c FROM repo_snapshots").get().c || 0,
        githubEvidence: db.prepare("SELECT COUNT(*) as c FROM evidence_github").get().c || 0,
        redditEvidence: db.prepare("SELECT COUNT(*) as c FROM evidence_reddit").get().c || 0,
        projectMemory: db.prepare("SELECT COUNT(*) as c FROM project_memory").get().c || 0,
        queryCache: db.prepare("SELECT COUNT(*) as c FROM query_cache").get().c || 0,
      };
      const lastUpdated = db.prepare("SELECT MAX(updated_at) as v FROM repos").get().v || null;
      return {
        dbPath: resolvedPath,
        counts,
        lastRepoUpdatedAt: lastUpdated,
      };
    },
    refreshFromRuns({ runs = [] } = {}) {
      const repos = [];
      for (const run of Array.isArray(runs) ? runs : []) {
        const output = run?.output || {};
        const sets = [output.scout, output.benchmark, output.selectedRepos];
        for (const set of sets) {
          for (const repo of Array.isArray(set) ? set : []) repos.push(repo);
        }
      }
      txUpsertRepos(repos, "runs");
      return { insertedOrUpdated: repos.length };
    },
  };
}

