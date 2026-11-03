// Attaches the signed-in employee's api-functions access token to every browser
// request bound for the Functions app. Functions enforces OAuth (scope + category)
// on internal and consumer routes, so admin pages need no per-call token plumbing.
// Requests that already carry an Authorization header (e.g. the AI agent chat,
// which forwards a per-user MCP token) are left untouched.
import { getFunctionsApiUrl } from "@/lib/utils";
import { getFunctionsAccessToken, hasSession } from "@/services/dabAuth";

let installed = false;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isFunctionsRequest(url: string): boolean {
  const base = getFunctionsApiUrl().replace(/\/$/, "");
  return !!base && (url === base || url.startsWith(`${base}/`));
}

export function installFunctionsAuthInterceptor(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!isFunctionsRequest(url) || !hasSession()) {
      return nativeFetch(input, init);
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (headers.has("Authorization")) {
      return nativeFetch(input, init);
    }

    const send = async (force: boolean) => {
      const token = await getFunctionsAccessToken(force);
      const h = new Headers(headers);
      if (token) h.set("Authorization", `Bearer ${token}`);
      const req = input instanceof Request ? input.clone() : input;
      return nativeFetch(req, { ...init, headers: h });
    };

    const response = await send(false);
    // A cached token can be rejected after a key rotation or role change; re-mint once.
    if (response.status === 401) {
      return send(true);
    }
    return response;
  };
}
