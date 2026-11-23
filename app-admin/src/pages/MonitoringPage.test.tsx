import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MonitoringPage from "./MonitoringPage";
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null,
}));

const mocks = vi.hoisted(() => ({
  role: "executive-admin",
  read: true,
  write: true,
  summary: vi.fn(), captures: vi.fn(), trace: vi.fn(), startCapture: vi.fn(), stopCapture: vi.fn(),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { appRole: mocks.role } }) }));
vi.mock("@/hooks/useCan", () => ({ useCan: (scope: string) => scope === "monitoring.read" ? mocks.read : mocks.write }));
vi.mock("@/components/AdminHeader", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/services/monitoringService", () => ({ monitoringService: mocks, monitoringRanges: ["1h", "6h", "24h"] }));

const snapshot = {
  asOf: "2026-11-23T03:00:00Z", range: "1h", status: "partial", ingestionNote: "Ingestion delayed; traces sampled.",
  links: {},
  sources: [
    { id: "services", status: "available", asOf: "2026-11-23T03:00:00Z", reason: null, rows: [{ service: "api-mcp", observedFailures: 0, p95: null }] },
    { id: "resources", status: "forbidden", asOf: "2026-11-23T03:00:00Z", reason: "Resource query forbidden.", rows: [] },
  ],
};
const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(<QueryClientProvider client={client}><MonitoringPage /></QueryClientProvider>);
  return { ...result, client };
};

describe("protected live monitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "executive-admin"; mocks.read = true; mocks.write = true;
    mocks.summary.mockResolvedValue(snapshot);
    mocks.captures.mockResolvedValue({ asOf: snapshot.asOf, captures: [], notice: "Capture is off." });
    mocks.startCapture.mockResolvedValue({ id: "grant" });
    mocks.stopCapture.mockResolvedValue({ id: "grant", status: "stopped" });
  });

  it.each([{ role: "sales-manager", read: true }, { role: "executive-admin", read: false }])("denies $role without required role and scope; never fetches", ({ role, read }) => {
    mocks.role = role; mocks.read = read;
    mount();
    expect(screen.getByRole("alert")).toHaveTextContent("requires executive-admin");
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.captures).not.toHaveBeenCalled();
  });

  it("distinguishes observed zero, null, unavailable source and loading/error", async () => {
    let resolve: (value: typeof snapshot) => void;
    mocks.summary.mockReturnValue(new Promise(done => { resolve = done; }));
    const { client } = mount();
    expect(screen.getByRole("status")).toHaveTextContent("Loading monitoring snapshot");
    await act(async () => resolve(snapshot));
    expect(await screen.findByText("api-mcp")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Resource query forbidden.")).toBeInTheDocument();
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    mocks.summary.mockRejectedValue(new Error("Monitoring queries are throttled."));
    await act(async () => { await client.invalidateQueries({ queryKey: ["monitoring", "summary"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("last snapshot is stale");
    expect(screen.getByText("api-mcp")).toBeInTheDocument();
  });

  it("uses the chosen lookback and reads only after application changes/focus/reconnect, not idle time", async () => {
    const { unmount } = mount();
    await screen.findByText("api-mcp");
    fireEvent.change(screen.getByLabelText("Lookback"), { target: { value: "6h" } });
    await waitFor(() => expect(mocks.summary).toHaveBeenCalledWith("6h", expect.any(AbortSignal)));
    vi.useFakeTimers();
    const count = mocks.summary.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(300_000); });
    expect(mocks.summary).toHaveBeenCalledTimes(count);
    act(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new CustomEvent("webpubsub", { detail: { group: "orders" } }));
    });
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(mocks.summary).toHaveBeenCalledTimes(count + 1);
    act(() => window.dispatchEvent(new Event("webpubsub-reconnected")));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(mocks.summary).toHaveBeenCalledTimes(count + 2);
    unmount();
    act(() => window.dispatchEvent(new Event("webpubsub-reconnected")));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(mocks.summary).toHaveBeenCalledTimes(count + 2);
    vi.useRealTimers();
  });

  it("requires explicit scope selection and warning acknowledgement, and hides writes without monitoring.write", async () => {
    const { rerender, client } = mount();
    await screen.findByText("api-mcp");
    const start = screen.getByRole("button", { name: "Start 15-minute capture" });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Capture scope"), { target: { value: "job" } });
    fireEvent.change(screen.getByLabelText("Session or job ID"), { target: { value: "job-123" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(start);
    await waitFor(() => expect(mocks.startCapture).toHaveBeenCalledWith("job", "job-123"));
    mocks.write = false;
    rerender(<QueryClientProvider client={client}><MonitoringPage /></QueryClientProvider>);
    expect(screen.queryByRole("button", { name: "Start 15-minute capture" })).not.toBeInTheDocument();
  });

  it("shows failed initial reads and no-data without claiming health", async () => {
    mocks.summary.mockRejectedValue(new Error("Monitoring access denied."));
    const first = mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("No telemetry snapshot is available");
    first.unmount();
    mocks.summary.mockResolvedValue({ ...snapshot, status: "no-data", sources: [{ id: "services", asOf: snapshot.asOf, status: "no-data", reason: null, rows: [] }] });
    mount();
    expect(await screen.findByText("No observed data in this range. This is not a healthy result.")).toBeInTheDocument();
  });

  it("validates trace identifiers without sending malformed input to the backend", async () => {
    mount();
    await screen.findByText("api-mcp");
    fireEvent.change(screen.getByLabelText("Trace ID"), { target: { value: "not-a-trace" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect trace" }));
    expect(screen.getByRole("alert")).toHaveTextContent("32-character hexadecimal");
    expect(mocks.trace).not.toHaveBeenCalled();
  });

  it("invalidates capture status on generic persisted-control push without refetching unrelated panels", async () => {
    const { unmount } = mount();
    await screen.findByText("api-mcp");
    vi.useFakeTimers();
    const captureReads = mocks.captures.mock.calls.length;
    const summaryReads = mocks.summary.mock.calls.length;
    act(() => window.dispatchEvent(new CustomEvent("webpubsub", { detail: { group: "utilities", event: "monitoring-capture-changed" } })));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(mocks.captures).toHaveBeenCalledTimes(captureReads + 1);
    expect(mocks.summary).toHaveBeenCalledTimes(summaryReads);
    unmount();
    vi.useRealTimers();
  });

  it("shows only the supplied captured fields, bounds and supported reasoning summaries for a selected trace", async () => {
    const id = "a".repeat(32);
    mocks.trace.mockResolvedValue({
      asOf: snapshot.asOf, traceId: id, status: "available",
      source: { id: "trace", asOf: snapshot.asOf, status: "available", reason: null, rows: [{ spanId: "observed-span", parentSpanId: null, kind: "agent" }] },
      richContent: [{ spanId: "observed-span", fields: {
        reasoningSummary: { text: "Supported provider summary", originalBytes: 200, truncated: true, omitted: false },
        input: { text: null, originalBytes: 40, truncated: false, omitted: true },
      } }],
    });
    mount();
    await screen.findByText("api-mcp");
    fireEvent.change(screen.getByLabelText("Trace ID"), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect trace" }));
    expect(await screen.findByText("Supported provider summary")).toBeInTheDocument();
    expect(screen.getByText("Unavailable or omitted by server policy.")).toBeInTheDocument();
    expect(screen.getByText(/200 original bytes/)).toHaveTextContent("truncated");
  });
});
