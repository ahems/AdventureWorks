// Authenticated fetch for Data API Builder (DAB) REST calls. Mirrors the admin
// app's authenticatedFetch: attaches the delegated bearer token plus the
// X-MS-API-ROLE header, retries once after a forced refresh on an auth failure,
// and surfaces an expired session (which triggers the redirect to /login).
import {
  getDabRole,
  getTabAuthorizationGeneration,
  getValidAccessToken,
  hasSession,
  isTabAuthorizationGenerationCurrent,
  refreshAccessToken,
} from "@/services/dabAuth";

export const SESSION_EXPIRED_MESSAGE =
  "Your session has expired. Please sign in again.";

async function withAuthHeaders(init?: RequestInit): Promise<RequestInit> {
  const headers = new Headers(init?.headers);
  const token = await getValidAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    const role = getDabRole();
    if (role) headers.set("X-MS-API-ROLE", role);
  }
  return { ...init, headers };
}

/**
 * fetch() for DAB. With no OAuth session it behaves like a plain anonymous fetch
 * (login-time lookups use anonymous entities). With a session, a 401 forces a
 * token refresh and a single retry; if the session can't be renewed, the refresh
 * fires DAB_SESSION_LOST_EVENT (AuthContext signs the user out) and this throws.
 */
export async function dabFetch(input: string, init?: RequestInit): Promise<Response> {
  const generation = getTabAuthorizationGeneration();
  if (!hasSession()) {
    return fetch(input, init);
  }

  const ensureSession = () => {
    if (!isTabAuthorizationGenerationCurrent(generation)) throw new Error(SESSION_EXPIRED_MESSAGE);
  };
  const initial = await withAuthHeaders(init);
  ensureSession();
  const res = await fetch(input, initial);
  ensureSession();
  if (res.status !== 401) return res;

  const refreshed = await refreshAccessToken(true);
  ensureSession();
  if (!refreshed) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  const retry = await withAuthHeaders(init);
  ensureSession();
  const response = await fetch(input, retry);
  ensureSession();
  return response;
}
