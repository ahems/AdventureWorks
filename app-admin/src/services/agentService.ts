import { getFunctionsApiUrl } from "@/lib/utils";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
  suggestedFollowUps?: string[];
}

interface AgentApiResponse {
  Response: string;
  SuggestedQuestions: string[];
  ToolsUsed: string[];
}

export async function sendAgentMessage(
  message: string,
  conversationHistory: AgentMessage[],
): Promise<AgentMessage> {
  const url = `${getFunctionsApiUrl()}/api/agent/chat`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      conversationHistory: conversationHistory.map((m) => ({
        Role: m.role,
        Content: m.content,
      })),
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
    content: data.Response ?? "No response from agent.",
    suggestedFollowUps: data.SuggestedQuestions ?? [],
    toolsUsed: data.ToolsUsed ?? [],
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
