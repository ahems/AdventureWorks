import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  Bot,
  Send,
  User,
  Loader2,
  Terminal,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Trash2,
  Plus,
  MessageSquare,
  X,
  Search,
  Lightbulb,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AgentMessage,
  sendAgentMessage,
  getAgentStatus,
} from "@/services/agentService";

const STORAGE_KEY = "ai-agent-conversations";

interface SearchResult {
  conversationId: string;
  conversationTitle: string;
  messageIndex: number;
  content: string;
  role: "user" | "assistant";
  matchSnippet: string;
}

interface Conversation {
  id: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
}

const getInitialMessage = (): AgentMessage => ({
  role: "assistant",
  content: `👋 Hello! I'm your **AdventureWorks AI Assistant**.\n\nI'm connected to the AdventureWorks MCP service and can search products semantically, get order details, analyze reviews, check inventory, and more. Try asking me:\n\n• "Search for mountain bike products"\n• "Who are the top customers?"\n• "Check inventory for product 749"\n• "Analyze reviews for product 749"`,
});

const createNewConversation = (): Conversation => ({
  id: crypto.randomUUID(),
  title: "New Chat",
  messages: [getInitialMessage()],
  createdAt: Date.now(),
});

const loadConversations = (): {
  conversations: Conversation[];
  activeId: string;
} => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.conversations?.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn("Failed to load conversations:", e);
  }
  const initial = createNewConversation();
  return { conversations: [initial], activeId: initial.id };
};

