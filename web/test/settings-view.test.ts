import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../src/views/SettingsView.vue";
import { settings } from "./fixtures.ts";
import { byTestId, click, mountUi, setValue, stubApi, type Reply } from "./helpers.ts";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

type Handler = Reply | ((init: RequestInit | undefined) => Reply);

async function mountSettings(patch: Handler = { body: settings() }, initial = settings()) {
  const api = stubApi({ "GET /api/settings": { body: initial }, "PATCH /api/settings": patch });
  const wrapper = mountUi(SettingsView);
  unmount = () => wrapper.unmount();
  await flushPromises();
  return api;
}

function toggle(id: string): void {
  byTestId(id)!.dispatchEvent(new Event("change"));
}

function checked(id: string): boolean {
  return (byTestId(id) as HTMLInputElement).checked;
}

describe("SettingsView", () => {
  it("shows a load error", async () => {
    stubApi({ "GET /api/settings": { status: 500, body: { error: "db_down" } } });
    const wrapper = mountUi(SettingsView);
    unmount = () => wrapper.unmount();
    await flushPromises();
    expect(byTestId("settings-error")?.textContent).toContain("db_down");
  });

  it("saves only the changed fields", async () => {
    const { calls } = await mountSettings((init) => {
      const next = settings();
      next.timing.gracePeriodMs = 24 * 3_600_000;
      next.switches.hide = true;
      expect(JSON.parse(String(init?.body))).toBeTruthy();
      return { body: next };
    });
    expect((byTestId("setting-grace-hours") as HTMLInputElement).value).toBe("48");
    expect(document.body.textContent).toContain("Deletion trial: off, up to 3 pairs");
    expect(byTestId("switch-trial-help")?.textContent).toContain("at most 3 pairs");
    expect(byTestId("switch-delete-help")?.textContent).toContain("Path B");
    expect(byTestId("switch-hide-help")?.textContent).toContain("post-upload check");
    expect(byTestId("setting-upload-tolerance-percent")?.textContent).toBe("= 2%");
    expect(byTestId("setting-auto-overlap-percent")?.textContent).toBe("= 80%");
    expect(byTestId("setting-grace-hours-percent")).toBeNull();
    const input = byTestId("setting-upload-tolerance")!;
    const helpId = input.getAttribute("aria-describedby")!;
    expect(document.getElementById(helpId)?.textContent).toContain("Strava resamples");
    setValue("setting-grace-hours", "24");
    toggle("switch-hide");
    await flushPromises();
    click("settings-save");
    await flushPromises();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      patch: { timing: { gracePeriodMs: 86_400_000 }, switches: { hide: true } },
    });
    expect(byTestId("settings-saved")?.textContent).toContain("Settings saved");
    expect(checked("switch-hide")).toBe(true);
  });

  it("reports nothing changed, invalid numbers and server errors", async () => {
    let fail = false;
    await mountSettings(() =>
      fail
        ? { status: 400, body: { error: "invalid_settings", detail: "too big" } }
        : { body: settings() },
    );
    click("settings-save");
    await flushPromises();
    expect(byTestId("settings-saved")?.textContent).toContain("Nothing changed");
    setValue("setting-gps-auto", "");
    click("settings-save");
    await flushPromises();
    expect(byTestId("settings-error")?.textContent).toContain("Not a number");
    expect(byTestId("settings-saved")).toBeNull();
    setValue("setting-gps-auto", "9999");
    fail = true;
    click("settings-save");
    await flushPromises();
    expect(byTestId("settings-error")?.textContent).toContain("invalid_settings: too big");
  });

  it("turns deletion on only after the typed phrase", async () => {
    let accept = false;
    const { calls } = await mountSettings((init) => {
      if (!accept) return { status: 409, body: { error: "confirm_required" } };
      const next = settings();
      next.switches.delete = true;
      expect(JSON.parse(String(init?.body))).toBeTruthy();
      return { body: next };
    });
    setValue("setting-auto-overlap", "0.9");
    toggle("switch-delete");
    await flushPromises();
    expect(byTestId("delete-confirm-dialog")?.textContent).toContain("PERMANENTLY DELETED");
    const submit = byTestId("delete-confirm-submit") as HTMLButtonElement;
    setValue("delete-confirm-input", "delete original");
    await flushPromises();
    expect(submit.disabled).toBe(true);
    setValue("delete-confirm-input", "delete originals");
    await flushPromises();
    expect(submit.disabled).toBe(false);
    submit.click();
    await flushPromises();
    expect(byTestId("delete-confirm-error")?.textContent).toContain("confirm_required");
    accept = true;
    submit.click();
    await flushPromises();
    expect(calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({
      patch: { switches: { delete: true } },
      confirm: "delete originals",
    });
    expect(byTestId("delete-confirm-dialog")).toBeNull();
    expect(checked("switch-delete")).toBe(true);
    // The unsaved overlap edit survived the confirm round trip.
    expect((byTestId("setting-auto-overlap") as HTMLInputElement).value).toBe("0.9");

    // Turning it off again needs no confirmation and goes out with Save.
    toggle("switch-delete");
    await flushPromises();
    expect(byTestId("delete-confirm-dialog")).toBeNull();
    click("settings-save");
    await flushPromises();
    expect(calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({
      patch: { match: { autoMinOverlap: 0.9 }, switches: { delete: false } },
    });
  });

  it("reverts the trial toggle on cancel", async () => {
    await mountSettings();
    toggle("switch-trial");
    await flushPromises();
    expect(checked("switch-trial")).toBe(true);
    click("delete-confirm-cancel");
    await flushPromises();
    expect(byTestId("delete-confirm-dialog")).toBeNull();
    expect(checked("switch-trial")).toBe(false);
  });

  it("needs no phrase to re-enable a switch the server already has on", async () => {
    const initial = settings();
    initial.trial.enabled = true;
    await mountSettings({ body: initial }, initial);
    expect(document.body.textContent).toContain("Deletion trial: on");
    toggle("switch-trial");
    await flushPromises();
    toggle("switch-trial");
    await flushPromises();
    expect(byTestId("delete-confirm-dialog")).toBeNull();
    expect(checked("switch-trial")).toBe(true);
  });
});
