import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import TrackMap from "../src/components/TrackMap.vue";
import { byTestId, mountUi } from "./helpers.ts";

const remove = vi.fn();
const fakeMap = { remove };
const createTrackMap = vi.fn((..._args: unknown[]) => fakeMap);
const applyHidden = vi.fn();
vi.mock("../src/map.ts", () => ({
  createTrackMap: (...args: unknown[]) => createTrackMap(...args),
  applyHidden: (...args: unknown[]) => applyHidden(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("TrackMap", () => {
  it("creates the map in its container and removes it on unmount", () => {
    const lines = [{ id: "app", line: null, color: "#000", dashed: false }];
    const wrapper = mountUi(TrackMap, { props: { lines, styleUrl: "s", testid: "map-x" } });
    const el = byTestId("map-x");
    expect(createTrackMap).toHaveBeenCalledWith(el, "s", lines, expect.any(Function));
    const hidden = createTrackMap.mock.calls[0]![3] as () => string[];
    expect(hidden()).toEqual([]);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("applies the hidden lines when they change", async () => {
    const lines = [{ id: "app", line: null, color: "#000", dashed: false }];
    const wrapper = mountUi(TrackMap, {
      props: { lines, styleUrl: null, testid: "map-h", hidden: ["app"] },
    });
    const hidden = createTrackMap.mock.calls[0]![3] as () => string[];
    expect(hidden()).toEqual(["app"]);
    await wrapper.setProps({ hidden: [] });
    await flushPromises();
    expect(applyHidden).toHaveBeenCalledWith(fakeMap, lines, []);
    wrapper.unmount();
  });

  it("keeps the empty container when the map cannot be created", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    createTrackMap.mockImplementationOnce(() => {
      throw new Error("no webgl");
    });
    const wrapper = mountUi(TrackMap, { props: { lines: [], styleUrl: null, testid: "map-y" } });
    expect(byTestId("map-y")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    await wrapper.setProps({ hidden: ["app"] });
    await flushPromises();
    expect(applyHidden).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(remove).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
