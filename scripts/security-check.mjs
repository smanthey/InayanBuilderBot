import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKIP = new Set([".git", "node_modules", "dist", "coverage"]);
const ALLOW_PATTERNS = [".env.example", "README.md", "docs/"];

const riskyPatterns = [
  /sk_live_[a-zA-Z0-9]+/,
  /AIza[0-9A-Za-z-_]{35}/,
  /-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /postgres:\/\/[^\s]+:[^\s]+@/i,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
];

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const findings = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (ALLOW_PATTERNS.some((p) => rel.includes(p))) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pat of riskyPatterns) {
    if (pat.test(text)) {
      findings.push({ file: rel, pattern: pat.toString() });
      break;
    }
  }
}

if (findings.length > 0) {
  console.error("Security check failed. Potential sensitive material detected:");
  for (const f of findings) {
    console.error(`- ${f.file} :: ${f.pattern}`);
  }
  process.exit(1);
}

console.log("security-check: pass");
