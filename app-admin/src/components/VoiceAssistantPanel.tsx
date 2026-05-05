import React, { useState, useRef, useEffect } from "react";
import { Send, Loader2, Bot, X } from "lucide-react";
import { getFunctionsApiUrl } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface VoiceAssistantPanelProps {
  onClose: () => void;
}

const VoiceAssistantPanel: React.FC<VoiceAssistantPanelProps> = ({
  onClose,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);

    try {
      const res = await fetch(`${getFunctionsApiUrl()}/AiAgentChat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();
      const reply =
        typeof data === "string"
          ? data
          : (data?.response ??
            data?.message ??
            "I couldn't process that request.");

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 md:w-96 flex flex-col doodle-card shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b-2 border-doodle-text">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-doodle-accent" />
          <h3 className="font-doodle font-bold text-doodle-text">
            AI Voice Assistant
          </h3>
        </div>
        <button
          onClick={onClose}
          className="doodle-button p-1"
          aria-label="Close voice assistant"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[200px] max-h-[300px]">
        {messages.length === 0 && (
          <p className="font-doodle text-sm text-doodle-text/50 text-center pt-4">
            Ask me about customers, orders, products, or any business data.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] p-2 font-doodle text-sm border-2 ${
                msg.role === "user"
                  ? "border-doodle-accent bg-doodle-accent/10 text-doodle-text"
                  : "border-doodle-text/30 bg-doodle-bg text-doodle-text"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="p-2 border-2 border-doodle-text/30 bg-doodle-bg">
              <Loader2 className="w-4 h-4 animate-spin text-doodle-accent" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="p-3 border-t-2 border-doodle-text/20 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about customers, orders, or products..."
          className="flex-1 doodle-input text-sm py-1.5"
          disabled={isLoading}
          autoFocus
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="doodle-button doodle-button-primary p-2 disabled:opacity-50"
          aria-label="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};

export default VoiceAssistantPanel;
