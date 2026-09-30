#!/usr/bin/env node
/**
 * Fails the build on non-ASCII dashes anywhere in the repo: source, Markdown,
 * YAML, the Dockerfile, compose files, everything.
 *
 * Rationale: em and en dashes render as "?" in cp1252 terminals and some mail
 * clients, and they have cost real debugging hours. Use "-".
 *
 * The banned characters are built from code points so this file stays pure ASCII
 * and never flags itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const BANNED = [
  { code: String.fromCharCode(0x2014), name: "em dash (U+2014)" },
  { code: String.fromCharCode(0x2013), name: "en dash (U+2013)" },
  { code: String.fromCharCode(0x2012), name: "figure dash (U+2012)" },
  { code: String.fromCharCode(0x2010), name: "hyphen (U+2010)" },
  { code: String.fromCharCode(0x2011), name: "non-breaking hyphen (U+2011)" },
  { code: String.fromCharCode(0x2212), name: "minus sign (U+2212)" },
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".gstack",
  ".claude",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  "blob-report",
  "tmp",
  "tmp-data",
  ".vite",
]);

const SKIP_FILES = new Set(["package-lock.json"]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".gz",
  ".7z",
  ".pdf",
  ".db",
  ".fit",
]);

function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (BINARY_EXTENSIONS.has(extensionOf(entry.name))) continue;
    const full = join(dir, entry.name);
    // Skip anything implausibly large for a text file.
    if (statSync(full).size > 2 * 1024 * 1024) continue;
    yield full;
  }
}

const violations = [];

for (const file of walk(ROOT)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!BANNED.some((banned) => text.includes(banned.code))) continue;

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const banned of BANNED) {
      let column = line.indexOf(banned.code);
      while (column !== -1) {
        violations.push({
          file: relative(ROOT, file).split(sep).join("/"),
          line: index + 1,
          column: column + 1,
          name: banned.name,
          text: line.trim().slice(0, 120),
        });
        column = line.indexOf(banned.code, column + 1);
      }
    }
  });
}

if (violations.length === 0) {
  console.log("check-ascii: no non-ASCII dashes found");
  process.exit(0);
}

console.error(`check-ascii: found ${violations.length} non-ASCII dash(es). Use "-" instead.\n`);
for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line}:${violation.column}  ${violation.name}`);
  console.error(`    ${violation.text}`);
}
process.exit(1);
