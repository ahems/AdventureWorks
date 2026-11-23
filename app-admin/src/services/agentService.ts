import { getFunctionsApiUrl } from "@/lib/utils";
import {
  getMcpAccessToken,
  getTabAuthorizationGeneration,
  isTabAuthorizationGenerationCurrent,
} from "@/services/dabAuth";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
  suggestedFollowUps?: string[];
  threadId?: string;
  monitoringSessionId?: string;
}

interface AgentApiResponse {
  response: string;
  suggestedQuestions: string[];
  toolsUsed: string[];
  threadId?: string | null;
  monitoringSessionId?: string | null;
  Response?: string;
  SuggestedQuestions?: string[];
  ToolsUsed?: string[];
  ThreadId?: string | null;
  MonitoringSessionId?: string | null;
}

export async function sendAgentMessage(
  message: string,
  conversationHistory: AgentMessage[],
  threadId?: string,
): Promise<AgentMessage> {
  const url = `${getFunctionsApiUrl()}/api/agent/chat`;
  const generation = getTabAuthorizationGeneration();
  const ensureSession = () => {
    if (!isTabAuthorizationGenerationCurrent(generation)) {
      throw new Error("Your secure session has expired. Please sign in again.");
    }
  };

  // Forward a per-user MCP token (minted silently from the sign-in session) so
  // tool calls are authorized as the signed-in admin.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const mcpToken = await getMcpAccessToken();
  ensureSession();
  if (!mcpToken) {
    throw new Error("Your secure session has expired. Please sign in again.");
  }
  headers.Authorization = `Bearer ${mcpToken}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      conversationHistory: conversationHistory.map((m) => ({
        Role: m.role,
        Content: m.content,
      })),
      isAdmin: true,
      threadId,
    }),
  });
  ensureSession();

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    ensureSession();
    throw new Error(
      `Agent API ${response.status}: ${errText || response.statusText}`,
    );
  }

  const data: AgentApiResponse = await response.json();
  ensureSession();
  const returnedThreadId = data.ThreadId ?? data.threadId;
  const returnedSessionId = data.MonitoringSessionId ?? data.monitoringSessionId;
  return {
    role: "assistant",
    content:
      data.Response || data.response ||
      "I wasn't able to find an answer. Please try rephrasing your question.",
    suggestedFollowUps: data.SuggestedQuestions ?? data.suggestedQuestions ?? [],
    toolsUsed: data.ToolsUsed ?? data.toolsUsed ?? [],
    threadId: typeof returnedThreadId === "string" && returnedThreadId.length <= 256 ? returnedThreadId : undefined,
    monitoringSessionId: typeof returnedSessionId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(returnedSessionId) ? returnedSessionId : undefined,
  };
}

export interface AgentTool {
  name: string;
  description: string;
}

export async function getAgentStatus(): Promise<{ features: string[] }> {
  const url = `${getFunctionsApiUrl()}/api/agent/status`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Agent status ${response.status}`);
  return response.json();
}
