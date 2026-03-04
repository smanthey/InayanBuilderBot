import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const envPath = path.join(root, ".env");
const defaultShared = path.join(os.homedir(), ".openclaw", "shared", ".code-index");
const sharedIndexDir = path.resolve(String(process.env.CODE_INDEX_DIR || defaultShared));
const homeIndexDir = path.join(os.homedir(), ".code-index");

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

fs.mkdirSync(sharedIndexDir, { recursive: true });
try {
  fs.chmodSync(sharedIndexDir, 0o775);
} catch {
  // Non-fatal on filesystems that do not support chmod.
}

let symlinkStatus = "unchanged";
if (!fs.existsSync(homeIndexDir)) {
  fs.symlinkSync(sharedIndexDir, homeIndexDir, "dir");
  symlinkStatus = "created";
} else {
  const stat = fs.lstatSync(homeIndexDir);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(homeIndexDir);
    symlinkStatus = path.resolve(path.dirname(homeIndexDir), target) === sharedIndexDir ? "already-linked" : "linked-different-target";
  } else {
    symlinkStatus = "home-index-exists-no-link";
  }
}

let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
envText = upsertEnv(envText, "CODE_INDEX_DIR", sharedIndexDir);
fs.writeFileSync(envPath, envText, "utf8");

console.log(JSON.stringify({
  ok: true,
  sharedIndexDir,
  homeIndexDir,
  symlinkStatus,
  envPath,
  note: "Set CODE_INDEX_DIR in every agent environment to share index artifacts.",
}, null, 2));

