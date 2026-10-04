import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import TrackComparison from "../src/components/TrackComparison.vue";
import TrackMap from "../src/components/TrackMap.vue";
import { tracks } from "./fixtures.ts";
import { byTestId, mountUi, stubApi } from "./helpers.ts";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on(): void {}
    remove(): void {}
    getLayer(): undefined {
      return undefined;
    }
    setLayoutProperty(): void {}
  },
}));

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("TrackComparison", () => {
  it("toggles each line on the overlay map", async () => {
    stubApi({
      "GET /api/groups/g%201/tracks": {
        body: tracks({
          merged: { label: "merged", coordinates: [[0.5, 0.5]], points: 1 },
          notes: [],
        }),
      },
    });
    const wrapper = mountUi(TrackComparison, { props: { groupId: "g 1", styleUrl: null } });
    await flushPromises();
    expect(byTestId("track-comparison")?.textContent).toContain("merged");
    expect(byTestId("track-notes")).toBeNull();
    const overlay = () =>
      wrapper.findAllComponents(TrackMap).find((m) => m.props("testid") === "map-overlay")!;
    expect(overlay().props("hidden")).toEqual([]);
    await wrapper.find('[data-testid="toggle-fitbit"]').setValue(false);
    await wrapper.find('[data-testid="toggle-merged"]').setValue(false);
    expect(overlay().props("hidden")).toEqual(["fitbit", "merged"]);
    await wrapper.find('[data-testid="toggle-fitbit"]').setValue(true);
    await wrapper.find('[data-testid="toggle-app"]').setValue(false);
    expect(overlay().props("hidden")).toEqual(["app", "merged"]);
    wrapper.unmount();
  });

  it("names a missing merge generically", async () => {
    stubApi({ "GET /api/groups/g-1/tracks": { body: tracks() } });
    const wrapper = mountUi(TrackComparison, { props: { groupId: "g-1", styleUrl: "s" } });
    await flushPromises();
    expect(byTestId("toggle-merged")?.parentElement?.textContent).toContain("merge");
    expect(byTestId("track-notes")?.textContent).toContain("merge preview unavailable");
    wrapper.unmount();
  });
});
