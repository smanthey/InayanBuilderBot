import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";

test("GET /health returns service metadata", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "inayanbuilderbot-masterpiece");
  assert.equal(typeof body.chat_provider_count, "number");

  server.close();
});

test("providers endpoint exposes configured flags without secrets", async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENAI_API_KEY;

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat/providers`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.aliases.claude, "anthropic");
  assert.equal(body.aliases.google, "gemini");
  assert.equal(typeof body.providers.openai.configured, "boolean");
  assert.equal(typeof body.providers.deepseek.configured, "boolean");
  assert.equal(typeof body.providers.anthropic.configured, "boolean");
  assert.equal(typeof body.providers.gemini.configured, "boolean");
  assert.equal("OPENAI_API_KEY" in body, false);

  server.close();
});

test("indexing capabilities endpoint reports builtin support", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/indexing/capabilities`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.indexing.builtinAdvancedIndexing, true);
  assert.equal(typeof body.indexing.mode, "string");

  server.close();
});

test("pipeline run works with seed repos and runExternal=false", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const seedRepos = [
    {
      full_name: "acme/dashboard-chat",
      name: "dashboard-chat",
      description: "Open source dashboard chat ui agent platform",
      stargazers_count: 2200,
      forks_count: 350,
      topics: ["dashboard", "chat", "react", "nextjs"],
      pushed_at: new Date().toISOString(),
    },
    {
      full_name: "acme/framework-only-sdk",
      name: "framework-only-sdk",
      description: "A runtime sdk framework library",
      stargazers_count: 8000,
      forks_count: 1200,
      topics: ["sdk", "framework", "runtime"],
      pushed_at: new Date().toISOString(),
    }
  ];

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/masterpiece/pipeline/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productName: "Inaya Test Product",
      userGoal: "Build robust dashboard and chat product with benchmark-first architecture.",
      stack: ["Node.js", "Express", "React"],
      queries: ["dashboard chat"],
      minStars: 500,
      topK: 5,
      runExternal: false,
      runGithubResearch: false,
      runRedditResearch: false,
      seedRepos,
    })
  });

  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(body.scout), true);
  assert.equal(body.scout.length, 1);
  assert.equal(body.scout[0].full_name, "acme/dashboard-chat");
  assert.equal(Array.isArray(body.benchmark), true);
  assert.equal(body.benchmark.length, 1);
  assert.equal(body.blueprint.productName, "Inaya Test Product");

  server.close();
});

test("pipeline run includes builtin advanced indexing when enabled", async () => {
  process.env.EXTERNAL_INDEXING_MODE = "builtin";

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const seedRepos = [
    {
      full_name: "acme/real-dashboard-chat",
      name: "real-dashboard-chat",
      description: "dashboard chat app with admin panel",
      stargazers_count: 3400,
      forks_count: 420,
      topics: ["dashboard", "chat", "react", "admin"],
      pushed_at: new Date().toISOString(),
    },
    {
      full_name: "acme/ui-workflow-bot",
      name: "ui-workflow-bot",
      description: "workflow dashboard for ai assistant with chat ui",
      stargazers_count: 2900,
      forks_count: 310,
      topics: ["workflow", "dashboard", "chat", "ai"],
      pushed_at: new Date().toISOString(),
    },
  ];

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/masterpiece/pipeline/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productName: "Inaya Index Product",
      userGoal: "Use builtin advanced indexing pipeline integration.",
      stack: ["Node.js", "Express", "React"],
      queries: ["dashboard chat ui"],
      minStars: 500,
      topK: 5,
      runExternal: true,
      runGithubResearch: false,
      runRedditResearch: false,
      seedRepos,
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(body.stageResults), true);
  const builtinStage = body.stageResults.find((s) => s.stage === "external_builtin_indexing");
  assert.equal(Boolean(builtinStage), true);
  assert.equal(builtinStage.ok, true);
  assert.equal(Number(builtinStage.detail.benchmarkedCount) > 0, true);

  server.close();
});

