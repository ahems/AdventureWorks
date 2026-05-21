import { getFunctionsApiUrl } from "@/lib/utils";

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
    content: data.response || "I wasn't able to find an answer. Please try rephrasing your question.",
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
