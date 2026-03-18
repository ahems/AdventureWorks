import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  MicOff,
  X,
  Send,
  Volume2,
  Loader2,
  Bot,
  User,
  Minimize2,
  Maximize2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { sendAgentMessage, AgentMessage } from "@/services/agentService";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface VoiceSalesAssistantProps {
  isOpen: boolean;
  onClose: () => void;
}

const VoiceSalesAssistant: React.FC<VoiceSalesAssistantProps> = ({
  isOpen,
  onClose,
}) => {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [useVoiceMode, setUseVoiceMode] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [speechSupported, setSpeechSupported] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition;
    if (SpeechRecognitionAPI) {
      setSpeechSupported(true);
    } else {
      setUseVoiceMode(false);
    }
  }, []);

  // Load conversation history from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("voiceAssistantHistory");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setMessages(
          parsed.map((m: Message) => ({
            ...m,
            timestamp: new Date(m.timestamp),
          })),
        );
      } catch (e) {
        console.error("Failed to parse voice assistant history");
      }
    }
  }, []);

  // Save conversation history
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(
        "voiceAssistantHistory",
        JSON.stringify(messages.slice(-20)),
      );
    }
  }, [messages]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const startListening = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return;
    const recognition = new SpeechRecognitionAPI();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      setIsListening(false);
      processQuery(transcript);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
  };

  const processQuery = async (query: string) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: query,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsProcessing(true);
    try {
      const history: AgentMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const agentReply = await sendAgentMessage(query, history);
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: agentReply.content,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      if (useVoiceMode && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(agentReply.content);
        utt.onstart = () => setIsSpeaking(true);
        utt.onend = () => setIsSpeaking(false);
        utt.onerror = () => setIsSpeaking(false);
        window.speechSynthesis.speak(utt);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant" as const,
          content: "Sorry, I couldn't get a response. Please try again.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      processQuery(inputText.trim());
      setInputText("");
    }
  };

  const clearHistory = () => {
    setMessages([]);
    localStorage.removeItem("voiceAssistantHistory");
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className={`fixed z-50 transition-all duration-300 ${
        isMinimized
          ? "bottom-6 right-6 w-72"
          : "bottom-6 right-6 w-96 max-w-[calc(100vw-2rem)]"
      }`}
    >
      <div className="doodle-card overflow-hidden flex flex-col shadow-xl">
        {/* Header */}
        <div className="bg-doodle-accent text-white px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full bg-white/20 flex items-center justify-center ${isSpeaking ? "animate-pulse" : ""}`}
            >
              {isSpeaking ? (
                <Volume2 className="w-4 h-4" />
              ) : (
                <Bot className="w-4 h-4" />
              )}
            </div>
            <div>
              <h3 className="font-doodle font-bold text-sm">
                AI Voice Assistant
              </h3>
              <p className="font-doodle text-xs opacity-80">
                {isListening
                  ? "🎤 Listening..."
                  : isProcessing
                    ? "🤔 Thinking..."
                    : isSpeaking
                      ? "🔊 Speaking..."
                      : "Ready to help"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/20"
              onClick={() => setIsMinimized(!isMinimized)}
            >
              {isMinimized ? (
                <Maximize2 className="w-4 h-4" />
              ) : (
                <Minimize2 className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/20"
              onClick={onClose}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {!isMinimized && (
          <>
            {/* Messages */}
            <ScrollArea className="h-72 p-4" ref={scrollRef}>
              {messages.length === 0 ? (
                <div className="text-center py-8">
                  <Bot className="w-12 h-12 mx-auto text-doodle-text/30 mb-3" />
                  <p className="font-doodle text-sm text-doodle-text/60">
                    Hi! I'm your AI sales assistant.
                  </p>
                  <p className="font-doodle text-xs text-doodle-text/40 mt-1">
                    Ask me about customers, orders, or products.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                    >
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                          msg.role === "user"
                            ? "bg-doodle-green text-white"
                            : "bg-doodle-accent text-white"
                        }`}
                      >
                        {msg.role === "user" ? (
                          <User className="w-4 h-4" />
                        ) : (
                          <Bot className="w-4 h-4" />
                        )}
                      </div>
                      <div
                        className={`max-w-[80%] px-3 py-2 rounded-lg border-2 border-doodle-text ${
                          msg.role === "user"
                            ? "bg-doodle-green/10"
                            : "bg-doodle-bg"
                        }`}
                      >
                        <p className="font-doodle text-sm text-doodle-text">
                          {msg.content}
                        </p>
                        <p className="font-doodle text-xs text-doodle-text/40 mt-1">
                          {msg.timestamp.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  ))}
                  {isProcessing && (
                    <div className="flex gap-2">
                      <div className="w-7 h-7 rounded-full bg-doodle-accent text-white flex items-center justify-center">
                        <Bot className="w-4 h-4" />
                      </div>
                      <div className="bg-doodle-bg px-3 py-2 rounded-lg border-2 border-doodle-text">
                        <Loader2 className="w-4 h-4 animate-spin text-doodle-accent" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>

            {/* Voice Recording Visualization */}
            {isListening && (
              <div className="px-4 py-3 bg-doodle-accent/10 border-t-2 border-dashed border-doodle-text/20">
                <div className="flex items-center justify-center gap-1">
                  {[...Array(5)].map((_, i) => (
                    <div
                      key={i}
                      className="w-1 bg-doodle-accent rounded-full animate-pulse"
                      style={{
                        height: `${Math.random() * 20 + 10}px`,
                        animationDelay: `${i * 0.1}s`,
                      }}
                    />
                  ))}
                  <span className="font-doodle text-sm text-doodle-accent ml-2">
                    Listening...
                  </span>
                </div>
              </div>
            )}

            {/* Input Area */}
            <div className="p-3 border-t-2 border-dashed border-doodle-text/20">
              <div className="flex items-center gap-2 mb-2">
                {speechSupported && (
                  <button
                    onClick={() => setUseVoiceMode(!useVoiceMode)}
                    className={`font-doodle text-xs px-2 py-1 rounded border-2 border-doodle-text transition-colors ${
                      useVoiceMode
                        ? "bg-doodle-accent text-white"
                        : "bg-transparent text-doodle-text"
                    }`}
                  >
                    {useVoiceMode ? "🎤 Voice" : "⌨️ Text"}
                  </button>
                )}
                {messages.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="font-doodle text-xs text-doodle-text/50 hover:text-doodle-accent ml-auto"
                  >
                    Clear history
                  </button>
                )}
              </div>

              {useVoiceMode ? (
                <button
                  onClick={isListening ? stopListening : startListening}
                  disabled={isProcessing}
                  className={`w-full py-3 font-doodle font-bold rounded-lg border-3 transition-all flex items-center justify-center gap-2 ${
                    isListening
                      ? "bg-doodle-accent text-white border-doodle-text animate-pulse"
                      : "bg-doodle-bg text-doodle-text border-doodle-text hover:bg-doodle-accent hover:text-white"
                  }`}
                >
                  {isListening ? (
                    <>
                      <MicOff className="w-5 h-5" />
                      Listening...
                    </>
                  ) : (
                    <>
                      <Mic className="w-5 h-5" />
                      Tap to Speak
                    </>
                  )}
                </button>
              ) : (
                <form onSubmit={handleSendText} className="flex gap-2">
                  <Input
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Ask about customers, orders..."
                    className="flex-1 font-doodle border-2 border-doodle-text"
                    disabled={isProcessing}
                  />
                  <Button
                    type="submit"
                    disabled={!inputText.trim() || isProcessing}
                    className="doodle-button doodle-button-primary"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </form>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default VoiceSalesAssistant;
