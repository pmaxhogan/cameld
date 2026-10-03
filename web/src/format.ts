import type { DryRunEntryInfo, WindowUsage } from "@cameld/shared";

/**
 * Pure display helpers. The server hands several fields over as `unknown`
 * (match summaries, dry-run reports, evidence), so everything here reads them
 * defensively and falls back to "-".
 */

export const NONE = "-";

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local "YYYY-MM-DD HH:MM", or "-" for null. */
export function fmtTime(ms: number | null): string {
  if (ms === null) return NONE;
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local "YYYY-MM-DD". */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A 0..1 ratio as a whole percentage. */
export function fmtPct(ratio: unknown): string {
  const n = num(ratio);
  return n === null ? NONE : `${Math.round(n * 100)}%`;
}

/** A number rounded to `digits` decimals with an optional unit suffix. */
export function fmtNum(value: unknown, unit = "", digits = 1): string {
  const n = num(value);
  return n === null ? NONE : `${Number(n.toFixed(digits))}${unit}`;
}

/** Share of a rate-limit window used, 0..100. */
export function usagePct(window: WindowUsage): number {
  if (window.limit <= 0) return 0;
  return Math.min(100, Math.round((window.usage / window.limit) * 100));
}

export interface MetricsView {
  decision: string;
  overlap: string;
  startDelta: string;
  median: string;
  p90: string;
  alignStatus: string;
  alignOffset: string;
  sharpness: string;
  reasons: string[];
}

/** Reads a match summary (server/src/state/evaluate.ts summarizeMatch) for display. */
export function readMetrics(match: unknown): MetricsView {
  const m = bag(match);
  const metrics = bag(m.metrics);
  const proximity = bag(metrics.proximity);
  const alignment = bag(metrics.alignment);
  const reasons = Array.isArray(m.reasons) ? m.reasons.map(String) : [];
  return {
    decision: typeof m.decision === "string" ? m.decision : NONE,
    overlap: fmtPct(metrics.overlapRatio),
    startDelta: fmtNum(metrics.startDeltaSeconds, " s", 0),
    median: fmtNum(proximity.medianMeters, " m"),
    p90: fmtNum(proximity.p90Meters, " m"),
    alignStatus: typeof alignment.status === "string" ? alignment.status : NONE,
    alignOffset: fmtNum(alignment.offsetSeconds, " s", 0),
    sharpness: fmtNum(alignment.sharpness, "", 2),
    reasons,
  };
}

export interface DryRunRow {
  key: string;
  start: string;
  decision: string;
  members: number;
  overlap: string;
  median: string;
  noLoss: string;
}

function noLossText(value: unknown): string {
  if (value === undefined) return NONE;
  const n = bag(value);
  if (n.ok === true) return `ok (${fmtNum(n.points, "", 0)} points)`;
  return `failed: ${typeof n.error === "string" ? n.error : "unknown"}`;
}

/** One row of the dry-run table from a stored report (server/src/service/backfill.ts). */
export function dryRunRow(entry: DryRunEntryInfo): DryRunRow {
  const report = bag(entry.report);
  const view = readMetrics(report.match);
  return {
    key: entry.groupKey,
    start: fmtTime(entry.startMs),
    decision: entry.decision,
    members: Array.isArray(report.members) ? report.members.length : 0,
    overlap: view.overlap,
    median: view.median,
    noLoss: noLossText(report.noLoss),
  };
}

export type Severity = "success" | "info" | "warn" | "danger" | "secondary";

const SEVERITY: Record<string, Severity> = {
  auto: "success",
  done: "success",
  review: "warn",
  needs_review: "warn",
  parked: "warn",
  needs_original: "info",
  merge_check_failed: "danger",
  failed: "danger",
  frozen: "danger",
};

/** Tag colour for a match decision or group status. */
export function severityOf(value: string): Severity {
  return SEVERITY[value] ?? "secondary";
}

/** Pretty JSON for evidence blocks. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}
