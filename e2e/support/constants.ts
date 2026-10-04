/** Shared by the seed script, the Access double and the tests. All synthetic. */

export const SEED = {
  reviewGroup: "g-1580608922-synth00001",
  doneGroup: "g-1580695322-synth00002",
  hiddenGroup: "g-1580781722-synth00003",
  /** Path B parked with deletion off; its merged FIT is built and in the backup. */
  parkedGroup: "g-1580868122-synth00004",
  frozenReason: "synthetic check failure for the end to end suite",
} as const;

export const OWNER = "owner@example.com";
export const AUD = "synthetic-e2e-aud";
export const PASSWORD = "synthetic-e2e-password";
export const VNC_USER = "kasm_user";
export const VNC_PASSWORD = "synthetic-vnc-password";
