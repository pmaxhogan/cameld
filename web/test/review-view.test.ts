import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReviewView from "../src/views/ReviewView.vue";
import { allByTestId, byTestId, click, mountUi, setValue, stubApi } from "./helpers.ts";
import { group, reviewItem, tracks } from "./fixtures.ts";

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

async function mountReview(): Promise<void> {
  const wrapper = mountUi(ReviewView, { props: { styleUrl: null } });
  unmount = () => wrapper.unmount();
  await flushPromises();
}

describe("ReviewView", () => {
  it("shows the empty state", async () => {
    stubApi({ "GET /api/review": { body: [] } });
    await mountReview();
    expect(byTestId("review-empty")).not.toBeNull();
    expect(allByTestId("review-item")).toHaveLength(0);
  });

  it("shows a load error", async () => {
    stubApi({ "GET /api/review": { status: 500, body: { error: "db_down" } } });
    await mountReview();
    expect(byTestId("review-error")?.textContent).toContain("db_down");
    expect(byTestId("review-loading")).toBeNull();
  });

  it("selects an item, shows maps and metrics, and approves with an offset", async () => {
    let queue = [
      reviewItem(),
      reviewItem({ id: "g-2", name: null, sportType: null, parkedReason: null }),
    ];
    const { calls } = stubApi({
      "GET /api/review": () => ({ body: queue }),
      "GET /api/groups/g-1/tracks": { body: tracks() },
      "POST /api/review/g-1": () => {
        queue = queue.slice(1);
        return { body: group({ status: "approved" }) };
      },
    });
    await mountReview();
    const items = allByTestId("review-item");
    expect(items).toHaveLength(2);
    expect(items[1]!.textContent).toContain("g-2");
    expect(items[1]!.textContent).toContain("Needs review");
    expect(items[0]!.textContent).toContain("alignment_uncertain");
    items[0]!.click();
    await flushPromises();
    for (const id of ["map-side-app", "map-side-fitbit", "map-overlay"]) {
      expect(byTestId(id)).not.toBeNull();
    }
    expect(byTestId("track-notes")?.textContent).toContain("merge preview unavailable");
    expect(byTestId("review-metrics")?.textContent).toContain("93%");

    setValue("review-offset", "abc");
    click("approve-button");
    await flushPromises();
    expect(byTestId("review-decision-error")?.textContent).toContain("Offset must be");

    setValue("review-note", " looks right ");
    setValue("review-offset", "-4");
    click("approve-button");
    await flushPromises();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ decision: "approve", note: "looks right", offsetSeconds: -4 });
    expect(byTestId("review-result")?.textContent).toContain("g-1 is now approved");
    expect(allByTestId("review-item")).toHaveLength(1);
    expect(byTestId("review-detail")).toBeNull();
  });

  it("rejects without an offset and shows decision and track errors", async () => {
    const { calls } = stubApi({
      "GET /api/review": { body: [reviewItem()] },
      "GET /api/groups/g-1/tracks": { status: 404, body: { error: "not_found" } },
      "POST /api/review/g-1": { status: 409, body: { error: "not_reviewable" } },
    });
    await mountReview();
    click("review-item");
    await flushPromises();
    expect(byTestId("tracks-error")?.textContent).toContain("not_found");
    click("reject-button");
    await flushPromises();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject", note: "" });
    expect(byTestId("review-decision-error")?.textContent).toContain("not_reviewable");
  });
});
