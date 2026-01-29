/**
 * MCP Service - Communicates with AdventureWorks AI Agent
 * Calls AI Agent which uses MCP tools internally
 */

import { trackError } from "@/lib/appInsights";

const getAgentEndpoint = (): string => {
  // Check for runtime config first (Azure deployment)
  if (typeof window !== "undefined" && window.APP_CONFIG?.API_FUNCTIONS_URL) {
    return `${window.APP_CONFIG.API_FUNCTIONS_URL}/api/agent`;
  }

  // Fallback to environment variable (local development)
  const functionsUrl = import.meta.env.VITE_API_FUNCTIONS_URL;
  if (functionsUrl) {
    return `${functionsUrl}/api/agent`;
  }

  // Last resort fallback
  return "/api/agent";
};

interface ChatMessage {
  role: string;
  content: string;
}

interface AgentChatRequest {
  message: string;
  conversationHistory: ChatMessage[];
  customerId?: number;
  cultureId?: string;
}

interface AgentChatResponse {
  response: string;
  suggestedQuestions: string[];
  toolsUsed: string[];
}

/**
 * Chat with the AI Agent (which uses MCP tools internally)
 */
export const chatWithAgent = async (
  message: string,
  conversationHistory: ChatMessage[],
  customerId?: number,
  cultureId?: string,
): Promise<AgentChatResponse> => {
  const endpoint = getAgentEndpoint();

  const request: AgentChatRequest = {
    message,
    conversationHistory,
    customerId,
    cultureId,
  };

  try {
    const response = await fetch(`${endpoint}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Agent call failed: ${response.statusText}`);
    }

    const data = await response.json();

    // Map API response (capital case) to interface (lowercase)
    const result: AgentChatResponse = {
      response: data.Response || data.response || "",
      suggestedQuestions:
        data.SuggestedQuestions || data.suggestedQuestions || [],
      toolsUsed: data.ToolsUsed || data.toolsUsed || [],
    };

    return result;
  } catch (error) {
    trackError("Agent chat error", error, {
      service: "mcpService",
      function: "chatWithAgent",
    });
    throw error;
  }
};

/**
 * Get agent status
 */
export const getAgentStatus = async () => {
  const endpoint = getAgentEndpoint();

  try {
    const response = await fetch(`${endpoint}/status`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get agent status: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    trackError("Failed to get agent status", error, {
      service: "mcpService",
      function: "getAgentStatus",
    });
    throw error;
  }
};

// Legacy MCP tool direct call functions (kept for backward compatibility)
const getMCPEndpoint = (): string => {
  // Check for runtime config first (Azure deployment)
  if (typeof window !== "undefined" && window.APP_CONFIG?.API_FUNCTIONS_URL) {
    return `${window.APP_CONFIG.API_FUNCTIONS_URL}/api/mcp`;
  }

  // Fallback to environment variable (local development)
  const functionsUrl = import.meta.env.VITE_API_FUNCTIONS_URL;
  if (functionsUrl) {
    return `${functionsUrl}/api/mcp`;
  }

  // Last resort fallback
  return "/api/mcp";
};

interface McpToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

interface McpToolResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError: boolean;
}

/**
 * Call an MCP tool on the server
 */
export const callMCPTool = async (
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const endpoint = getMCPEndpoint();

  const request: McpToolRequest = {
    name: toolName,
    arguments: args,
  };

  try {
    const response = await fetch(`${endpoint}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`MCP call failed: ${response.statusText}`);
    }

    const data: McpToolResponse = await response.json();

    if (data.isError) {
      throw new Error(data.content[0]?.text || "Unknown error");
    }

    return data.content[0]?.text || "No response from server";
  } catch (error) {
    trackError("MCP tool call error", error, {
      service: "mcpService",
      function: "callMCPTool",
      toolName: name,
    });
    throw error;
  }
};

/**
 * Get available MCP tools
 */
export const listMCPTools = async () => {
  const endpoint = getMCPEndpoint();

  try {
    const response = await fetch(`${endpoint}/tools`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list tools: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    trackError("Failed to list MCP tools", error, {
      service: "mcpService",
      function: "listMCPTools",
    });
    throw error;
  }
};
