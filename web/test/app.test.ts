import { flushPromises, mount } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";

const remove = vi.fn();
const createMap = vi.fn(() => ({ remove }));
vi.mock("../src/map.ts", () => ({ createMap: () => createMap() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("App", () => {
  it("shows the server version from /healthz and tears the map down", async () => {
    stubFetch(() =>
      Promise.resolve({ json: () => Promise.resolve({ ok: true, version: "1.2.3" }) }),
    );
    const wrapper = mount(App, { global: { plugins: [PrimeVue] } });
    await flushPromises();
    expect(wrapper.get("[data-testid=version]").text()).toBe("server 1.2.3");
    expect(createMap).toHaveBeenCalledOnce();
    wrapper.unmount();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("reports an unreachable server", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    const wrapper = mount(App, { global: { plugins: [PrimeVue] } });
    await flushPromises();
    expect(wrapper.get("[data-testid=version]").text()).toBe("server unreachable");
  });

  it("survives a map that cannot be created", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    createMap.mockImplementationOnce(() => {
      throw new Error("no webgl");
    });
    stubFetch(() => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }));
    const wrapper = mount(App, { global: { plugins: [PrimeVue] } });
    await flushPromises();
    expect(wrapper.get("[data-testid=version]").text()).toBe("server unreachable");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
