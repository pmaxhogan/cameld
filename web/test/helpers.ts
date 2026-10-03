import { mount, type VueWrapper } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { vi, type Mock } from "vitest";
import type { Component } from "vue";

/** One scripted response for the fetch stub. */
export interface Reply {
  status?: number;
  body?: unknown;
  /** When set, response.json() rejects (a non-JSON error page). */
  badJson?: boolean;
}

type Handler = Reply | ((init: RequestInit | undefined) => Reply | Promise<Reply>);

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Routes fetch by "METHOD path" (path without the query string unless the key
 * contains "?"). Unrouted requests answer 404 so a test sees them fail loudly.
 */
export function stubApi(routes: Record<string, Handler>): { calls: FetchCall[]; fetch: Mock } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method,
      url: input,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    const handler = routes[`${method} ${input}`] ?? routes[`${method} ${input.split("?")[0]}`];
    const reply: Reply =
      handler === undefined
        ? { status: 404, body: { error: "not_found" } }
        : typeof handler === "function"
          ? await handler(init)
          : handler;
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: () =>
        reply.badJson === true
          ? Promise.reject(new Error("not json"))
          : Promise.resolve(reply.body),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetch: fetchMock };
}

export interface MountOptions {
  props?: Record<string, unknown>;
  global?: Record<string, unknown>;
}

/** Mounts with PrimeVue, attached to the document so teleported dialogs are queryable. */
export function mountUi(component: Component, options: MountOptions = {}): VueWrapper {
  return mount(
    component as never,
    {
      props: options.props,
      attachTo: document.body,
      global: { plugins: [PrimeVue], ...options.global },
    } as never,
  );
}

/** Finds an element anywhere in the document (dialogs teleport to body). */
export function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

export function allByTestId(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

export function setValue(id: string, value: string): void {
  const el = byTestId(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function click(id: string): void {
  const el = byTestId(id);
  if (el === null) throw new Error(`no element with data-testid=${id}`);
  el.click();
}
