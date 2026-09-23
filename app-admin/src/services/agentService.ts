import { getFunctionsApiUrl } from "@/lib/utils";
import { getAccessToken } from "@/services/mcpAuth";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
  suggestedFollowUps?: string[];
}

interface AgentApiResponse {
  response: string;
  suggestedQuestions: string[];
  toolsUsed: string[];
}

export async function sendAgentMessage(
  message: string,
  conversationHistory: AgentMessage[],
): Promise<AgentMessage> {
  const url = `${getFunctionsApiUrl()}/api/agent/chat`;

  // Attach the delegated MCP access token when the employee has authorized via
  // OAuth. api-functions forwards it to the MCP server so tool calls run under
  // this user's scopes/ownership. Safe no-op when the user has not authorized.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getAccessToken();
  if (token) {
    const scheme = "Bearer";
    headers.Authorization = scheme + " " + token;
  }

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
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Agent API ${response.status}: ${errText || response.statusText}`,
    );
  }

  const data: AgentApiResponse = await response.json();
  return {
    role: "assistant",
    content:
      data.response ||
      "I wasn't able to find an answer. Please try rephrasing your question.",
    suggestedFollowUps: data.suggestedQuestions ?? [],
    toolsUsed: data.toolsUsed ?? [],
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
