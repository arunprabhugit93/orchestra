import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd().endsWith("frontend") ? join(process.cwd(), "..") : process.cwd();
const manifestPath = join(root, "audit", "audit_manifest.json");
const update = process.argv.includes("--update");
const ignored = new Set([".git", ".venv", ".venv-mac", "node_modules", "dist", "__pycache__", "audit"]);
const targets = [join(root, "backend"), join(root, "frontend", "src")];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (/\.(py|js|jsx|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function detectFunctions(file) {
  const text = readFileSync(file, "utf-8");
  const rel = relative(root, file).replaceAll("\\", "/");
  const found = [];
  const patterns = [
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*\(/gm,
    /^\s*(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!match[1].startsWith("_")) found.push(`${rel}::${match[1]}`);
    }
  }
  return found;
}

const current = targets.flatMap((target) => walk(target)).flatMap(detectFunctions).sort();

if (update) {
  writeFileSync(manifestPath, JSON.stringify({ generatedAt: new Date().toISOString(), functions: current }, null, 2) + "\n");
  console.log(`Audit manifest updated with ${current.length} functions.`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error("Missing audit/audit_manifest.json. Run: node scripts/verify_audit_coverage.mjs --update");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const expected = new Set(manifest.functions || []);
const actual = new Set(current);
const missing = current.filter((item) => !expected.has(item));
const stale = [...expected].filter((item) => !actual.has(item));

if (missing.length || stale.length) {
  console.error("Audit coverage manifest is out of date.");
  if (missing.length) console.error(`Missing functions:\n${missing.join("\n")}`);
  if (stale.length) console.error(`Stale functions:\n${stale.join("\n")}`);
  console.error("Run: node scripts/verify_audit_coverage.mjs --update");
  process.exit(1);
}

console.log(`Audit coverage verified for ${current.length} functions.`);
