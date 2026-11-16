import type { ReactiveController, ReactiveControllerHost } from "lit";

export interface Route {
  segments: string[];
  params: URLSearchParams;
}

type ParamValue = string | number | null | undefined;

export function parseHash(hash: string): Route {
  const text = hash.replace(/^#/, "");
  const [path, query = ""] = text.split("?");
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return { segments, params: new URLSearchParams(query) };
}

export function currentRoute(): Route {
  return parseHash(location.hash);
}

/** `#/indexes/name?tab=x` for a list of path segments and params. */
export function href(segments: string[] | string, params?: Record<string, ParamValue>): string {
  const parts = typeof segments === "string" ? segments.split("/").filter(Boolean) : segments;
  const path = parts.map((part) => encodeURIComponent(part)).join("/");
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return `#/${path}${query ? `?${query}` : ""}`;
}

export function navigate(
  segments: string[] | string,
  params?: Record<string, ParamValue>,
  options: { replace?: boolean } = {},
): void {
  const target = href(segments, params);
  if (target === location.hash) return;
  if (options.replace) {
    history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = target;
  }
}

/** Re-renders a Lit host when the hash changes. */
export class RouteController implements ReactiveController {
  route: Route = currentRoute();
  private readonly onChange = () => {
    this.route = currentRoute();
    this.host.requestUpdate();
  };

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    window.addEventListener("hashchange", this.onChange);
    this.route = currentRoute();
  }

  hostDisconnected(): void {
    window.removeEventListener("hashchange", this.onChange);
  }
}
