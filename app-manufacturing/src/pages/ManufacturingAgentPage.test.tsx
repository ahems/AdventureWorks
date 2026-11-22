import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { fetchAgentConfig, fetchAgentQueueStatus, fetchAgentRuns } from "@/services/agentApi";
import ManufacturingAgentPage from "./ManufacturingAgentPage";

vi.mock("@/services/agentApi", () => ({
  fetchAgentConfig: vi.fn(),
  saveAgentMode: vi.fn(),
  fetchAgentRuns: vi.fn(),
  fetchAgentQueueStatus: vi.fn(),
  fetchAgentProposals: vi.fn().mockResolvedValue([]),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  rejectAllProposals: vi.fn(),
  approveAllProposals: vi.fn(),
  AGENT_MODE_LABELS: { 0: "Off", 1: "Read-Only", 2: "Propose", 3: "Autonomous" },
  AGENT_MODE_DESCRIPTIONS: { 0: "", 1: "", 2: "", 3: "" },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ManufacturingAgentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("shows loading skeletons while the agent config, queue and runs load", () => {
  vi.mocked(fetchAgentConfig).mockReturnValue(new Promise(() => {}));
  vi.mocked(fetchAgentQueueStatus).mockReturnValue(new Promise(() => {}));

  renderPage();

  expect(screen.getByTestId("agent-mode-skeleton")).toBeTruthy();
  expect(screen.getByTestId("agent-queue-skeleton")).toBeTruthy();
  expect(screen.getByTestId("agent-activity-skeleton")).toBeTruthy();
  expect(screen.queryByText("Agent is Off")).toBeNull();
});

it("replaces the skeletons with content once data has loaded", async () => {
  vi.mocked(fetchAgentConfig).mockResolvedValue({ mode: 1, modeLabel: "Read-Only", autoShutoffAt: null } as never);
  vi.mocked(fetchAgentQueueStatus).mockResolvedValue({ pending: 2, poisonQueue: 0, isProcessing: false } as never);
  vi.mocked(fetchAgentRuns).mockResolvedValue([]);

  renderPage();

  expect(await screen.findByText(/No agent activity yet/)).toBeTruthy();
  expect(await screen.findByText("orders waiting")).toBeTruthy();
  expect(screen.queryByTestId("agent-mode-skeleton")).toBeNull();
  expect(screen.queryByTestId("agent-queue-skeleton")).toBeNull();
  expect(screen.queryByTestId("agent-activity-skeleton")).toBeNull();
});
