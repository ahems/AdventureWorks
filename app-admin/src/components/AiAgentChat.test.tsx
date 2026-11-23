import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import AiAgentChat from "./AiAgentChat";
const agent = vi.hoisted(() => ({ sendAgentMessage: vi.fn(), getAgentStatus: vi.fn() }));
vi.mock("@/services/agentService", () => agent);
vi.mock("@/services/dabAuth", () => ({
  getTabAuthorizationGeneration: () => "generation",
  authorizationStorageKey: (key: string) => key,
  isTabAuthorizationGenerationCurrent: () => true,
}));
beforeEach(() => {
  vi.clearAllMocks();
  agent.sendAgentMessage.mockResolvedValue({ role: "assistant", content: "answer", threadId: "server-thread", monitoringSessionId: "aa000000-0000-0000-0000-000000000000" });
});
const submit = (message: string) => {
  const input = screen.getByPlaceholderText("Ask about customers, orders, products...");
  fireEvent.change(input, { target: { value: message } });
  fireEvent.submit(input.closest("form")!);
};

it("displays the returned server session ID for copying and continues the owned server conversation", async () => {
  render(<AiAgentChat />);
  submit("first question");
  expect(await screen.findByLabelText("Monitoring session ID")).toHaveValue("aa000000-0000-0000-0000-000000000000");
  submit("second question");
  await waitFor(() => expect(agent.sendAgentMessage).toHaveBeenLastCalledWith("second question", expect.any(Array), "server-thread"));
});

it("does not attach late server ownership/capture metadata to a cleared conversation", async () => {
  let resolve: (result: object) => void;
  agent.sendAgentMessage.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<AiAgentChat />);
  submit("first question");
  fireEvent.click(screen.getByTitle("Clear chat history"));
  await act(async () => resolve({ role: "assistant", content: "late", threadId: "server-thread", monitoringSessionId: "aa000000-0000-0000-0000-000000000000" }));
  expect(screen.queryByLabelText("Monitoring session ID")).not.toBeInTheDocument();
  expect(screen.queryByText("late")).not.toBeInTheDocument();
});