const AiAgentChat: React.FC = () => {
  const [data, setData] = useState(loadConversations);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [agentFeatures, setAgentFeatures] = useState<string[]>([]);
  const [showThreads, setShowThreads] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search across all conversations
  const searchResults = useMemo((): SearchResult[] => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const results: SearchResult[] = [];

    data.conversations.forEach((conv) => {
      conv.messages.forEach((msg, idx) => {
        if (msg.content.toLowerCase().includes(query)) {
          const contentLower = msg.content.toLowerCase();
          const matchIndex = contentLower.indexOf(query);
          const start = Math.max(0, matchIndex - 30);
          const end = Math.min(
            msg.content.length,
            matchIndex + query.length + 30,
          );
          let snippet = msg.content.slice(start, end);
          if (start > 0) snippet = "..." + snippet;
          if (end < msg.content.length) snippet = snippet + "...";

          results.push({
            conversationId: conv.id,
            conversationTitle: conv.title,
            messageIndex: idx,
            content: msg.content,
            role: msg.role as "user" | "assistant",
            matchSnippet: snippet,
          });
        }
      });
    });

    return results.slice(0, 20); // Limit results
  }, [searchQuery, data.conversations]);

  const handleSearchResultClick = useCallback((result: SearchResult) => {
    setData((prev) => ({ ...prev, activeId: result.conversationId }));
    setShowSearch(false);
    setSearchQuery("");
    setShowThreads(false);
  }, []);

  const activeConversation =
    data.conversations.find((c) => c.id === data.activeId) ||
    data.conversations[0];
  const messages = activeConversation?.messages || [getInitialMessage()];

  // Fetch agent features when tools panel is opened for the first time
  useEffect(() => {
    if (showTools && agentFeatures.length === 0) {
      getAgentStatus()
        .then((status) => setAgentFeatures(status.features ?? []))
        .catch(() => setAgentFeatures(["Unable to load features"]));
    }
  }, [showTools, agentFeatures.length]);

  // Persist conversations to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("Failed to save conversations:", e);
    }
  }, [data]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const updateActiveConversation = useCallback(
    (updater: (conv: Conversation) => Conversation) => {
      setData((prev) => ({
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === prev.activeId ? updater(c) : c,
        ),
      }));
    },
    [],
  );

  const createThread = useCallback(() => {
    const newConv = createNewConversation();
    setData((prev) => ({
      conversations: [newConv, ...prev.conversations],
      activeId: newConv.id,
    }));
    setShowThreads(false);
  }, []);

  const switchThread = useCallback((id: string) => {
    setData((prev) => ({ ...prev, activeId: id }));
    setShowThreads(false);
  }, []);

  const deleteThread = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setData((prev) => {
      const remaining = prev.conversations.filter((c) => c.id !== id);
      if (remaining.length === 0) {
        const newConv = createNewConversation();
        return { conversations: [newConv], activeId: newConv.id };
      }
      return {
        conversations: remaining,
        activeId: prev.activeId === id ? remaining[0].id : prev.activeId,
      };
    });
  }, []);

  const clearCurrentHistory = useCallback(() => {
    updateActiveConversation((conv) => ({
      ...conv,
      messages: [getInitialMessage()],
      title: "New Chat",
    }));
  }, [updateActiveConversation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: AgentMessage = { role: "user", content: input.trim() };
    const userInput = input.trim();

    // Update title if this is the first user message
    updateActiveConversation((conv) => {
      const isFirstUserMessage = !conv.messages.some((m) => m.role === "user");
      return {
        ...conv,
        messages: [...conv.messages, userMessage],
        title: isFirstUserMessage
          ? userInput.slice(0, 30) + (userInput.length > 30 ? "..." : "")
          : conv.title,
      };
    });

    setInput("");
    setIsLoading(true);

    try {
      const response = await sendAgentMessage(userInput, messages);
      updateActiveConversation((conv) => ({
        ...conv,
        messages: [...conv.messages, response],
      }));
    } catch (error) {
      updateActiveConversation((conv) => ({
        ...conv,
        messages: [
          ...conv.messages,
          {
            role: "assistant",
            content: "❌ Sorry, something went wrong. Please try again.",
          },
        ],
      }));
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const quickActions = [
    { label: "📊 Stats", message: "Show me the business stats" },
    { label: "🏆 Top Customers", message: "Who are the top 5 customers?" },
    { label: "⏳ Pending Orders", message: "Show pending orders" },
    { label: "📈 Sales Report", message: "Generate sales report by status" },
    { label: "🔍 Product Analysis", message: "Analyze product 749 success" },
  ];

  const suggestedPrompts = [
    {
      icon: "🔍",
      title: "Product Success",
      prompt: "Analyze product 749 success metrics and give me AI insights",
    },
    {
      icon: "📈",
      title: "Sales Report",
      prompt: "Generate a sales report with breakdown by status",
    },
    {
      icon: "👥",
      title: "Customer Report",
      prompt: "Generate a customer report sorted by spending",
    },
    {
      icon: "📦",
      title: "Inventory Report",
      prompt: "Generate an inventory report sorted by popularity",
    },
    {
      icon: "🛒",
      title: "Create Order",
      prompt: "Create a new order for customer 1001 with product 749",
    },
    {
      icon: "🔄",
      title: "Update Order",
      prompt: "Update order 70004 status to processing",
    },
    {
      icon: "✏️",
      title: "Update Customer",
      prompt: "Update customer 1001 email to new@example.com",
    },
    {
      icon: "🎨",
      title: "Generate Image",
      prompt: "Generate a product image for product 749 in 3D render style",
    },
  ];

  const handleQuickAction = (message: string) => {
    setInput(message);
    inputRef.current?.focus();
  };

  const handleSuggestedPrompt = async (prompt: string) => {
    if (isLoading) return;

    const userMessage: AgentMessage = { role: "user", content: prompt };

    updateActiveConversation((conv) => {
      const isFirstUserMessage = !conv.messages.some((m) => m.role === "user");
      return {
        ...conv,
        messages: [...conv.messages, userMessage],
        title: isFirstUserMessage
          ? prompt.slice(0, 30) + (prompt.length > 30 ? "..." : "")
          : conv.title,
      };
    });

    setIsLoading(true);

    try {
      const response = await sendAgentMessage(prompt, messages);
      updateActiveConversation((conv) => ({
        ...conv,
        messages: [...conv.messages, response],
      }));
    } catch (error) {
      updateActiveConversation((conv) => ({
        ...conv,
        messages: [
          ...conv.messages,
          {
            role: "assistant",
            content: "❌ Sorry, something went wrong. Please try again.",
          },
        ],
      }));
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  // Check if we should show suggested prompts (only initial assistant message)
  const showSuggestedPrompts =
    messages.length === 1 && messages[0].role === "assistant";

  const formatContent = (content: string) => {
    return content.split("\n").map((line, i) => {
      line = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      if (line.startsWith("• ") || line.startsWith("  • ")) {
        return (
          <div
            key={i}
            className="pl-2"
            dangerouslySetInnerHTML={{ __html: line }}
          />
        );
      }
      return <div key={i} dangerouslySetInnerHTML={{ __html: line }} />;
    });
  };

  return (
    <div className="doodle-card flex flex-col h-[500px] relative">
      {/* Thread Sidebar */}
      {showThreads && (
        <div className="absolute inset-0 z-20 flex">
          <div className="w-72 bg-doodle-bg border-r-2 border-doodle-text/20 flex flex-col h-full">
            <div className="p-3 border-b-2 border-doodle-text/20 flex items-center justify-between">
              <span className="font-doodle font-bold text-sm text-doodle-text">
                Conversations
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowSearch(!showSearch);
                    setTimeout(() => searchInputRef.current?.focus(), 100);
                  }}
                  className={showSearch ? "bg-doodle-accent/20" : ""}
                >
                  <Search className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowThreads(false)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Search Input */}
            {showSearch && (
              <div className="p-2 border-b-2 border-doodle-text/10">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-doodle-text/40" />
                  <Input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search all messages..."
                    className="font-doodle text-xs pl-8 h-8"
                  />
                </div>
              </div>
            )}

            {/* Search Results */}
            {showSearch && searchQuery.trim() && (
              <div className="border-b-2 border-doodle-text/10 max-h-48 overflow-auto">
                {searchResults.length === 0 ? (
                  <div className="p-3 text-center">
                    <p className="font-doodle text-xs text-doodle-text/50">
                      No results found
                    </p>
                  </div>
                ) : (
                  <div className="p-2 space-y-1">
                    <p className="font-doodle text-xs text-doodle-text/50 px-1 mb-1">
                      {searchResults.length} result
                      {searchResults.length !== 1 ? "s" : ""}
                    </p>
                    {searchResults.map((result, idx) => (
                      <div
                        key={`${result.conversationId}-${result.messageIndex}-${idx}`}
                        onClick={() => handleSearchResultClick(result)}
                        className="p-2 rounded cursor-pointer hover:bg-doodle-accent/10 border-2 border-transparent hover:border-doodle-accent/30 transition-colors"
                      >
                        <div className="flex items-center gap-1 mb-1">
                          {result.role === "user" ? (
                            <User className="w-3 h-3 text-doodle-green" />
                          ) : (
                            <Bot className="w-3 h-3 text-doodle-accent" />
                          )}
                          <span className="font-doodle text-xs font-bold text-doodle-text truncate">
                            {result.conversationTitle}
                          </span>
                        </div>
                        <p className="font-doodle text-xs text-doodle-text/70 line-clamp-2">
                          {result.matchSnippet}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="p-2">
              <Button
                onClick={createThread}
                variant="outline"
                size="sm"
                className="w-full font-doodle text-xs gap-2"
              >
                <Plus className="w-4 h-4" />
                New Chat
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {data.conversations.map((conv) => (
                  <div
                    key={conv.id}
                    onClick={() => switchThread(conv.id)}
                    className={`group flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                      conv.id === data.activeId
                        ? "bg-doodle-accent/20 border-2 border-doodle-accent/40"
                        : "hover:bg-doodle-text/5 border-2 border-transparent"
                    }`}
                  >
                    <MessageSquare className="w-4 h-4 text-doodle-text/60 shrink-0" />
                    <span className="font-doodle text-xs text-doodle-text truncate flex-1">
                      {conv.title}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => deleteThread(conv.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-1 h-auto text-destructive hover:text-destructive"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
          <div
            className="flex-1 bg-doodle-text/20"
            onClick={() => setShowThreads(false)}
          />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b-2 border-doodle-text/20">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowThreads(true)}
            className="p-2"
            title="Show conversations"
          >
            <MessageSquare className="w-5 h-5 text-doodle-text" />
          </Button>
          <div className="w-10 h-10 bg-gradient-to-br from-doodle-accent to-doodle-green flex items-center justify-center rounded-lg border-2 border-doodle-text">
            <Bot className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="font-doodle font-bold text-doodle-text flex items-center gap-2">
              AI Agent
              <Sparkles className="w-4 h-4 text-doodle-accent" />
            </h3>
            <p className="font-doodle text-xs text-doodle-text/60 truncate max-w-[150px]">
              {activeConversation?.title || "New Chat"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={createThread}
            className="font-doodle text-xs gap-1"
            title="New conversation"
          >
            <Plus className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearCurrentHistory}
            className="font-doodle text-xs gap-1 text-destructive hover:text-destructive"
            title="Clear chat history"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTools(!showTools)}
            className="font-doodle text-xs gap-1"
          >
            <Terminal className="w-4 h-4" />
            Tools
            {showTools ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
          </Button>
        </div>
      </div>

      {/* Tools Panel */}
      {showTools && (
        <div className="p-3 bg-doodle-text/5 border-b-2 border-doodle-text/20 max-h-40 overflow-auto">
          <p className="font-doodle text-xs font-bold text-doodle-text mb-2">
            Available MCP Tools:
          </p>
          {agentFeatures.length === 0 ? (
            <span className="font-doodle text-xs text-doodle-text/50">
              Loading…
            </span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {agentFeatures.map((feature) => (
                <span
                  key={feature}
                  className="font-mono text-xs bg-doodle-accent/10 text-doodle-accent px-2 py-0.5 rounded border border-doodle-accent/30"
                >
                  {feature}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        <div className="space-y-4">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}
            >
              {msg.role === "assistant" && (
                <div className="w-8 h-8 bg-doodle-accent/20 flex items-center justify-center rounded-lg border-2 border-doodle-text/30 shrink-0">
                  <Bot className="w-4 h-4 text-doodle-accent" />
                </div>
              )}
              <div
                className={`max-w-[85%] ${
                  msg.role === "user"
                    ? "bg-doodle-accent text-white"
                    : "bg-doodle-bg border-2 border-doodle-text/20"
                } p-3 rounded-lg`}
              >
                <div className="font-doodle text-sm leading-relaxed">
                  {formatContent(msg.content)}
                </div>
                {msg.toolsUsed && msg.toolsUsed.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-doodle-text/10">
                    <p className="font-mono text-xs text-doodle-text/50 mb-1">
                      MCP Tools used:
                    </p>
                    {msg.toolsUsed.map((tool, i) => (
                      <div
                        key={i}
                        className="font-mono text-xs text-doodle-green/80 flex items-center gap-1"
                      >
                        <Terminal className="w-3 h-3" />
                        {tool}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="w-8 h-8 bg-doodle-green/20 flex items-center justify-center rounded-lg border-2 border-doodle-text/30 shrink-0">
                  <User className="w-4 h-4 text-doodle-green" />
                </div>
              )}
            </div>
          ))}

          {/* Suggested Prompts */}
          {showSuggestedPrompts && !isLoading && (
            <div className="mt-4 pt-4 border-t-2 border-doodle-text/10">
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb className="w-4 h-4 text-doodle-accent" />
                <span className="font-doodle text-sm font-bold text-doodle-text/70">
                  Try asking:
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {suggestedPrompts.map((suggestion, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSuggestedPrompt(suggestion.prompt)}
                    className="flex items-start gap-3 p-3 text-left rounded-lg border-2 border-doodle-text/20 hover:border-doodle-accent hover:bg-doodle-accent/5 transition-all group"
                  >
                    <span className="text-lg">{suggestion.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-doodle text-sm font-bold text-doodle-text group-hover:text-doodle-accent transition-colors">
                        {suggestion.title}
                      </p>
                      <p className="font-doodle text-xs text-doodle-text/60 truncate">
                        {suggestion.prompt}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {isLoading && (
            <div className="flex gap-3">
              <div className="w-8 h-8 bg-doodle-accent/20 flex items-center justify-center rounded-lg border-2 border-doodle-text/30">
                <Bot className="w-4 h-4 text-doodle-accent" />
              </div>
              <div className="bg-doodle-bg border-2 border-doodle-text/20 p-3 rounded-lg">
                <div className="flex items-center gap-2 text-doodle-text/60">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="font-doodle text-sm">Thinking…</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Quick Actions */}
      <div className="px-4 py-2 border-t-2 border-doodle-text/10">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {quickActions.map((action) => (
            <button
              key={action.label}
              onClick={() => handleQuickAction(action.message)}
              className="font-doodle text-xs px-3 py-1 border-2 border-doodle-text/20 hover:border-doodle-accent hover:bg-doodle-accent/5 transition-colors whitespace-nowrap rounded"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="p-4 border-t-2 border-doodle-text/20"
      >
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about customers, orders, products..."
            disabled={isLoading}
            className="font-doodle flex-1"
          />
          <Button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-doodle-accent hover:bg-doodle-accent/80"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </form>
    </div>
  );
};

export default AiAgentChat;
