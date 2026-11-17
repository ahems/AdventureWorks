import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ManufacturingStatus } from "@/services/api";
import { fetchCatalog, submitBulkReorder, type SupplyQuote } from "@/services/supplyChainApi";
import ShortagesPanel from "./ShortagesPanel";

vi.mock("@/services/api", () => ({
  fetchWorkOrders: vi.fn().mockResolvedValue([]),
  updateWorkOrder: vi.fn(),
  deleteWorkOrder: vi.fn(),
}));
vi.mock("@/services/supplyChainApi", () => ({
  fetchCatalog: vi.fn(),
  submitBulkReorder: vi.fn(),
  formatIncomingEta: vi.fn(),
  formatUtcTime: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const status: ManufacturingStatus = {
  isRunning: true, queueDepth: 0, pendingWorkOrders: 0, inProgressWorkOrders: 0,
  completedToday: 0, stalledForMaterials: 1, recentScrapEvents: [], locationLoad: [],
  shortages: [{ workOrderId: 1, productId: 10, productName: "Component",
    needed: 10, available: 0, shortfall: 10, lastRetryUtc: null }],
};
const quote: SupplyQuote = {
  vendorId: "vendor", vendorName: "Vendor", productId: 10, productName: "Component",
  qtyRequested: 10, stockAvailable: 10, unitCost: 1, shippingCost: 0, totalCost: 10,
  leadTimeDays: 1, minOrderQty: 1, maxOrderQty: 10, reliabilityPct: 100,
  estimatedDeliverySimHrs: 1, estimatedDeliveryRealMins: 1, inStock: true,
  incomingQty: 0, earliestIncomingEtaUtc: null,
};

function bindSession(generation: string) {
  localStorage.setItem("mfg_dab_oauth_generation", generation);
  sessionStorage.setItem("mfg_dab_oauth_tab_generation", JSON.stringify(generation));
}

function showPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <MemoryRouter><ShortagesPanel status={status} ordersByProduct={new Map()} /></MemoryRouter>
  </QueryClientProvider>);
}

async function beginReorder() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all products" }));
  const reorder = screen.getByRole("button", { name: /re-order selected/i });
  await waitFor(() => expect(reorder).toBeEnabled());
  fireEvent.click(reorder);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /confirm/i }));
  await waitFor(() => expect(submitBulkReorder).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(fetchCatalog).mockResolvedValue([quote]);
  bindSession("first");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("keeps reorder progress within its sign-in generation across navigation", async () => {
  vi.mocked(submitBulkReorder).mockResolvedValue({ accepted: true, totalOrdersPlanned: 1 });
  const panel = showPanel();
  await beginReorder();
  expect(await screen.findByRole("button", { name: /reordering/i })).toBeInTheDocument();
  expect(sessionStorage.getItem("reorderAllSubmitted:first")).not.toBeNull();
  panel.unmount();
  showPanel();
  expect(screen.getByRole("button", { name: /reordering/i })).toBeInTheDocument();
  cleanup();

  sessionStorage.setItem("reorderAllSubmitted", sessionStorage.getItem("reorderAllSubmitted:first")!);
  bindSession("second");
  showPanel();
  expect(screen.queryByRole("button", { name: /reordering/i })).not.toBeInTheDocument();
});

it("retains legacy-session progress but expires old scoped progress", () => {
  const submitted = { ids: [10], totalOrdersPlanned: 1, baselineOrderCount: 0, ts: Date.now() };
  localStorage.removeItem("mfg_dab_oauth_generation");
  sessionStorage.setItem("mfg_dab_oauth_tab_generation", "null");
  sessionStorage.setItem("reorderAllSubmitted", JSON.stringify(submitted));
  showPanel();
  expect(screen.getByRole("button", { name: /reordering/i })).toBeInTheDocument();
  cleanup();

  bindSession("first");
  sessionStorage.setItem("reorderAllSubmitted:first", JSON.stringify({ ...submitted, ts: Date.now() - 600001 }));
  showPanel();
  expect(screen.queryByRole("button", { name: /reordering/i })).not.toBeInTheDocument();
  expect(sessionStorage.getItem("reorderAllSubmitted:first")).toBeNull();
});

it.each(["success", "failure"] as const)(
  "does not publish a late reorder %s after the session changes",
  async (outcome) => {
    let resolve!: (value: { accepted: boolean; totalOrdersPlanned: number }) => void;
    let reject!: (reason: Error) => void;
    vi.mocked(submitBulkReorder).mockReturnValue(new Promise((ok, fail) => {
      resolve = ok;
      reject = fail;
    }));
    showPanel();
    await beginReorder();
    if (outcome === "success") localStorage.setItem("mfg_dab_oauth_generation", "second");
    else bindSession("second");
    await act(async () => {
      if (outcome === "success") resolve({ accepted: true, totalOrdersPlanned: 1 });
      else reject(new Error("superseded"));
    });
    expect(sessionStorage.getItem("reorderAllSubmitted:first")).toBeNull();
    expect(sessionStorage.getItem("reorderAllSubmitted:second")).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  },
);
