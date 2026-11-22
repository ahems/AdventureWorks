import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const auth = vi.hoisted(() => ({
  hasSession: vi.fn(() => true),
  getValidAccessToken: vi.fn(async () => "dab-token"),
  getDabRole: vi.fn(() => "executive-admin"),
  refreshAccessToken: vi.fn(),
  getTabAuthorizationGeneration: vi.fn(() => 1),
  isTabAuthorizationGenerationCurrent: vi.fn(() => true),
}));
vi.mock("@/services/dabAuth", () => auth);

import { approveReview, deleteReview, submitReply, updateReply } from "@/hooks/useAdminReviews";
import { useCountriesAndStates } from "@/hooks/useCountriesAndStates";
import { useAdminPaymentMethods } from "@/hooks/useAdminPaymentMethods";
import { useAdminCustomerAddresses } from "@/hooks/useAdminCustomerAddresses";
import { useReviews } from "@/hooks/useReviews";
import { graphqlClient } from "@/lib/graphql-client";

const DAB_BASE = "http://dab.test";

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/ProductReviewReply?")) {
    return Response.json({ value: [{ ProductReviewReplyID: 9 }] });
  }
  if (url.endsWith("/graphql")) {
    return Response.json({ data: {} });
  }
  return Response.json({ value: [] });
});

const dabCalls = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith(DAB_BASE));

const expectAllDabCallsAuthenticated = () => {
  const calls = dabCalls();
  expect(calls.length).toBeGreaterThan(0);
  for (const [input, init] of calls) {
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("Authorization"), String(input)).toBe("Bearer dab-token");
    expect(headers.get("X-MS-API-ROLE"), String(input)).toBe("executive-admin");
  }
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe("admin DAB calls use the authenticated helper", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    (window as unknown as { APP_CONFIG: object }).APP_CONFIG = {
      API_URL: `${DAB_BASE}/graphql`,
      API_FUNCTIONS_URL: "http://functions.test",
    };
  });

  afterEach(() => {
    delete (window as unknown as { APP_CONFIG?: object }).APP_CONFIG;
  });

  it("review moderation REST calls", async () => {
    await approveReview("1");
    await submitReply("1", "Thanks!");
    await updateReply(9, "Updated");
    await deleteReview("1");

    const urls = dabCalls().map(([u]) => String(u));
    expect(urls).toEqual(
      expect.arrayContaining([
        `${DAB_BASE}/api/ProductReview/ProductReviewID/1`,
        `${DAB_BASE}/api/ProductReviewReply`,
        `${DAB_BASE}/api/ProductReviewReply/ProductReviewReplyID/9`,
      ]),
    );
    expectAllDabCallsAuthenticated();
  });

  it("country and state lookups", async () => {
    renderHook(() => useCountriesAndStates("US"));
    await waitFor(() => {
      const urls = dabCalls().map(([u]) => String(u));
      expect(urls).toContain(`${DAB_BASE}/api/CountryRegion`);
      expect(urls.some((u) => u.includes("/api/StateProvince?"))).toBe(true);
    });
    expectAllDabCallsAuthenticated();
  });

  it("payment method removal", async () => {
    const { result } = renderHook(() => useAdminPaymentMethods(5));
    await result.current.removePaymentMethod("7");
    expect(dabCalls().map(([u]) => String(u))).toContain(
      `${DAB_BASE}/api/PersonCreditCard/BusinessEntityID/5/CreditCardID/7`,
    );
    expectAllDabCallsAuthenticated();
  });

  it("customer address reads", async () => {
    renderHook(() => useAdminCustomerAddresses(5));
    await waitFor(() =>
      expect(dabCalls().some(([u]) => String(u).includes("/api/BusinessEntityAddress?"))).toBe(
        true,
      ),
    );
    expectAllDabCallsAuthenticated();
  });

  it("product review submission", async () => {
    const { result } = renderHook(() => useReviews(3), { wrapper });
    await result.current.addReview({
      productId: 3,
      userName: "Staff",
      rating: 5,
      title: "",
      comment: "Great",
    } as Parameters<typeof result.current.addReview>[0]);
    expect(
      dabCalls().some(
        ([u, init]) =>
          String(u) === `${DAB_BASE}/api/ProductReview` &&
          (init as RequestInit).method === "POST",
      ),
    ).toBe(true);
    expectAllDabCallsAuthenticated();
  });

  it("GraphQL client requests (e.g. recovery campaign order stats)", async () => {
    // The client resolves its endpoint at import time (before APP_CONFIG is set here).
    await graphqlClient
      .request("query { salesOrderHeaders { items { SalesOrderID } } }")
      .catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer dab-token");
    expect(headers.get("X-MS-API-ROLE")).toBe("executive-admin");
  });
});
