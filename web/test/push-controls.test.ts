import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { byTestId, click, mountUi } from "./helpers.ts";

const push = vi.hoisted(() => ({
  pushSupported: vi.fn(),
  currentSubscription: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  sendTestPush: vi.fn(),
}));
vi.mock("../src/push.ts", () => push);

const { default: PushControls } = await import("../src/components/PushControls.vue");

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.resetAllMocks();
});

async function mountControls(): Promise<void> {
  const wrapper = mountUi(PushControls, { props: { publicKey: "AQID" } });
  unmount = () => wrapper.unmount();
  await flushPromises();
}

describe("PushControls", () => {
  it("explains when the browser cannot do push", async () => {
    push.pushSupported.mockReturnValue(false);
    await mountControls();
    expect(byTestId("push-unsupported")).not.toBeNull();
    expect(byTestId("push-enable")).toBeNull();
    expect(push.currentSubscription).not.toHaveBeenCalled();
  });

  it("enables, sends a test, and disables", async () => {
    push.pushSupported.mockReturnValue(true);
    push.currentSubscription.mockResolvedValue(null);
    push.enablePush.mockResolvedValue(undefined);
    push.disablePush.mockResolvedValue(undefined);
    push.sendTestPush.mockResolvedValue({ sent: 1, total: 2 });
    await mountControls();
    expect(byTestId("push-enable")?.textContent).toContain("Enable push");
    expect(byTestId("push-test")).toBeNull();

    click("push-enable");
    await flushPromises();
    expect(push.enablePush).toHaveBeenCalledWith("AQID");
    expect(byTestId("push-note")?.textContent).toBe("Push on for this browser");

    click("push-test");
    await flushPromises();
    expect(byTestId("push-note")?.textContent).toBe("Test sent to 1 of 2 browsers");

    click("push-enable");
    await flushPromises();
    expect(push.disablePush).toHaveBeenCalled();
    expect(byTestId("push-enable")?.textContent).toContain("Enable push");
  });

  it("starts enabled when subscribed and reports failures", async () => {
    push.pushSupported.mockReturnValue(true);
    push.currentSubscription.mockResolvedValue({});
    push.disablePush.mockRejectedValue(new Error("gone"));
    await mountControls();
    expect(byTestId("push-enable")?.textContent).toContain("Disable push");
    click("push-enable");
    await flushPromises();
    expect(byTestId("push-note")?.textContent).toBe("Push failed: gone");
  });
});
