import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({
  getSessionClaims: vi.fn(),
}));
vi.mock("@/services/dabAuth", () => auth);

const authContext = vi.hoisted(() => ({
  useAuth: vi.fn(),
}));
vi.mock("@/context/AuthContext", () => authContext);

import { Can } from "@/components/Can";
import { hasScope, Scopes, scopesFromClaims } from "@/lib/permissions";
import { useCan } from "@/hooks/useCan";

const signIn = (scope: string) => {
  authContext.useAuth.mockReturnValue({ user: { email: "e@x", appRole: "r" } });
  auth.getSessionClaims.mockReturnValue({ scope });
};

const GatedButton = ({ scope }: { scope: string }) => {
  const allowed = useCan(scope);
  return <button disabled={!allowed}>Act</button>;
};

describe("scope gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses space-delimited scope and scp claims", () => {
    expect([...scopesFromClaims({ scope: "a.read  b.write" })]).toEqual(["a.read", "b.write"]);
    expect(scopesFromClaims({ scp: ["c.read", "d.write"] }).has("d.write")).toBe(true);
    expect(scopesFromClaims({ scp: "e.read" }).has("e.read")).toBe(true);
    expect(scopesFromClaims(null).size).toBe(0);
  });

  it("hasScope reads the session token claims", () => {
    auth.getSessionClaims.mockReturnValue({ scope: "orders.read admin.read" });
    expect(hasScope(Scopes.OrdersRead)).toBe(true);
    expect(hasScope(Scopes.OrdersWrite)).toBe(false);
  });

  it("Can renders children only when the scope is granted", () => {
    signIn("admin.read admin.write");
    const { rerender } = render(
      <Can scope={Scopes.AdminWrite} fallback={<span>no</span>}>
        <span>AI tools</span>
      </Can>,
    );
    expect(screen.getByText("AI tools")).toBeInTheDocument();

    signIn("admin.read");
    rerender(
      <Can scope={Scopes.AdminWrite} fallback={<span>no</span>}>
        <span>AI tools</span>
      </Can>,
    );
    expect(screen.queryByText("AI tools")).not.toBeInTheDocument();
    expect(screen.getByText("no")).toBeInTheDocument();
  });

  it("useCan disables controls for missing scopes and signed-out users", () => {
    signIn("orders.read");
    const { rerender } = render(<GatedButton scope={Scopes.OrdersWrite} />);
    expect(screen.getByRole("button", { name: "Act" })).toBeDisabled();

    signIn("orders.read orders.write");
    rerender(<GatedButton scope={Scopes.OrdersWrite} />);
    expect(screen.getByRole("button", { name: "Act" })).toBeEnabled();

    authContext.useAuth.mockReturnValue({ user: null });
    rerender(<GatedButton scope={Scopes.OrdersWrite} />);
    expect(screen.getByRole("button", { name: "Act" })).toBeDisabled();
  });
});
