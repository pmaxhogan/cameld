import { ref } from "vue";

/** The UI's areas. A tiny hash router: no history API, no server routes. */
export type Route =
  | { name: "review" }
  | { name: "history"; groupId: string | null }
  | { name: "backfill" }
  | { name: "settings" }
  | { name: "browser" }
  | { name: "not_found"; path: string };

/**
 * Maps a location.hash ("#/history/abc") to a route. An empty hash is the
 * review queue; anything unknown is the not-found view (never silently the
 * queue, so a mistyped link is noticed).
 */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/$/, "");
  const [head, id, ...rest] = path.split("/");
  switch (head) {
    case "":
    case "review":
      if (id === undefined) return { name: "review" };
      break;
    case "history":
      if (rest.length > 0) break;
      try {
        return { name: "history", groupId: id ? decodeURIComponent(id) : null };
      } catch {
        break; // malformed percent-encoding
      }
    case "backfill":
    case "settings":
    case "browser":
      if (id === undefined) return { name: head };
      break;
  }
  return { name: "not_found", path };
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
