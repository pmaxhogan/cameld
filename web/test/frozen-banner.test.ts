import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import FrozenBanner from "../src/components/FrozenBanner.vue";
import { byTestId, click, mountUi, setValue, stubApi } from "./helpers.ts";

const freeze = { frozen: true, reason: "delete unconfirmed", evidence: null, frozenAt: 0 };

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

async function open(): Promise<void> {
  const wrapper = mountUi(FrozenBanner, { props: { freeze } });
  unmount = () => wrapper.unmount();
  expect(byTestId("frozen-reason")?.textContent).toBe("delete unconfirmed");
  click("unfreeze-button");
  await flushPromises();
}

describe("FrozenBanner", () => {
  it("requires a reason, then unfreezes and closes", async () => {
    const { calls } = stubApi({ "POST /api/freeze/unfreeze": { body: { frozen: false } } });
    await open();
    expect((byTestId("unfreeze-confirm") as HTMLButtonElement).disabled).toBe(true);
    setValue("unfreeze-reason", "  checked by hand  ");
    await flushPromises();
    click("unfreeze-confirm");
    await flushPromises();
    expect(calls[0]!.body).toEqual({ reason: "checked by hand" });
    expect(byTestId("unfreeze-reason")).toBeNull();
  });

  it("shows the server error and can be cancelled", async () => {
    stubApi({ "POST /api/freeze/unfreeze": { status: 409, body: { error: "not_frozen" } } });
    await open();
    setValue("unfreeze-reason", "go");
    await flushPromises();
    click("unfreeze-confirm");
    await flushPromises();
    expect(byTestId("unfreeze-error")?.textContent).toContain("not_frozen");
    click("unfreeze-cancel");
    await flushPromises();
    expect(byTestId("unfreeze-reason")).toBeNull();
  });

  it("closes from the dialog's own close button", async () => {
    stubApi({});
    await open();
    document.querySelector<HTMLElement>(".p-dialog-close-button")!.click();
    await flushPromises();
    expect(byTestId("unfreeze-reason")).toBeNull();
  });
});
