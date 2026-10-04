import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import GroupDetailView from "../src/views/GroupDetailView.vue";
import { group, groupDetail, tracks } from "./fixtures.ts";
import { allByTestId, byTestId, click, mountUi, setValue, stubApi } from "./helpers.ts";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on(): void {}
    remove(): void {}
  },
}));

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

async function mountDetail(): Promise<void> {
  const wrapper = mountUi(GroupDetailView, { props: { groupId: "g-1", styleUrl: null } });
  unmount = () => wrapper.unmount();
  await flushPromises();
}

const RESTORED = {
  groupId: "g-1",
  status: "restored",
  restored: [
    { id: 101, outcome: "reuploaded", newId: 909, flags: [] },
    { id: 202, outcome: "unhidden", newId: null, flags: [] },
  ],
  unhidden: [202],
  flags: [],
};

describe("GroupDetailView", () => {
  it("shows a friendly title, members, events with evidence and writes", async () => {
    stubApi({ "GET /api/groups/g-1": { body: groupDetail() } });
    await mountDetail();
    const detail = byTestId("group-detail")!;
    expect(byTestId("group-title")?.textContent).toMatch(
      /^\d{4}-\d{2}-\d{2} Run, 1 phone \+ 1 wrist recordings$/,
    );
    expect(byTestId("group-id")?.textContent).toBe("g-1");
    expect(detail.textContent).toContain("Done");
    const merged = byTestId("merged-activity")!.querySelector("a")!;
    expect(merged.getAttribute("href")).toBe("https://www.strava.com/activities/303");
    expect(merged.getAttribute("target")).toBe("_blank");
    expect(detail.textContent).toContain("Phone (app)");
    const member = byTestId("member-link")!;
    expect(member.getAttribute("href")).toBe("https://www.strava.com/activities/101");
    const memberRow = byTestId("members-table")!.querySelector("tbody tr")!;
    expect(memberRow.lastElementChild?.textContent?.trim()).toBe("-");
    expect(byTestId("event-timeline")).not.toBeNull();
    const events = allByTestId("event-item");
    expect(events).toHaveLength(3);
    expect(events[2]!.textContent).toContain("Done -> -");
    expect(events[2]!.textContent).toContain("note");
    expect(events[0]!.textContent).toContain("- -> matched");
    expect(events[1]!.textContent).toContain(
      "Confirmed: originals gone and the merged activity intact",
    );
    const evidence = events[0]!.querySelector('[data-testid="event-evidence"]')!;
    expect(evidence.textContent).toContain("score");
    expect(events[0]!.querySelector("details summary")!.textContent).toBe("Raw JSON");
    expect(events[0]!.querySelector("pre")!.textContent).toContain('"score": 1');
    expect(events[1]!.querySelector('[data-testid="event-evidence"]')).toBeNull();
    expect(events[1]!.querySelector("pre")!.textContent).toBe("null");
    expect(byTestId("writes-table")!.textContent).toContain("Upload merged activity");
    expect(byTestId("write-target")?.textContent).toBe("cameld-merge-g-1");
    expect(byTestId("write-time")?.textContent).toContain("(requested)");
    expect(byTestId("track-comparison")).toBeNull();
    expect(byTestId("parked-reason")?.textContent).toContain("alignment_uncertain");
  });

  it("says when there are no Strava writes yet", async () => {
    stubApi({ "GET /api/groups/g-1": { body: groupDetail({ writes: [] }) } });
    await mountDetail();
    expect(byTestId("writes-table")?.textContent).toContain("No Strava writes yet.");
  });

  it("explains a parked group in plain language and compares its tracks", async () => {
    const base = groupDetail();
    stubApi({
      "GET /api/groups/g-1": {
        body: groupDetail({
          group: group({
            status: "parked",
            parkedReason: "deletion_switch_off",
            lastError: "wait:deletion_switch_off",
            mergedActivityId: null,
            sportType: null,
            appIds: [101],
            fitbitIds: [],
          }),
          mergeBuilt: true,
          members: [{ ...base.members[0]!, deviceName: null, source: "fitbit", restoredAs: 404 }],
          events: [
            {
              at: 1_500_000,
              from: "snapshotted",
              to: "b_rejected",
              event: "upload_duplicate",
              evidence: { kind: "duplicate", duplicateOf: 101, error: "duplicate of 101" },
            },
            {
              at: 1_600_000,
              from: "b_rejected",
              to: "parked",
              event: "deletion_switch_off",
              evidence: null,
            },
          ],
          writes: [
            {
              id: 2,
              kind: "upload",
              targetId: null,
              externalId: "cameld-merge-g-1",
              status: "rejected",
              result: null,
              createdAt: 1_400_000,
              completedAt: 1_450_000,
            },
            {
              id: 3,
              kind: "hide",
              targetId: 101,
              externalId: null,
              status: "done",
              result: null,
              createdAt: 1_400_000,
              completedAt: 1_450_000,
            },
            {
              id: 4,
              kind: "mystery",
              targetId: null,
              externalId: null,
              status: "intent",
              result: null,
              createdAt: 1_400_000,
              completedAt: null,
            },
          ],
          restorable: false,
        }),
      },
      "GET /api/groups/g-1/tracks": {
        body: tracks({ merged: { label: "merged", coordinates: [[0.5, 0.5]], points: 1 } }),
      },
    });
    await mountDetail();
    expect(byTestId("group-title")?.textContent).toContain("Activity, 1 phone + 0 wrist recording");
    expect(byTestId("parked-reason")?.textContent).toContain(
      "Parked: deletion is off, so both originals were left in place on Strava",
    );
    expect(byTestId("parked-reason")?.textContent).toContain("deletion_switch_off");
    expect(byTestId("last-error")?.textContent).toContain("Waiting for deletion to be turned on");
    expect(byTestId("merged-activity")?.textContent?.trim()).toBe("-");
    const events = allByTestId("event-item");
    expect(events[0]!.textContent).toContain(
      "Strava rejected the merged upload as a duplicate of the original (expected while originals exist)",
    );
    expect(events[0]!.textContent).toContain("Snapshot taken -> Upload rejected as duplicate");
    expect(events[0]!.querySelector('[data-testid="event-evidence"]')!.textContent).toContain(
      "duplicateOf101",
    );
    expect(events[1]!.textContent).toContain("Parked: deletion is off");
    const row = byTestId("members-table")!.querySelector("tbody tr")!;
    expect(row.textContent).toContain("Wrist (Fitbit)");
    expect(row.lastElementChild?.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.strava.com/activities/404",
    );
    const targets = allByTestId("write-target");
    expect(targets.map((t) => t.textContent)).toEqual(["cameld-merge-g-1", "101"]);
    expect(targets[1]!.getAttribute("href")).toBe("https://www.strava.com/activities/101");
    const writeRows = byTestId("writes-table")!.querySelectorAll("tbody tr");
    expect(writeRows[1]!.textContent).toContain("Hide original");
    expect(writeRows[2]!.textContent).toContain("mystery");
    expect(allByTestId("write-time")[0]!.textContent).not.toContain("requested");
    expect(byTestId("track-comparison")).not.toBeNull();
    expect(byTestId("map-overlay")).not.toBeNull();
  });

  it("renders optional fields as dashes", async () => {
    stubApi({
      "GET /api/groups/g-1": {
        body: groupDetail({
          group: group({ name: null, path: null, parkedReason: null, trial: true, lastError: "x" }),
          restorable: false,
        }),
      },
    });
    await mountDetail();
    expect(byTestId("group-detail")!.textContent).toContain("yes");
  });

  it("restores with a reason and shows the result", async () => {
    let detail = groupDetail();
    const { calls } = stubApi({
      "GET /api/groups/g-1": () => ({ body: detail }),
      "POST /api/groups/g-1/restore": () => {
        detail = groupDetail({ restorable: false });
        return { body: RESTORED };
      },
    });
    await mountDetail();
    click("restore-button");
    await flushPromises();
    expect(document.body.textContent).toContain("The merged activity stays on Strava.");
    expect((byTestId("restore-confirm") as HTMLButtonElement).disabled).toBe(true);
    setValue("restore-reason", " wrong pair ");
    await flushPromises();
    click("restore-confirm");
    await flushPromises();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ reason: "wrong pair" });
    const result = byTestId("restore-result")!.textContent;
    expect(result).toContain("101 reuploaded as 909");
    expect(result).toContain("202 unhidden.");
    expect(result).toContain("Flags: none");
    expect(byTestId("restore-button")).toBeNull();
  });

  it("shows restore failures and can cancel", async () => {
    stubApi({
      "GET /api/groups/g-1": { body: groupDetail() },
      "POST /api/groups/g-1/restore": { status: 503, body: { error: "strava_unavailable" } },
    });
    await mountDetail();
    click("restore-button");
    await flushPromises();
    setValue("restore-reason", "x");
    await flushPromises();
    click("restore-confirm");
    await flushPromises();
    expect(byTestId("restore-error")?.textContent).toContain("strava_unavailable");
    click("restore-cancel");
    await flushPromises();
    expect(byTestId("restore-reason")).toBeNull();
    click("restore-button");
    await flushPromises();
    document.querySelector<HTMLElement>(".p-dialog-close-button")!.click();
    await flushPromises();
    expect(byTestId("restore-reason")).toBeNull();
  });

  it("shows flags and a load error", async () => {
    stubApi({
      "GET /api/groups/g-1": { body: groupDetail() },
      "POST /api/groups/g-1/restore": { body: { ...RESTORED, flags: ["photos"] } },
    });
    await mountDetail();
    click("restore-button");
    await flushPromises();
    setValue("restore-reason", "x");
    await flushPromises();
    click("restore-confirm");
    await flushPromises();
    expect(byTestId("restore-result")!.textContent).toContain("Flags: photos");
    unmount?.();
    stubApi({ "GET /api/groups/g-1": { status: 404, body: { error: "not_found" } } });
    await mountDetail();
    expect(byTestId("group-error")?.textContent).toContain("not_found");
  });
});
