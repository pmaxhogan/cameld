import { ref } from "vue";

/** The UI's areas. A tiny hash router: no history API, no server routes. */
export type Route =
  | { name: "review" }
  | { name: "history"; groupId: string | null }
  | { name: "backfill" }
  | { name: "settings" }
  | { name: "browser" };

/** Maps a location.hash ("#/history/abc") to a route. Anything unknown is the review queue. */
export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  const [head, id] = parts;
  switch (head) {
    case "history":
      return { name: "history", groupId: id ? decodeURIComponent(id) : null };
    case "backfill":
    case "settings":
    case "browser":
      return { name: head };
    default:
      return { name: "review" };
  }
}

export function groupHref(id: string): string {
  return `#/history/${encodeURIComponent(id)}`;
}

export const route = ref<Route>(parseHash(location.hash));

function sync(): void {
  route.value = parseHash(location.hash);
}

/** Follows hashchange events. Returns the function that stops following them. */
export function startRouter(): () => void {
  sync();
  window.addEventListener("hashchange", sync);
  return () => window.removeEventListener("hashchange", sync);
}
