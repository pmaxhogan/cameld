import { SAMPLE_FIELDS, type ActivitySample, type SampleField } from "../activity/sample.ts";
import { FIT_QUANTIZATION, epochMsToFitSeconds } from "../fit/quantization.ts";
import type { LedgerEntry, MergeSide } from "./ledger.ts";
import { alignedSecond } from "./merger.ts";

/**
 * The exact no-loss check: the gate before any merged file is uploaded.
 *
 * Given both original inputs, the clock offset, the merged output (either the
 * in-memory merge or the samples read back from the built FIT file) and the
 * exclusion ledger, it proves that:
 *
 * - every input sample has an output record at its aligned second;
 * - every field value of every input sample is either in that output record
 *   (identical, or equal within FIT quantization: half a step, plus the same
 *   floating point slack the FIT round-trip test allows) or in the ledger with
 *   exactly that value; a position counts only when lat and lng match in the
 *   same record;
 * - every ledger entry points at a real input sample and field and carries
 *   exactly its value;
 * - every output value traces to an input value at the same aligned second
 *   (nothing invented), and every output second is some input's second.
 */

export type NoLossIssueKind =
  | "missing_record"
  | "missing_value"
  | "bad_ledger_entry"
  | "untraceable_value"
  | "untraceable_record";

export interface NoLossIssue {
  kind: NoLossIssueKind;
  side?: MergeSide;
  index?: number;
  field?: SampleField;
  value?: number;
  /** Aligned FIT second concerned. */
  second?: number;
  detail: string;
}

export interface NoLossReport {
  ok: boolean;
  /** Input field values examined (lat and lng count separately). */
  checkedValues: number;
  representedInOutput: number;
  representedInLedger: number;
  outputRecords: number;
  ledgerEntries: number;
  issues: NoLossIssue[];
}

export interface NoLossInput {
  app: readonly ActivitySample[];
  fitbit: readonly ActivitySample[];
  offsetSeconds: number;
  output: readonly ActivitySample[];
  ledger: readonly LedgerEntry[];
}

/** Whether `actual` holds `expected` within FIT quantization. */
export function sameWithinQuantization(
  field: SampleField,
  expected: number,
  actual: number | undefined,
): boolean {
  if (actual === undefined) return false;
  if (actual === expected) return true;
  const bound = FIT_QUANTIZATION[field].step / 2 + 1e-9 + Math.abs(expected) * 1e-12;
  return Math.abs(actual - expected) <= bound;
}

interface Located {
  side: MergeSide;
  index: number;
  sample: ActivitySample;
}

function groupBySecond<T>(items: readonly T[], second: (item: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const key = second(item);
    const list = map.get(key);
    if (list === undefined) map.set(key, [item]);
    else list.push(item);
  }
  return map;
}

const holdsFix = (record: ActivitySample, lat: number, lng: number): boolean =>
  sameWithinQuantization("lat", lat, record.lat) && sameWithinQuantization("lng", lng, record.lng);

/** Run the exact no-loss check. */
export function checkNoLoss(input: NoLossInput): NoLossReport {
  const issues: NoLossIssue[] = [];
  const outBySecond = groupBySecond(input.output, (record) => epochMsToFitSeconds(record.time));
  const ledgerKey = (side: MergeSide, index: number, field: SampleField): string =>
    `${side}:${index}:${field}`;
  const ledgered = new Map<string, number[]>();
  for (const entry of input.ledger) {
    const key = ledgerKey(entry.side, entry.index, entry.field);
    ledgered.set(key, [...(ledgered.get(key) ?? []), entry.value]);
  }

  const located: Located[] = [];
  const inputs: Record<MergeSide, readonly ActivitySample[]> = {
    app: input.app,
    fitbit: input.fitbit,
  };
  for (const side of ["app", "fitbit"] as const) {
    inputs[side].forEach((sample, index) => located.push({ side, index, sample }));
  }
  const secondOf = (item: Located): number =>
    alignedSecond(item.side, item.sample.time, input.offsetSeconds);

  let checkedValues = 0;
  let representedInOutput = 0;
  let representedInLedger = 0;
  for (const item of located) {
    const { side, index, sample } = item;
    const second = secondOf(item);
    const records = outBySecond.get(second) ?? [];
    if (records.length === 0) {
      issues.push({ kind: "missing_record", side, index, second, detail: "no output record" });
    }
    const fixInOutput =
      sample.lat !== undefined &&
      records.some((record) => holdsFix(record, sample.lat!, sample.lng!));
    for (const field of SAMPLE_FIELDS) {
      const value = sample[field];
      if (value === undefined) continue;
      checkedValues += 1;
      const inOutput =
        field === "lat" || field === "lng"
          ? fixInOutput
          : records.some((record) => sameWithinQuantization(field, value, record[field]));
      if (inOutput) {
        representedInOutput += 1;
      } else if ((ledgered.get(ledgerKey(side, index, field)) ?? []).includes(value)) {
        representedInLedger += 1;
      } else {
        issues.push({
          kind: "missing_value",
          side,
          index,
          field,
          value,
          second,
          detail: "neither in the output nor in the ledger",
        });
      }
    }
  }

  for (const entry of input.ledger) {
    const sample = inputs[entry.side][entry.index];
    if (sample === undefined || sample[entry.field] !== entry.value) {
      issues.push({
        kind: "bad_ledger_entry",
        side: entry.side,
        index: entry.index,
        field: entry.field,
        value: entry.value,
        detail: "ledger entry does not match an input value",
      });
    }
  }

  const inBySecond = groupBySecond(located, secondOf);
  for (const record of input.output) {
    const second = epochMsToFitSeconds(record.time);
    const candidates = (inBySecond.get(second) ?? []).map((item) => item.sample);
    if (candidates.length === 0) {
      issues.push({ kind: "untraceable_record", second, detail: "no input sample in this second" });
      continue;
    }
    for (const field of SAMPLE_FIELDS) {
      const value = record[field];
      if (value === undefined) continue;
      const traced =
        field === "lat" || field === "lng"
          ? candidates.some(
              (sample) => sample.lat !== undefined && holdsFix(record, sample.lat, sample.lng!),
            )
          : candidates.some((sample) => {
              const original = sample[field];
              return original !== undefined && sameWithinQuantization(field, original, value);
            });
      if (!traced) {
        issues.push({
          kind: "untraceable_value",
          field,
          value,
          second,
          detail: "output value matches no input value in this second",
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    checkedValues,
    representedInOutput,
    representedInLedger,
    outputRecords: input.output.length,
    ledgerEntries: input.ledger.length,
    issues,
  };
}
