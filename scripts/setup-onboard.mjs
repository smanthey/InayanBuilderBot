#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");
const envExamplePath = path.join(root, ".env.example");

function parseEnv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/g)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1);
  }
  return out;
}

function upsertEnv(text, key, value) {
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

function mask(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length < 8) return `${"*".repeat(Math.max(0, s.length - 1))}${s.slice(-1)}`;
  return `${s.slice(0, 4)}${"*".repeat(s.length - 6)}${s.slice(-2)}`;
}

async function checkGithubToken(token) {
  if (!token) return { ok: false, detail: "missing_token" };
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "inayanbuilderbot-onboard-cli",
      },
    });
    if (!res.ok) return { ok: false, detail: `http_${res.status}` };
    const data = await res.json();
    return { ok: true, detail: `remaining_${Number(data?.rate?.remaining ?? -1)}` };
  } catch (err) {
    return { ok: false, detail: String(err?.message || err).slice(0, 120) };
  }
}

async function checkPostgresTcp(host, port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let done = false;
    const end = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => end({ ok: true, detail: "tcp_connect_ok" }));
    socket.once("timeout", () => end({ ok: false, detail: "tcp_timeout" }));
    socket.once("error", (err) => end({ ok: false, detail: String(err?.message || err).slice(0, 120) }));
  });
}

async function main() {
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const env = parseEnv(envText);

  const rl = readline.createInterface({ input, output });
  console.log("InayanBuilderBot onboarding");

  const generateApiKey = (await rl.question("Generate BUILDERBOT_API_KEY? (Y/n): ")).trim().toLowerCase() !== "n";
  const apiKey = generateApiKey
    ? `ibb_${crypto.randomBytes(24).toString("hex")}`
    : (await rl.question("BUILDERBOT_API_KEY: ")).trim();

  const githubToken = (await rl.question("GITHUB_TOKEN (leave blank to skip): ")).trim();
  const host = (await rl.question(`POSTGRES_HOST [${env.POSTGRES_HOST || "127.0.0.1"}]: `)).trim() || env.POSTGRES_HOST || "127.0.0.1";
  const port = Number((await rl.question(`POSTGRES_PORT [${env.POSTGRES_PORT || "5432"}]: `)).trim() || env.POSTGRES_PORT || "5432");
  const user = (await rl.question(`POSTGRES_USER [${env.POSTGRES_USER || "postgres"}]: `)).trim() || env.POSTGRES_USER || "postgres";
  const db = (await rl.question(`POSTGRES_DB [${env.POSTGRES_DB || "postgres"}]: `)).trim() || env.POSTGRES_DB || "postgres";
  const password = (await rl.question("POSTGRES_PASSWORD: ")).trim();
  rl.close();

  let next = envText;
  if (apiKey) next = upsertEnv(next, "BUILDERBOT_API_KEY", apiKey);
  if (githubToken) {
    next = upsertEnv(next, "GITHUB_TOKEN", githubToken);
    next = upsertEnv(next, "GITHUB_PERSONAL_ACCESS_TOKEN", githubToken);
  }
  next = upsertEnv(next, "POSTGRES_HOST", host);
  next = upsertEnv(next, "POSTGRES_PORT", String(port));
  next = upsertEnv(next, "POSTGRES_USER", user);
  next = upsertEnv(next, "POSTGRES_DB", db);
  if (password) next = upsertEnv(next, "POSTGRES_PASSWORD", password);
  fs.writeFileSync(envPath, next, "utf8");

  console.log("Saved local .env");
  console.log(`BUILDERBOT_API_KEY: ${mask(apiKey)}`);
  if (githubToken) console.log(`GITHUB_TOKEN: ${mask(githubToken)}`);

  const gh = await checkGithubToken(githubToken || env.GITHUB_TOKEN || "");
  const pg = await checkPostgresTcp(host, port);
  const mcp = spawnSync("npm", ["run", "-s", "mcp:health"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, CI: "1" },
  });

  console.log(`GitHub check: ${gh.ok ? "ok" : "fail"} (${gh.detail})`);
  console.log(`Postgres TCP check: ${pg.ok ? "ok" : "fail"} (${pg.detail})`);
  console.log(`MCP health: ${mcp.status === 0 ? "ok" : "fail"}`);
  if (mcp.status !== 0) {
    console.log(String(mcp.stdout || "").slice(-600));
    console.log(String(mcp.stderr || "").slice(-600));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`setup:onboard failed: ${String(err?.message || err)}`);
  process.exit(1);
});
