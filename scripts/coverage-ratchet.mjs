#!/usr/bin/env node
/**
 * Coverage ratchet. Compares coverage/coverage-summary.json against
 * coverage-baseline.json and fails when any metric drops by more than
 * TOLERANCE percentage points.
 *
 * Usage:
 *   node scripts/coverage-ratchet.mjs           check against the baseline
 *   node scripts/coverage-ratchet.mjs --write   rewrite the baseline
 *
 * Run `npm run test:coverage` first; the json-summary reporter must be enabled
 * in vitest.config.ts or the summary file will not exist.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOLERANCE = 0.5;
const METRICS = ["lines", "statements", "branches", "functions"];

const SUMMARY_PATH = fileURLToPath(new URL("../coverage/coverage-summary.json", import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL("../coverage-baseline.json", import.meta.url));

const write = process.argv.includes("--write");

if (!existsSync(SUMMARY_PATH)) {
  console.error(`coverage-ratchet: ${SUMMARY_PATH} not found. Run "npm run test:coverage" first.`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));
if (summary.total === undefined) {
  console.error("coverage-ratchet: coverage-summary.json has no total section.");
  process.exit(1);
}

const current = {};
for (const metric of METRICS) {
  const pct = summary.total[metric]?.pct;
  if (typeof pct !== "number" || Number.isNaN(pct)) {
    console.error(`coverage-ratchet: no percentage reported for "${metric}".`);
    process.exit(1);
  }
  current[metric] = Math.round(pct * 100) / 100;
}

function writeBaseline() {
  // V8 coverage can shift slightly between Node majors, so record which one
  // produced these numbers. A mismatch with the CI runner is the likeliest
  // reason for an otherwise inexplicable ratchet failure.
  const contents = { tolerance: TOLERANCE, measuredOnNode: process.version, ...current };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  console.log("coverage-ratchet: baseline written");
  for (const metric of METRICS) {
    console.log(`  ${metric.padEnd(11)} ${current[metric].toFixed(2)}%`);
  }
}

if (write) {
  writeBaseline();
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    "coverage-ratchet: no coverage-baseline.json. Create one with " +
      '"npm run coverage:ratchet:write".',
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const regressions = [];
const improvements = [];

console.log("coverage-ratchet: metric      baseline    current      delta");
for (const metric of METRICS) {
  const before = typeof baseline[metric] === "number" ? baseline[metric] : 0;
  const after = current[metric];
  const delta = Math.round((after - before) * 100) / 100;
  const marker = delta < -TOLERANCE ? "FAIL" : delta > 0 ? "up" : "";
  console.log(
    `                   ${metric.padEnd(11)} ${before.toFixed(2).padStart(8)}% ` +
      `${after.toFixed(2).padStart(8)}% ${(delta >= 0 ? "+" : "") + delta.toFixed(2)}  ${marker}`,
  );
  if (delta < -TOLERANCE) {
    regressions.push({ metric, before, after, delta });
  } else if (delta > 0) {
    improvements.push({ metric, before, after, delta });
  }
}

if (regressions.length > 0) {
  console.error(
    `\ncoverage-ratchet: ${regressions.length} metric(s) dropped by more than ` +
      `${TOLERANCE} percentage points:`,
  );
  for (const regression of regressions) {
    console.error(
      `  ${regression.metric}: ${regression.before.toFixed(2)}% -> ` +
        `${regression.after.toFixed(2)}% (${regression.delta.toFixed(2)})`,
    );
  }
  console.error("\nAdd tests, or rebaseline deliberately with npm run coverage:ratchet:write.");
  process.exit(1);
}

if (improvements.length > 0) {
  console.log(
    `\ncoverage-ratchet: ok, ${improvements.length} metric(s) improved. ` +
      "Raise the baseline with npm run coverage:ratchet:write.",
  );
} else {
  console.log("\ncoverage-ratchet: ok");
}
