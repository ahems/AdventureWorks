import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UtilitiesPage from "./UtilitiesPage";

const access = vi.hoisted(() => ({ role: "executive-admin", read: true }));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    user: { appRole: access.role, firstName: "Demo", lastName: "Employee" },
    isAuthenticated: true, logout: vi.fn(),
  }),
}));
vi.mock("@/hooks/useCan", () => ({ useCan: (scope: string) => scope === "monitoring.read" ? access.read : true }));
vi.mock("@/components/AppBreadcrumb", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/components/GenerateVerifiedReviewsWizardDialog", () => ({ default: () => null }));

describe("Utilities monitoring navigation", () => {
  beforeEach(() => { access.role = "executive-admin"; access.read = true; });

  it("places monitoring in the tools section instead of the top navigation", () => {
    const { container } = render(<MemoryRouter><UtilitiesPage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Tools, Inspectors & Monitoring" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Application Monitoring/ });
    expect(link).toHaveAttribute("href", "/monitoring");
    expect(link.closest("main")).not.toBeNull();
    expect(container.querySelector('header a[href="/monitoring"]')).toBeNull();
  });

  it.each([{ role: "sales-manager", read: true }, { role: "executive-admin", read: false }])(
    "preserves role and scope protection for $role", ({ role, read }) => {
      access.role = role; access.read = read;
      render(<MemoryRouter><UtilitiesPage /></MemoryRouter>);
      expect(screen.queryByRole("link", { name: /Application Monitoring/ })).not.toBeInTheDocument();
    },
  );
});
