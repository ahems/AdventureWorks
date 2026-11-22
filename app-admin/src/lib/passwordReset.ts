export type AdminResetOutcome =
  | { kind: "sent"; message: string }
  | { kind: "not-eligible"; message: string }
  | { kind: "failed"; message: string };

const NOT_ELIGIBLE_FALLBACK =
  "This customer has no storefront sign-in for that email address, so no reset email was sent.";

/**
 * Maps the staff-only POST /api/password/reset/admin-request response to the
 * message shown in the admin portal. Unlike the anonymous storefront route,
 * this route reports whether the customer can actually receive a reset email.
 */
export function describeAdminResetResponse(
  status: number,
  body: { result?: string; message?: string } | null,
  email: string,
): AdminResetOutcome {
  if (status === 200 && body?.result === "sent") {
    return { kind: "sent", message: `Password reset email sent to ${email}` };
  }
  if (status === 409 || body?.result === "not-eligible") {
    return { kind: "not-eligible", message: body?.message || NOT_ELIGIBLE_FALLBACK };
  }
  return {
    kind: "failed",
    message: body?.message || `Failed to send password reset email (HTTP ${status})`,
  };
}
