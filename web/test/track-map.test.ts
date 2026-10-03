import { afterEach, describe, expect, it, vi } from "vitest";
import TrackMap from "../src/components/TrackMap.vue";
import { byTestId, mountUi } from "./helpers.ts";

const remove = vi.fn();
const createTrackMap = vi.fn((..._args: unknown[]) => ({ remove }));
vi.mock("../src/map.ts", () => ({
  createTrackMap: (...args: unknown[]) => createTrackMap(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("TrackMap", () => {
  it("creates the map in its container and removes it on unmount", () => {
    const lines = [{ id: "app", line: null, color: "#000", dashed: false }];
    const wrapper = mountUi(TrackMap, { props: { lines, styleUrl: "s", testid: "map-x" } });
    const el = byTestId("map-x");
    expect(createTrackMap).toHaveBeenCalledWith(el, "s", lines);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("keeps the empty container when the map cannot be created", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    createTrackMap.mockImplementationOnce(() => {
      throw new Error("no webgl");
    });
    const wrapper = mountUi(TrackMap, { props: { lines: [], styleUrl: null, testid: "map-y" } });
    expect(byTestId("map-y")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    wrapper.unmount();
    expect(remove).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
