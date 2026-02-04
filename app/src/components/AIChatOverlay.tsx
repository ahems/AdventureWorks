import { useState, useEffect, useRef } from "react";
import { X, Send, MessageCircle, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { useTranslation } from "react-i18next";
import { chatWithAgent } from "@/lib/mcpService";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export const AIChatOverlay = () => {
  const { user, isAuthenticated } = useAuth();
  const { selectedLanguage } = useLanguage();
  const { t } = useTranslation("chat");
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Update suggested questions when language changes
  useEffect(() => {
    setSuggestedQuestions([
      t("chat.suggestedQuestions.orderHistory"),
      t("chat.suggestedQuestions.recommendations"),
      t("chat.suggestedQuestions.findAccessories"),
      t("chat.suggestedQuestions.productReviews", { productId: "937" }),
      t("chat.suggestedQuestions.checkStock", { productId: "680" }),
      t("chat.suggestedQuestions.recentOrders"),
    ]);
  }, [selectedLanguage, t]);

  // Welcome message when first opened
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      setMessages([
        {
          id: "1",
          role: "assistant",
          content: t("chat.welcomeMessage", {
            name: user?.firstName || "there",
          }),
          timestamp: new Date(),
        },
      ]);
    }
  }, [isOpen, messages.length, user?.firstName, t]);

  // Update welcome message when language changes (if it's still the first message)
  useEffect(() => {
    if (
      isOpen &&
      messages.length === 1 &&
      messages[0].id === "1" &&
      messages[0].role === "assistant"
    ) {
      setMessages([
        {
          id: "1",
          role: "assistant",
          content: t("chat.welcomeMessage", {
            name: user?.firstName || "there",
          }),
          timestamp: new Date(),
        },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLanguage, t, user?.firstName, isOpen]);

  // Only show for authenticated users
  if (!isAuthenticated) {
    return null;
  }

  const handleSuggestedQuestion = (question: string) => {
    setInput(question);
    textareaRef.current?.focus();
    // Auto-submit after a brief delay
    setTimeout(() => handleSubmit(question), 100);
  };

  const handleSubmit = async (messageText?: string) => {
    const textToSend = messageText || input.trim();
    if (!textToSend || isLoading) return;

    // Add user message
    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: textToSend,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // Build conversation history for context
      const conversationHistory = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Call AI Agent (which uses MCP tools internally)
      const agentResponse = await chatWithAgent(
        textToSend,
        conversationHistory,
        user?.businessEntityId,
        selectedLanguage,
      );

      // Add assistant response
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: agentResponse.response,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // Update suggested questions from AI
      if (
        agentResponse.suggestedQuestions &&
        agentResponse.suggestedQuestions.length > 0
      ) {
        setSuggestedQuestions(agentResponse.suggestedQuestions);
      }
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: t("chat.errorMessage"),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <>
      {/* Chat Toggle Button */}
      {!isOpen && (
        <Button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg z-50 bg-primary hover:bg-primary/90"
          size="icon"
        >
          <MessageCircle className="h-6 w-6" />
        </Button>
      )}

      {/* Chat Overlay */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 w-96 h-[600px] bg-background border rounded-lg shadow-2xl flex flex-col z-50">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b bg-primary text-primary-foreground rounded-t-lg">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              <h3 className="font-semibold">{t("chat.title")}</h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsOpen(false)}
              className="h-8 w-8 text-primary-foreground hover:bg-primary-foreground/20"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Suggested Questions */}
          <div className="p-3 border-b bg-muted/30">
            <p className="text-xs text-muted-foreground mb-2">
              {t("chat.quickQuestions")}
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestedQuestions.map((question, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSuggestedQuestion(question)}
                  disabled={isLoading}
                  className="text-xs px-2.5 py-1.5 rounded-full border bg-background hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex",
                    message.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg p-3 whitespace-pre-wrap",
                      message.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted",
                    )}
                  >
                    <p className="text-sm">{message.content}</p>
                    <p className="text-xs opacity-70 mt-1">
                      {message.timestamp.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg p-3">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input */}
          <div className="p-4 border-t">
            <div className="flex gap-2">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("chat.messagePlaceholder")}
                className="min-h-[60px] max-h-[120px] resize-none"
                disabled={isLoading}
              />
              <Button
                onClick={() => handleSubmit()}
                disabled={!input.trim() || isLoading}
                size="icon"
                className="shrink-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {t("chat.sendHint")}
            </p>
          </div>
        </div>
      )}
    </>
  );
};
