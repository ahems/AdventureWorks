import React, { useState, useEffect, useRef, useMemo } from "react";
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
import { Customer } from "@/types/customer";
import { Order } from "@/types/order";
import { Product } from "@/types/product";
import { useAdminCustomers } from "@/hooks/useAdminCustomers";
import { useAdminOrders } from "@/hooks/useAdminOrders";
import { useAdminAllProducts } from "@/hooks/useAdminProducts";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface VoiceDataContext {
  customers: Customer[];
  orders: Order[];
  products: Product[];
}

const getAIResponse = (query: string, ctx: VoiceDataContext): string => {
  const lowerQuery = query.toLowerCase();
  const customerMap = new Map(ctx.customers.map((c) => [c.CustomerID, c]));

  const customerResponse = () => {
    const idMatch = query.match(/\d+/);
    if (idMatch) {
      const customer = customerMap.get(parseInt(idMatch[0]));
      if (customer) {
        return `Found customer ${customer.FirstName} ${customer.LastName} from ${customer.City}, ${customer.StateProvince}. They have placed ${customer.TotalOrders} orders totaling $${customer.TotalSpent.toLocaleString()}. Contact: ${customer.EmailAddress}`;
      }
    }
    // Compute top customers from orders
    const spendByCustomer = ctx.orders.reduce(
      (acc, o) => {
        acc[o.CustomerID] = (acc[o.CustomerID] || 0) + (o.TotalDue || 0);
        return acc;
      },
      {} as Record<number, number>,
    );
    const topCustomers = [...ctx.customers]
      .map((c) => ({
        ...c,
        computedSpend: spendByCustomer[c.CustomerID] || c.TotalSpent || 0,
      }))
      .filter((c) => c.computedSpend > 0)
      .sort((a, b) => b.computedSpend - a.computedSpend)
      .slice(0, 3);
    if (topCustomers.length === 0)
      return "No customer spend data is available yet.";
    return `Here are your top customers by spend: ${topCustomers.map((c, i) => `${i + 1}. ${c.FirstName} ${c.LastName} ($${c.computedSpend.toLocaleString()})`).join(", ")}. Would you like details on any specific customer?`;
  };

  const orderResponse = () => {
    const idMatch = query.match(/\d+/);
    if (idMatch) {
      const order = ctx.orders.find(
        (o) => o.SalesOrderID === parseInt(idMatch[0]),
      );
      if (order) {
        const customer = customerMap.get(order.CustomerID);
        return `Order #${order.SalesOrderID} for ${customer?.FirstName ?? ""} ${customer?.LastName ?? ""} is currently "${order.Status}". Total: $${(order.TotalDue ?? 0).toFixed(2)}. Contains ${order.OrderItems?.length ?? 0} item(s). ${order.ShipDate ? `Shipped on ${new Date(order.ShipDate).toLocaleDateString()}` : "Not yet shipped."}`;
      }
    }
    const pending = ctx.orders.filter(
      (o) => o.Status === "Pending" || o.Status === "Processing",
    );
    return `You have ${pending.length} orders pending or in processing. Total pending revenue: $${pending.reduce((sum, o) => sum + (o.TotalDue || 0), 0).toLocaleString()}. Would you like me to list them?`;
  };

  const productResponse = () => {
    const searchTerm = lowerQuery;
    const matchedProduct = ctx.products.find(
      (p) =>
        p.Name.toLowerCase().includes(searchTerm) ||
        p.ProductNumber.toLowerCase().includes(searchTerm),
    );
    if (matchedProduct) {
      return `${matchedProduct.Name} (${matchedProduct.ProductNumber}) is priced at $${matchedProduct.ListPrice.toFixed(2)}. ${matchedProduct.salePercent ? `Currently on sale: ${matchedProduct.salePercent}% off!` : ""} ${matchedProduct.Description ?? ""}`;
    }
    const topProducts = ctx.products.slice(0, 3);
    return `I couldn't find a specific product match. Here are some popular items: ${topProducts.map((p) => `${p.Name} at $${p.ListPrice.toFixed(2)}`).join(", ")}. What would you like to know more about?`;
  };

  const salesResponse = () => {
    const totalRevenue = ctx.orders.reduce(
      (sum, o) => sum + (o.TotalDue || 0),
      0,
    );
    const deliveredOrders = ctx.orders.filter((o) => o.Status === "Delivered");
    const orderCount = ctx.orders.length;
    return `Total sales across ${orderCount} orders: $${totalRevenue.toLocaleString()}. ${deliveredOrders.length} orders have been delivered. Average order value: $${orderCount > 0 ? (totalRevenue / orderCount).toFixed(2) : "0.00"}.`;
  };

  if (lowerQuery.includes("customer") || lowerQuery.includes("who")) {
    return customerResponse();
  }
  if (
    lowerQuery.includes("order") ||
    lowerQuery.includes("status") ||
    lowerQuery.includes("ship")
  ) {
    return orderResponse();
  }
  if (
    lowerQuery.includes("product") ||
    lowerQuery.includes("bike") ||
    lowerQuery.includes("price") ||
    lowerQuery.includes("road") ||
    lowerQuery.includes("mountain")
  ) {
    return productResponse();
  }
  if (
    lowerQuery.includes("sales") ||
    lowerQuery.includes("revenue") ||
    lowerQuery.includes("total")
  ) {
    return salesResponse();
  }
  if (lowerQuery.includes("help") || lowerQuery.includes("what can you")) {
    return "I can help you with: 1) Customer lookups - ask about specific customers or top customers. 2) Order status - check order details or pending orders. 3) Product information - get pricing and availability. 4) Sales summaries - overall performance metrics. What would you like to know?";
  }

  return "I can help you look up customers, check order status, find product information, or review sales data. Try asking something like 'Show me customer 1003' or 'What's the status of order 70001?'";
};

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

  const { data: customers = [] } = useAdminCustomers();
  const { data: orders = [] } = useAdminOrders();
  const { data: products = [] } = useAdminAllProducts();

  const dataCtx = useMemo<VoiceDataContext>(
    () => ({ customers, orders, products }),
    [customers, orders, products],
  );

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

  const simulateListening = () => {
    setIsListening(true);

    // Simulate listening for 2 seconds
    setTimeout(() => {
      setIsListening(false);

      // Fake transcribed queries
      const fakeQueries = [
        "What's the status of order 70003?",
        "Show me customer 1003",
        "Tell me about the Road-150 bike",
        "How are sales looking?",
        "What orders are pending?",
      ];
      const randomQuery =
        fakeQueries[Math.floor(Math.random() * fakeQueries.length)];

      processQuery(randomQuery);
    }, 2000);
  };

  const processQuery = (query: string) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: query,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);

    setIsProcessing(true);

    // Simulate AI thinking
    setTimeout(() => {
      setIsProcessing(false);
      const response = getAIResponse(query, dataCtx);

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: response,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // Simulate speaking the response
      if (useVoiceMode) {
        setIsSpeaking(true);
        setTimeout(() => setIsSpeaking(false), 3000);
      }
    }, 1500);
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
                  onClick={simulateListening}
                  disabled={isListening || isProcessing}
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
                      Hold to Speak
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
