import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import GroupDetailView from "../src/views/GroupDetailView.vue";
import { group, groupDetail } from "./fixtures.ts";
import { allByTestId, byTestId, click, mountUi, setValue, stubApi } from "./helpers.ts";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

async function mountDetail(): Promise<void> {
  const wrapper = mountUi(GroupDetailView, { props: { groupId: "g-1" } });
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
  it("shows members, events with evidence and writes", async () => {
    stubApi({ "GET /api/groups/g-1": { body: groupDetail() } });
    await mountDetail();
    const detail = byTestId("group-detail")!;
    expect(detail.textContent).toContain("303");
    expect(detail.textContent).toContain("Phone");
    expect(byTestId("event-timeline")).not.toBeNull();
    expect(byTestId("members-table")).not.toBeNull();
    const events = allByTestId("event-item");
    expect(events).toHaveLength(3);
    expect(events[2]!.textContent).toContain("done -> -");
    expect(events[0]!.textContent).toContain("- -> matched");
    expect(events[0]!.querySelector("pre")!.textContent).toContain('"score": 1');
    expect(events[1]!.querySelector("pre")!.textContent).toBe("null");
    expect(byTestId("writes-table")?.textContent).toContain("upload");
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
