import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import HistoryView from "../src/views/HistoryView.vue";
import { groupDetail, group } from "./fixtures.ts";
import { allByTestId, byTestId, click, mountUi, setValue, stubApi } from "./helpers.ts";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

async function mountHistory(groupId: string | null): Promise<void> {
  const wrapper = mountUi(HistoryView, { props: { counts: { review: 1, done: 3 }, groupId } });
  unmount = () => wrapper.unmount();
  await flushPromises();
}

describe("HistoryView", () => {
  it("lists groups and filters by status", async () => {
    const { calls } = stubApi({
      "GET /api/groups?limit=200": { body: [group(), group({ id: "g-2" })] },
      "GET /api/groups?limit=200&status=done": { body: [] },
    });
    await mountHistory(null);
    const rows = allByTestId("history-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.getAttribute("href")).toBe("#/history/g-2");
    const options = [...(byTestId("history-filter") as HTMLSelectElement).options];
    expect(options.map((o) => o.value)).toEqual(["", "done", "review"]);
    setValue("history-filter", "done");
    await flushPromises();
    expect(calls.at(-1)!.url).toBe("/api/groups?limit=200&status=done");
    expect(byTestId("history-empty")).not.toBeNull();
  });

  it("shows a load error", async () => {
    stubApi({ "GET /api/groups": { status: 500, body: { error: "db_down" } } });
    await mountHistory(null);
    expect(byTestId("history-error")?.textContent).toContain("db_down");
  });

  it("shows a group's detail with a back link", async () => {
    stubApi({
      "GET /api/groups": { body: [] },
      "GET /api/groups/g-1": { body: groupDetail({ restorable: false }) },
    });
    await mountHistory("g-1");
    expect(byTestId("history-back")).not.toBeNull();
    expect(byTestId("group-detail")).not.toBeNull();
    expect(byTestId("restore-button")).toBeNull();
    click("history-back");
  });
});
