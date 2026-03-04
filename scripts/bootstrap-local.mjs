import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const envExample = path.join(root, ".env.example");
const envPath = path.join(root, ".env");
const dataDir = path.join(root, ".data");
const runsFile = path.join(dataDir, "runs.json");

function parseEnv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/g)) {
    if (!line || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

function upsertEnv(text, key, value) {
  const lines = String(text || "").split(/\r?\n/g);
  let found = false;
  const next = lines.map((line) => {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) return line;
    const idx = line.indexOf("=");
    const k = line.slice(0, idx).trim();
    if (k !== key) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) next.push(`${key}=${value}`);
  return `${next.join("\n").replace(/\n+$/g, "")}\n`;
}

if (!fs.existsSync(envPath)) {
  if (!fs.existsSync(envExample)) {
    throw new Error(".env.example missing");
  }
  fs.copyFileSync(envExample, envPath);
}

let envText = fs.readFileSync(envPath, "utf8");
const env = parseEnv(envText);

envText = upsertEnv(envText, "EXTERNAL_INDEXING_MODE", "builtin");

const currentApiKey = String(env.BUILDERBOT_API_KEY || "").trim();
if (!currentApiKey || currentApiKey === "change-me") {
  const generated = `ibb_${crypto.randomBytes(24).toString("hex")}`;
  envText = upsertEnv(envText, "BUILDERBOT_API_KEY", generated);
}

fs.writeFileSync(envPath, envText);

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(runsFile)) {
  fs.writeFileSync(runsFile, JSON.stringify({ runs: [], chats: [], chatSessions: {}, providerMetrics: {} }, null, 2));
}

console.log("Bootstrap complete");
console.log("- .env ready (EXTERNAL_INDEXING_MODE=builtin)");
console.log("- BUILDERBOT_API_KEY set");
console.log("- .data store initialized");
