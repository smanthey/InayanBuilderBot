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
