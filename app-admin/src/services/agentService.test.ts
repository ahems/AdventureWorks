import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendAgentMessage } from "./agentService";
vi.mock("@/lib/utils", () => ({ getFunctionsApiUrl: () => "https://functions.example.test" }));
vi.mock("@/services/dabAuth", () => ({
  getMcpAccessToken: async () => "resource-bound-token",
  getTabAuthorizationGeneration: () => "generation",
  isTabAuthorizationGenerationCurrent: () => true,
}));
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

it("preserves server conversation continuity and exposes only a server-returned valid monitoring GUID", async () => {
  const sessionId = "aa000000-0000-0000-0000-000000000000";
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    Response: "answer", ThreadId: "server-conversation", MonitoringSessionId: sessionId,
    SuggestedQuestions: [], ToolsUsed: [],
  })));
  const result = await sendAgentMessage("question", [], "owned-conversation");
  expect(result.monitoringSessionId).toBe(sessionId);
  expect(result.threadId).toBe("server-conversation");
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
  expect(body.threadId).toBe("owned-conversation");
  expect(body).not.toHaveProperty("monitoringSessionId");
  expect(body).not.toHaveProperty("captureId");
});

it("does not invent or forward a monitoring session identifier when one is absent or malformed", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ response: "answer", monitoringSessionId: "untrusted-selection" })));
  const result = await sendAgentMessage("question", []);
  expect(result.monitoringSessionId).toBeUndefined();
});
