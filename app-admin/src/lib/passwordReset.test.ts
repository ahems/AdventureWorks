import { describe, expect, it } from "vitest";
import { describeAdminResetResponse } from "./passwordReset";

describe("describeAdminResetResponse", () => {
  it("reports sent only when the server confirms delivery", () => {
    expect(
      describeAdminResetResponse(200, { result: "sent" }, "a@example.com"),
    ).toEqual({ kind: "sent", message: "Password reset email sent to a@example.com" });
  });

  it("reports customers without a storefront login as not eligible", () => {
    const outcome = describeAdminResetResponse(
      409,
      { result: "not-eligible", message: "No storefront sign-in." },
      "store@example.com",
    );
    expect(outcome).toEqual({ kind: "not-eligible", message: "No storefront sign-in." });
  });

  it("does not report undelivered or failed requests as sent", () => {
    expect(
      describeAdminResetResponse(502, { result: "email-not-sent", message: "Not delivered." }, "a@example.com"),
    ).toEqual({ kind: "failed", message: "Not delivered." });
    expect(describeAdminResetResponse(500, null, "a@example.com").kind).toBe("failed");
  });
});
