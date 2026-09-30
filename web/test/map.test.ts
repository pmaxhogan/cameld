import { describe, expect, it, vi } from "vitest";

const ctor = vi.fn();
vi.mock("maplibre-gl", () => ({
  Map: class {
    constructor(options: unknown) {
      ctor(options);
    }
  },
}));

describe("createMap", () => {
  it("builds a blank-style map in the given container", async () => {
    const { createMap } = await import("../src/map.ts");
    const container = document.createElement("div");
    createMap(container);
    expect(ctor).toHaveBeenCalledWith(
      expect.objectContaining({ container, style: { version: 8, sources: {}, layers: [] } }),
    );
  });
});
