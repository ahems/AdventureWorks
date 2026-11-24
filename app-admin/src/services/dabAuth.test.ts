import { beforeEach, describe, expect, it } from "vitest";
import { getCurrentClaims, getSessionClaims } from "@/services/dabAuth";

const jwt = (claims: object) =>
  `h.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.s`;

const storeSession = (expiresAt: number, refreshToken?: string) =>
  localStorage.setItem(
    "dab_oauth_token",
    JSON.stringify({
      accessToken: jwt({ sub: "1", scope: "admin.read admin.write" }),
      expiresAt,
      scope: "admin.read admin.write",
      refreshToken,
    }),
  );

describe("getSessionClaims", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps scopes of an expired access token while the session is renewable", () => {
    storeSession(Math.floor(Date.now() / 1000) - 5, "refresh");
    expect(getCurrentClaims()).toBeNull();
    expect(getSessionClaims()?.scope).toBe("admin.read admin.write");
  });

  it("drops scopes once the session cannot be renewed", () => {
    storeSession(Math.floor(Date.now() / 1000) - 5);
    expect(getSessionClaims()).toBeNull();
  });
});
