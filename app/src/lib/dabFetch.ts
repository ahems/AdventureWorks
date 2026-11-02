import { getDabRole } from "@/services/dabAuth";
import { getEshopAccessToken } from "@/services/eshopOAuth";

/**
 * fetch() wrapper for DAB REST calls. When the shopper is signed in it attaches
 * the DAB access token and the matching X-MS-API-ROLE header so owner-scoped
 * entities (addresses, phones, carts, orders) pass DAB's database policies.
 * Anonymous requests (catalog browsing, lookups) are sent unchanged.
 */
export async function dabFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getEshopAccessToken("dab");
  if (!token) {
    return fetch(input, init);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const role = getDabRole();
  if (role) {
    headers.set("X-MS-API-ROLE", role);
  }
  return fetch(input, { ...init, headers });
}