test("magic run includes Playwright-oriented E2E execution tasks", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/masterpiece/magic-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productName: "E2E Coverage Validation",
      userGoal: "Ensure execution plan includes Playwright tasks",
      stack: ["Node.js", "Express", "React"],
      constraints: {
        budgetUsd: 300,
        deadlineDays: 3,
        teamSize: 1,
      },
      timeoutTier: "fast",
      deterministic: true,
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);

  const tasks = Array.isArray(body.executionBridge?.tasks) ? body.executionBridge.tasks : [];
  const e2eTasks = tasks.filter((t) => /playwright|e2e/i.test(String(t?.title || "")));
  assert.equal(e2eTasks.length >= 1, true);
  assert.equal(e2eTasks.some((t) => (t.acceptance_criteria || []).some((c) => /planhash|qualityscore|timetofirstwowms/i.test(String(c)))), true);

  server.close();
});

test("reddit search endpoint returns ranked results", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url || "");
    if (target.includes("reddit.com/r/AI_Agents/search.json")) {
      return new Response(
        JSON.stringify({
          data: {
            children: [
              {
                data: {
                  id: "abc123",
                  title: "Best dashboard chat ui stack for agent builders",
                  subreddit: "AI_Agents",
                  permalink: "/r/AI_Agents/comments/abc123/best_dashboard_chat_ui/",
                  score: 144,
                  num_comments: 22,
                  upvote_ratio: 0.97,
                  created_utc: Math.floor(Date.now() / 1000) - 3600,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(url, options);
  };

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await originalFetch(`http://127.0.0.1:${port}/api/v1/reddit/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "dashboard chat ui",
        subreddits: ["AI_Agents"],
        limitPerSubreddit: 10,
        maxResults: 10,
        timeWindow: "year",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.runId, "string");
    assert.equal(Array.isArray(body.results), true);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].subreddit, "AI_Agents");
    assert.equal(Number(body.results[0].rank_score) > 0, true);
  } finally {
    global.fetch = originalFetch;
    server.close();
  }
});

test("pipeline includes reddit_research stage", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url || "");
    if (target.includes("/search.json")) {
      return new Response(
        JSON.stringify({
          data: {
            children: [
              {
                data: {
                  id: "redditpipe1",
                  title: "Agent chat dashboard benchmark notes",
                  subreddit: "AI_Agents",
                  permalink: "/r/AI_Agents/comments/redditpipe1/agent_chat_dashboard_benchmark/",
                  score: 85,
                  num_comments: 12,
                  upvote_ratio: 0.94,
                  created_utc: Math.floor(Date.now() / 1000) - 7200,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(url, options);
  };

  process.env.EXTERNAL_INDEXING_MODE = "builtin";
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const seedRepos = [
      {
        full_name: "acme/agent-dashboard-chat",
        name: "agent-dashboard-chat",
        description: "dashboard and chat app for ai agents",
        stargazers_count: 3500,
        forks_count: 400,
        topics: ["dashboard", "chat", "ai"],
        pushed_at: new Date().toISOString(),
      },
    ];

    const response = await originalFetch(`http://127.0.0.1:${port}/api/v1/masterpiece/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productName: "Inaya Reddit Pipeline Product",
        userGoal: "Build benchmark-first dashboard chat system with external signal validation.",
        stack: ["Node.js", "Express", "React"],
        queries: ["dashboard chat ui"],
        minStars: 500,
      topK: 5,
      runExternal: false,
      runGithubResearch: false,
      runRedditResearch: true,
      reddit: { query: "dashboard chat ui", subreddits: ["AI_Agents"], maxResults: 20 },
      seedRepos,
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.stageResults), true);
    const redditStage = body.stageResults.find((s) => s.stage === "reddit_research");
    assert.equal(Boolean(redditStage), true);
    assert.equal(redditStage.ok, true);
    assert.equal(Number(body.blueprint?.summary?.reddit_indexed_posts || 0) > 0, true);
  } finally {
    global.fetch = originalFetch;
    server.close();
  }
});

test("github research endpoint returns repo and answer intelligence", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url || "");
    if (target.includes("/search/repositories")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              full_name: "acme/agent-dashboard",
              html_url: "https://github.com/acme/agent-dashboard",
              description: "Dashboard chat ui agent app",
              stargazers_count: 2100,
              forks_count: 230,
              language: "TypeScript",
              topics: ["dashboard", "chat", "agent"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (target.includes("/search/issues")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              title: "How to stream chat in dashboard?",
              html_url: "https://github.com/acme/agent-dashboard/issues/42",
              repository_url: "https://api.github.com/repos/acme/agent-dashboard",
              comments: 12,
              updated_at: new Date().toISOString(),
              body: "Try this approach:\\n```ts\\napp.post('/chat', handler)\\n```",
              reactions: { total_count: 5 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(url, options);
  };

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await originalFetch(`http://127.0.0.1:${port}/api/v1/github/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "dashboard chat ui",
        perPage: 10,
        maxResults: 10,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(Number(body.summary.repo_hits), 1);
    assert.equal(Number(body.summary.answer_hits), 1);
    assert.equal(Array.isArray(body.answers[0].code_snippets), true);
  } finally {
    global.fetch = originalFetch;
    server.close();
  }
});

test("github research endpoint returns partial results when issue search fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url || "");
    if (target.includes("/search/repositories")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              full_name: "acme/partial-research",
              html_url: "https://github.com/acme/partial-research",
              description: "A".repeat(1200),
              stargazers_count: 1200,
              forks_count: 100,
              language: "TypeScript",
              topics: ["dashboard", "chat"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (target.includes("/search/issues")) {
      return new Response(JSON.stringify({ message: "rate limit" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(url, options);
  };

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await originalFetch(`http://127.0.0.1:${port}/api/v1/github/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "dashboard chat",
        perPage: 10,
        maxResults: 10,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(Number(body.summary.repo_hits), 1);
    assert.equal(Number(body.summary.answer_hits), 0);
    assert.equal(Array.isArray(body.summary.source_errors), true);
    assert.equal(body.summary.source_errors.length, 1);
    assert.equal(String(body.repos[0].description).length <= 360, true);
  } finally {
    global.fetch = originalFetch;
    server.close();
  }
});

test("pipeline includes github_research stage", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url || "");
    if (target.includes("/search/repositories")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              full_name: "acme/agent-dashboard-chat",
              html_url: "https://github.com/acme/agent-dashboard-chat",
              description: "agent dashboard chat",
              stargazers_count: 2200,
              forks_count: 200,
              language: "TypeScript",
              topics: ["dashboard", "chat"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (target.includes("/search/issues")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              title: "Need code example for chat route",
              html_url: "https://github.com/acme/agent-dashboard-chat/issues/7",
              repository_url: "https://api.github.com/repos/acme/agent-dashboard-chat",
              comments: 6,
              updated_at: new Date().toISOString(),
              body: "Use\\n```js\\nrouter.post('/api/v1/chat/reply', fn)\\n```",
              reactions: { total_count: 2 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(url, options);
  };

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await originalFetch(`http://127.0.0.1:${port}/api/v1/masterpiece/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productName: "Inaya Github Pipeline Product",
        userGoal: "Build dashboard chat from proven community code.",
        stack: ["Node.js", "Express", "React"],
        queries: ["dashboard chat ui"],
        minStars: 500,
        topK: 5,
        runExternal: false,
        runGithubResearch: true,
        runRedditResearch: false,
        github: { query: "dashboard chat ui", perPage: 10, maxResults: 10 },
        seedRepos: [
          {
            full_name: "acme/agent-dashboard-chat",
            name: "agent-dashboard-chat",
            description: "dashboard and chat app for ai agents",
            stargazers_count: 3500,
            forks_count: 400,
            topics: ["dashboard", "chat", "ai"],
            pushed_at: new Date().toISOString(),
          },
        ],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    const githubStage = body.stageResults.find((s) => s.stage === "github_research");
    assert.equal(Boolean(githubStage), true);
    assert.equal(githubStage.ok, true);
    assert.equal(Number(body.blueprint?.summary?.github_answer_hits || 0) > 0, true);
  } finally {
    global.fetch = originalFetch;
    server.close();
  }
});

test("chat endpoint returns 503 when no model keys configured", async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_KEY;

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Give me architecture guidance",
      provider: "auto",
      temperature: 0.3,
      context: { productName: "Inaya Test Product" },
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, "chat_model_not_configured");

  server.close();
});

test("chat endpoint accepts claude/google provider aliases", async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENAI_API_KEY;

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const claudeResponse = await fetch(`http://127.0.0.1:${port}/api/v1/chat/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Use claude alias",
      provider: "claude",
      temperature: 0.3,
    }),
  });
  const claudeBody = await claudeResponse.json();

  const googleResponse = await fetch(`http://127.0.0.1:${port}/api/v1/chat/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Use google alias",
      provider: "google",
      temperature: 0.3,
    }),
  });
  const googleBody = await googleResponse.json();

  assert.equal(claudeResponse.status, 503);
  assert.equal(claudeBody.error, "chat_model_not_configured");
  assert.equal(googleResponse.status, 503);
  assert.equal(googleBody.error, "chat_model_not_configured");

  server.close();
});

test("chat reply injects weighted validated reddit evidence into model context", async () => {
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_CHAT_MODEL = "gpt-4o-mini";
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENAI_API_KEY;

  let capturedOpenAiBody = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url || "");
    if (target.includes("reddit.com/r/AI_Agents/search.json")) {
      return new Response(
        JSON.stringify({
          data: {
            children: [
              {
                data: {
                  id: "rctx1",
                  title: "Validated dashboard chat ui benchmark strategy",
                  subreddit: "AI_Agents",
                  permalink: "/r/AI_Agents/comments/rctx1/validated_dashboard_chat_ui_benchmark_strategy/",
                  score: 160,
                  num_comments: 41,
                  upvote_ratio: 0.95,
                  selftext: "includes benchmark and workflow details",
                  created_utc: Math.floor(Date.now() / 1000) - 3600,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (target.includes("api.openai.com/v1/chat/completions")) {
      capturedOpenAiBody = JSON.parse(String(options.body || "{}"));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "reddit-weighted-reply" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(url, options);
  };

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const pipelineResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/masterpiece/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productName: "Inaya Reddit Weighting",
        userGoal: "Build robust dashboard chat tooling with benchmark evidence and community validation.",
        stack: ["Node.js", "Express", "React"],
        queries: ["dashboard chat ui"],
        minStars: 500,
        topK: 5,
        runExternal: false,
        runGithubResearch: false,
        runRedditResearch: true,
        reddit: { query: "dashboard chat ui benchmark workflow", subreddits: ["AI_Agents"], maxResults: 10 },
        seedRepos: [
          {
            full_name: "acme/agent-dashboard-chat",
            name: "agent-dashboard-chat",
            description: "dashboard chat app",
            stargazers_count: 3400,
            forks_count: 300,
            topics: ["dashboard", "chat", "react"],
            pushed_at: new Date().toISOString(),
          },
        ],
      }),
    });
    const pipelineBody = await pipelineResponse.json();
    assert.equal(pipelineResponse.status, 200);
    assert.equal(Boolean(pipelineBody?.reddit?.results?.length), true);

    const chatResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/chat/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "How should we prioritize build choices?",
        provider: "openai",
        temperature: 0.2,
      }),
    });
    const chatBody = await chatResponse.json();
    assert.equal(chatResponse.status, 200);
    assert.equal(chatBody.ok, true);
    assert.equal(chatBody.reply, "reddit-weighted-reply");
    assert.equal(Boolean(capturedOpenAiBody), true);

    const userMessage = Array.isArray(capturedOpenAiBody?.messages)
      ? capturedOpenAiBody.messages.find((m) => m.role === "user")?.content || ""
      : "";
    assert.equal(userMessage.includes("\"reddit_evidence_weighted\""), true);
    assert.equal(userMessage.includes("\"reddit_validation_summary\""), true);
    assert.equal(userMessage.includes("\"reddit_prioritization_policy\""), true);
  } finally {
    global.fetch = originalFetch;
    server.close();
  }
});
