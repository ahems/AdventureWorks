import React, { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  Sparkles,
  X,
  ChevronRight,
  Loader2,
  CheckCircle,
  AlertCircle,
  ShoppingBag,
  FileText,
  Users,
  RefreshCw,
  ChevronDown,
  Layers,
  ExternalLink,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import {
  generateOrderWithAI,
  generateOrdersBulk,
  getTopSpenders,
  type TopSpenderCustomer,
} from "@/services/utilityService";
import { useQueryClient } from "@tanstack/react-query";

interface LogEntry {
  message: string;
  type: "info" | "success" | "error" | "dim";
}

interface GeneratedOrderResult {
  success: boolean;
  salesOrderId: number;
  customerName?: string;
  customerEmail?: string;
  newCustomerCreated?: boolean;
  totalDue?: number;
  receiptPdfBase64?: string;
  errorMessage?: string;
  log: LogEntry[];
  threadId?: string;
}

const PERSONA_OPTIONS = [
  {
    value: "newbie-male",
    label: "🚵 Newbie Male Cyclist",
    description:
      "First-time buyer — needs a starter bike, helmet, and basic gear",
  },
  {
    value: "newbie-female",
    label: "🚴 Newbie Female Cyclist",
    description:
      "First-time buyer — entry-level bike and women's clothing/accessories",
  },
  {
    value: "experienced-male",
    label: "🏆 Experienced Male Cyclist",
    description:
      "Existing customer — upgrading components or replacing worn gear",
  },
  {
    value: "experienced-female",
    label: "🏅 Experienced Female Cyclist",
    description:
      "Existing customer — smaller accessories and lifestyle refreshes",
  },
  {
    value: "family-shopper",
    label: "👨‍👩‍👧‍👦 Family Shopper",
    description: "Buying bikes and helmets for the whole family",
  },
  {
    value: "commuter",
    label: "🏙️ Urban Commuter",
    description: "Daily rider — practical items, locks, lights, commuter gear",
  },
  {
    value: "mountain-enthusiast",
    label: "⛰️ Mountain Enthusiast",
    description: "High-performance mountain bike and protective gear collector",
  },
  {
    value: "existing-customer",
    label: "🧑 Existing Customer",
    description:
      "AI analyses a real customer's profile & order history, then simulates their next purchase",
  },
  {
    value: "custom",
    label: "✍️ Custom Persona",
    description: "Describe your own customer scenario",
  },
];

const GenerateOrdersWizardDialog: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<
    "configure" | "running" | "done" | "refining"
  >("configure");
  const [selectedPersona, setSelectedPersona] = useState("newbie-male");
  const [customPersona, setCustomPersona] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<GeneratedOrderResult | null>(null);
  const [refineMessage, setRefineMessage] = useState("");
  const [showReceipt, setShowReceipt] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const isRunning = useRef(false);
  const queryClient = useQueryClient();

  // Existing customer persona state
  const [topSpenders, setTopSpenders] = useState<TopSpenderCustomer[]>([]);
  const [topSpendersLoading, setTopSpendersLoading] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<
    number | undefined
  >(undefined);
  const [customerSearchQuery, setCustomerSearchQuery] = useState("");
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);

  // Bulk generation state
  const [bulkCount, setBulkCount] = useState(10);
  const [bulkStep, setBulkStep] = useState<"idle" | "queuing" | "queued">(
    "idle",
  );
  const [bulkResult, setBulkResult] = useState<{
    queued: number;
    message: string;
  } | null>(null);

  const addLog = useCallback(
    (message: string, type: LogEntry["type"] = "info") => {
      setLog((prev) => [...prev, { message, type }]);
      setTimeout(
        () => logEndRef.current?.scrollIntoView({ behavior: "smooth" }),
        50,
      );
    },
    [],
  );

  // Load top spenders when the existing-customer persona is selected
  useEffect(() => {
    if (selectedPersona === "existing-customer" && topSpenders.length === 0) {
      setTopSpendersLoading(true);
      getTopSpenders(100)
        .then((data) => setTopSpenders(data))
        .catch(() =>
          toast({
            title: "Failed to load customers",
            description: "Could not fetch top-spending customers",
            variant: "destructive",
          }),
        )
        .finally(() => setTopSpendersLoading(false));
    }
  }, [selectedPersona, topSpenders.length]);

  const filteredCustomers = topSpenders.filter((c) => {
    if (!customerSearchQuery.trim()) return true;
    const q = customerSearchQuery.toLowerCase();
    return (
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q)
    );
  });

  const selectedCustomer = topSpenders.find(
    (c) => c.customerID === selectedCustomerId,
  );

  const handleOpen = () => {
    setStep("configure");
    setLog([]);
    setResult(null);
    setRefineMessage("");
    setShowReceipt(false);
    setBulkStep("idle");
    setBulkResult(null);
    setIsOpen(true);
  };

  const handleClose = () => {
    if (isRunning.current) return;
    setIsOpen(false);
  };

  const handleBulkGenerate = async () => {
    setBulkStep("queuing");
    try {
      const res = await generateOrdersBulk(bulkCount);
      setBulkResult(res);
      setBulkStep("queued");
      toast({
        title: `${res.queued} orders queued`,
        description: res.message,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setBulkStep("idle");
      toast({
        title: "Bulk generation failed",
        description: msg,
        variant: "destructive",
      });
    }
  };

  const handleGenerate = async () => {
    if (selectedPersona === "custom" && !customPersona.trim()) return;
    if (selectedPersona === "existing-customer" && !selectedCustomerId) return;

    setStep("running");
    setLog([]);
    isRunning.current = true;

    addLog("Starting AI Order Generation Wizard...", "info");
    addLog(
      "The AI will research the catalogue, promotions, and customers before deciding what to order.",
      "dim",
    );

    try {
      const personaType =
        selectedPersona === "custom" ? "custom" : selectedPersona;
      const persona =
        selectedPersona === "custom" ? customPersona.trim() : undefined;
      const seedId =
        selectedPersona === "existing-customer"
          ? selectedCustomerId
          : undefined;

      const res = await generateOrderWithAI(personaType, persona, seedId);

      // Replay the server-side log into our UI log
      if (res.log && Array.isArray(res.log)) {
        for (const entry of res.log) {
          addLog(entry.message, entry.type ?? "info");
        }
      }

      setResult(res);

      if (res.success) {
        // Invalidate orders cache so the new order shows up immediately
        queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });

        toast({
          title: `Order #${res.salesOrderId} Created`,
          description: `${res.customerName} — $${(res.totalDue ?? 0).toFixed(2)}`,
        });
      } else {
        addLog(res.errorMessage ?? "Unknown error", "error");
        toast({
          title: "Order generation failed",
          description: res.errorMessage ?? "See log for details",
          variant: "destructive",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addLog(`Error: ${msg}`, "error");
      toast({
        title: "Order generation failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      isRunning.current = false;
      setStep("done");
    }
  };

  const handleRefine = async () => {
    if (!refineMessage.trim() || !result?.threadId) return;

    setStep("running");
    setLog([]);
    isRunning.current = true;

    addLog("Refining order based on your feedback…", "info");

    try {
      const personaType =
        selectedPersona === "custom" ? "custom" : selectedPersona;
      const persona =
        selectedPersona === "custom" ? customPersona.trim() : undefined;
      const seedId =
        selectedPersona === "existing-customer"
          ? selectedCustomerId
          : undefined;

      const res = await generateOrderWithAI(
        personaType,
        persona,
        seedId,
        result.threadId,
      );

      if (res.log && Array.isArray(res.log)) {
        for (const entry of res.log) {
          addLog(entry.message, entry.type ?? "info");
        }
      }

      setResult(res);
      setRefineMessage("");

      if (res.success) {
        queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
        toast({
          title: `Order #${res.salesOrderId} Created`,
          description: `${res.customerName} — $${(res.totalDue ?? 0).toFixed(2)}`,
        });
      } else {
        addLog(res.errorMessage ?? "Unknown error", "error");
        toast({
          title: "Order refinement failed",
          description: res.errorMessage ?? "See log for details",
          variant: "destructive",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addLog(`Error: ${msg}`, "error");
      toast({
        title: "Order refinement failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      isRunning.current = false;
      setStep("done");
    }
  };

  const canStart =
    (selectedPersona !== "custom" || customPersona.trim().length >= 10) &&
    (selectedPersona !== "existing-customer" || !!selectedCustomerId);

  const selectedOption = PERSONA_OPTIONS.find(
    (p) => p.value === selectedPersona,
  );

  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className="doodle-button doodle-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm shrink-0"
      >
        <Sparkles className="w-4 h-4" />
        Generate with AI
      </button>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Generate Order with AI"
        className="bg-doodle-bg border-4 border-doodle-text shadow-doodle w-full max-w-2xl mx-4 flex flex-col"
        style={{ maxHeight: "90vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b-2 border-doodle-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-doodle-accent" />
            <h2 className="font-doodle text-lg font-bold text-doodle-text">
              Generate Order with AI
            </h2>
          </div>
          <button
            onClick={handleClose}
            disabled={isRunning.current}
            className="text-doodle-text/60 hover:text-doodle-text disabled:opacity-30"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Configure step */}
          {step === "configure" && (
            <div className="space-y-4">
              <p className="font-doodle text-sm text-doodle-text/70">
                Choose a customer persona. The AI will research the catalogue,
                active promotions, customer history, inventory levels, and
                review sentiment — then create a realistic order from start to
                finish.
              </p>

              <div className="space-y-2">
                <label className="font-doodle text-sm font-bold text-doodle-text">
                  Customer Persona
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PERSONA_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      role="radio"
                      aria-checked={selectedPersona === opt.value}
                      data-persona={opt.value}
                      onClick={() => setSelectedPersona(opt.value)}
                      className={`text-left p-3 border-2 transition-colors ${
                        selectedPersona === opt.value
                          ? "border-doodle-accent bg-doodle-accent/10"
                          : "border-doodle-border hover:border-doodle-text/40"
                      }`}
                    >
                      <p className="font-doodle text-sm font-bold text-doodle-text">
                        {opt.label}
                      </p>
                      <p className="font-doodle text-xs text-doodle-text/60 mt-0.5">
                        {opt.description}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Existing Customer selector */}
              {selectedPersona === "existing-customer" && (
                <div className="space-y-2">
                  <label className="font-doodle text-sm font-bold text-doodle-text flex items-center gap-1.5">
                    <Users className="w-4 h-4" />
                    Select Customer
                  </label>
                  <p className="font-doodle text-xs text-doodle-text/60">
                    Top customers by total spend who have placed at least one
                    order. The AI will analyse their profile and order history.
                  </p>

                  {topSpendersLoading ? (
                    <div className="flex items-center gap-2 p-3 border-2 border-doodle-border">
                      <Loader2 className="w-4 h-4 animate-spin text-doodle-accent" />
                      <span className="font-doodle text-sm text-doodle-text/60">
                        Loading top customers…
                      </span>
                    </div>
                  ) : (
                    <div className="relative">
                      {/* Selected customer display / trigger */}
                      <button
                        type="button"
                        onClick={() => setCustomerDropdownOpen((v) => !v)}
                        className="w-full flex items-center justify-between p-3 border-2 border-doodle-text bg-white text-left hover:border-doodle-accent transition-colors"
                      >
                        {selectedCustomer ? (
                          <span className="font-doodle text-sm text-doodle-text">
                            <span className="font-bold">
                              {selectedCustomer.firstName}{" "}
                              {selectedCustomer.lastName}
                            </span>
                            <span className="text-doodle-text/50 ml-2">
                              {selectedCustomer.orderCount} orders · $
                              {selectedCustomer.totalSpend.toLocaleString(
                                "en-US",
                                {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                },
                              )}{" "}
                              total
                            </span>
                          </span>
                        ) : (
                          <span className="font-doodle text-sm text-doodle-text/50">
                            — choose a customer —
                          </span>
                        )}
                        <ChevronDown className="w-4 h-4 text-doodle-text/50 shrink-0" />
                      </button>

                      {/* Dropdown */}
                      {customerDropdownOpen && (
                        <div className="absolute z-10 w-full border-2 border-doodle-text bg-white shadow-doodle max-h-64 overflow-hidden flex flex-col">
                          <div className="p-2 border-b border-doodle-border">
                            <input
                              type="text"
                              placeholder="Search by name or email…"
                              value={customerSearchQuery}
                              onChange={(e) =>
                                setCustomerSearchQuery(e.target.value)
                              }
                              className="w-full font-doodle text-sm border border-doodle-border p-1.5 focus:outline-none focus:border-doodle-accent"
                              autoFocus
                            />
                          </div>
                          <div className="overflow-y-auto flex-1">
                            {filteredCustomers.length === 0 ? (
                              <p className="font-doodle text-xs text-doodle-text/50 p-3 text-center">
                                No customers found
                              </p>
                            ) : (
                              filteredCustomers.slice(0, 50).map((c, idx) => (
                                <button
                                  key={c.customerID}
                                  type="button"
                                  onClick={() => {
                                    setSelectedCustomerId(c.customerID);
                                    setCustomerDropdownOpen(false);
                                    setCustomerSearchQuery("");
                                  }}
                                  className={`w-full text-left px-3 py-2 hover:bg-doodle-accent/10 transition-colors flex items-center justify-between gap-2 ${
                                    c.customerID === selectedCustomerId
                                      ? "bg-doodle-accent/10"
                                      : idx % 2 === 0
                                        ? "bg-white"
                                        : "bg-doodle-text/3"
                                  }`}
                                >
                                  <span className="font-doodle text-sm text-doodle-text font-bold truncate">
                                    {c.firstName} {c.lastName}
                                  </span>
                                  <span className="font-doodle text-xs text-doodle-text/50 shrink-0">
                                    {c.orderCount} orders · $
                                    {c.totalSpend.toLocaleString("en-US", {
                                      minimumFractionDigits: 0,
                                      maximumFractionDigits: 0,
                                    })}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedCustomer && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCustomerId(undefined);
                        setCustomerSearchQuery("");
                      }}
                      className="font-doodle text-xs text-doodle-text/50 hover:text-doodle-text underline"
                    >
                      Clear selection
                    </button>
                  )}
                </div>
              )}

              {selectedPersona === "custom" && (
                <div className="space-y-1">
                  <label className="font-doodle text-sm font-bold text-doodle-text">
                    Describe the Customer Scenario
                  </label>
                  <textarea
                    value={customPersona}
                    onChange={(e) => setCustomPersona(e.target.value)}
                    rows={3}
                    placeholder="e.g. A 40-year-old woman who recently started road cycling and already owns a basic bike. She's looking for high-performance clothing and is on a generous budget."
                    className="w-full font-doodle text-sm border-2 border-doodle-text bg-white p-2 focus:border-doodle-accent focus:outline-none resize-none"
                  />
                  <p className="font-doodle text-xs text-doodle-text/50">
                    Minimum 10 characters
                  </p>
                </div>
              )}

              <div className="bg-doodle-text/5 border border-doodle-border p-3 space-y-1">
                <p className="font-doodle text-xs font-bold text-doodle-text">
                  What the AI will do:
                </p>
                {(selectedPersona === "existing-customer"
                  ? [
                      "Load the selected customer's profile and order history",
                      "Determine their shopper type from purchase patterns",
                      "Browse the current product catalogue (in-stock only)",
                      "Check active promotions for applicable discounts",
                      "Verify stock levels before adding any item",
                      "Check review sentiment for products it's considering",
                      "Create the order and decrement inventory",
                      "Generate a PDF receipt",
                    ]
                  : [
                      "Browse the full product catalogue (in-stock only)",
                      "Check active promotions for applicable discounts",
                      "Find or create a fitting customer in the database",
                      "Verify stock levels before adding any item",
                      "Check review sentiment for products it's considering",
                      "Create the order and decrement inventory",
                      "Generate a PDF receipt",
                    ]
                ).map((step, i) => (
                  <p
                    key={i}
                    className="font-doodle text-xs text-doodle-text/70"
                  >
                    {i + 1}. {step}
                  </p>
                ))}
              </div>

              {/* ── Bulk Generate Orders ── */}
              <div className="border-2 border-doodle-border p-4 space-y-3 bg-doodle-text/3">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-doodle-accent" />
                  <p className="font-doodle text-sm font-bold text-doodle-text">
                    Bulk Generate Orders
                  </p>
                </div>
                <p className="font-doodle text-xs text-doodle-text/60">
                  Queue multiple orders in the background. Each order randomly
                  picks one of the available personas — for "Existing Customer",
                  a random qualifying customer is chosen automatically.
                </p>

                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <label className="font-doodle text-xs font-bold text-doodle-text">
                      Count:
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={bulkCount}
                      onChange={(e) =>
                        setBulkCount(
                          Math.max(
                            1,
                            Math.min(500, parseInt(e.target.value) || 1),
                          ),
                        )
                      }
                      className="w-20 font-doodle text-sm border-2 border-doodle-text p-1 text-center focus:border-doodle-accent focus:outline-none"
                    />
                    <span className="font-doodle text-xs text-doodle-text/50">
                      (1–500)
                    </span>
                  </div>

                  {bulkStep === "idle" && (
                    <button
                      onClick={handleBulkGenerate}
                      className="doodle-button flex items-center gap-1.5 text-sm"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Generate Orders
                    </button>
                  )}

                  {bulkStep === "queuing" && (
                    <div className="flex items-center gap-1.5 text-doodle-text/60 font-doodle text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Queuing jobs…
                    </div>
                  )}

                  {bulkStep === "queued" && bulkResult && (
                    <div className="flex items-center gap-1.5 text-green-700 font-doodle text-sm">
                      <CheckCircle className="w-4 h-4" />
                      {bulkResult.queued} orders queued!
                      <button
                        onClick={() => {
                          setBulkStep("idle");
                          setBulkResult(null);
                        }}
                        className="ml-2 text-xs text-doodle-text/50 hover:text-doodle-text underline"
                      >
                        Reset
                      </button>
                    </div>
                  )}
                </div>

                {bulkStep === "queued" && (
                  <p className="font-doodle text-xs text-doodle-text/50">
                    Orders are processed in the background by the AI job queue.
                    They will appear in the Orders list as they complete.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Running / Done / Refining step — log + results */}
          {(step === "running" || step === "done") && (
            <div className="space-y-4">
              {step === "done" && result?.success && (
                <div className="flex items-center justify-between gap-2 p-3 bg-green-50 dark:bg-green-900/20 border-2 border-green-200 dark:border-green-700">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
                    <span className="font-doodle text-sm font-bold text-green-700 dark:text-green-400">
                      Order #{result.salesOrderId} created successfully!
                    </span>
                  </div>
                  <Link
                    to={`/orders?orderId=${result.salesOrderId}`}
                    onClick={handleClose}
                    className="font-doodle text-xs text-doodle-accent hover:underline flex items-center gap-1 shrink-0"
                  >
                    View Order <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              )}

              {step === "done" && result && !result.success && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border-2 border-red-200">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
                  <span className="font-doodle text-sm font-bold text-red-700">
                    Generation failed — see log below
                  </span>
                </div>
              )}

              {/* Order Summary Card */}
              {step === "done" && result?.success && (
                <div className="border-2 border-doodle-border p-4 space-y-3">
                  <h3 className="font-doodle font-bold text-doodle-text flex items-center gap-2">
                    <ShoppingBag className="w-4 h-4" /> Order Summary
                  </h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-doodle text-sm">
                    <span className="text-doodle-text/60">Order ID</span>
                    <Link
                      to={`/orders?orderId=${result.salesOrderId}`}
                      onClick={handleClose}
                      className="font-bold text-doodle-accent hover:underline flex items-center gap-1"
                    >
                      #{result.salesOrderId}{" "}
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                    <span className="text-doodle-text/60">Customer</span>
                    <span>
                      {result.customerName}
                      {result.newCustomerCreated && (
                        <span className="ml-1 text-xs text-doodle-accent border border-doodle-accent px-1">
                          new
                        </span>
                      )}
                    </span>
                    {result.customerEmail && (
                      <>
                        <span className="text-doodle-text/60">Email</span>
                        <span className="truncate">{result.customerEmail}</span>
                      </>
                    )}
                    <span className="text-doodle-text/60">Total</span>
                    <span className="font-bold text-doodle-green">
                      ${(result.totalDue ?? 0).toFixed(2)}
                    </span>
                  </div>

                  {result.receiptPdfBase64 && (
                    <button
                      onClick={() => setShowReceipt((v) => !v)}
                      className="doodle-button-secondary text-xs flex items-center gap-1"
                    >
                      <FileText className="w-3 h-3" />
                      {showReceipt ? "Hide Receipt" : "Preview Receipt PDF"}
                    </button>
                  )}

                  {showReceipt && result.receiptPdfBase64 && (
                    <div className="border border-doodle-border mt-2">
                      <iframe
                        src={`data:application/pdf;base64,${result.receiptPdfBase64}`}
                        className="w-full"
                        style={{ height: "500px" }}
                        title="Order Receipt"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Log */}
              <div>
                <p className="font-doodle text-xs font-bold text-doodle-text mb-1">
                  AI Activity Log
                </p>
                <div className="bg-doodle-text/5 border border-doodle-border p-3 font-mono text-xs space-y-0.5 max-h-64 overflow-y-auto">
                  {log.map((entry, idx) => (
                    <p
                      key={idx}
                      className={
                        entry.type === "success"
                          ? "text-green-600 dark:text-green-400"
                          : entry.type === "error"
                            ? "text-red-600 dark:text-red-400"
                            : entry.type === "dim"
                              ? "text-doodle-text/40"
                              : "text-doodle-text/80"
                      }
                    >
                      {entry.message}
                    </p>
                  ))}
                  {step === "running" && (
                    <p className="flex items-center gap-1 text-doodle-blue">
                      <Loader2 className="w-3 h-3 animate-spin inline" /> AI
                      thinking…
                    </p>
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            </div>
          )}

          {step === "refining" && (
            <div className="space-y-4">
              <p className="font-doodle text-sm text-doodle-text/70">
                Describe the changes you&apos;d like the AI to make to the
                generated order. The agent will use your feedback and the
                existing conversation context to produce a revised order.
              </p>
              <div>
                <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                  Refinement instructions
                </label>
                <textarea
                  value={refineMessage}
                  onChange={(e) => setRefineMessage(e.target.value)}
                  rows={4}
                  placeholder="e.g. Change the customer to a family buyer, add helmets for two children, and use the current seasonal discount"
                  className="w-full font-doodle text-sm border-2 border-doodle-text bg-white p-2 focus:border-doodle-accent focus:outline-none resize-none"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t-2 border-doodle-border flex-shrink-0 gap-3">
          {step === "configure" && (
            <>
              <button
                onClick={handleClose}
                className="doodle-button-secondary text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={!canStart}
                className="doodle-button flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-4 h-4" />
                Generate Order
                <ChevronRight className="w-4 h-4" />
              </button>
            </>
          )}

          {step === "running" && (
            <div className="flex items-center gap-2 text-doodle-text/60 font-doodle text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              AI is working — this may take up to a minute…
            </div>
          )}

          {step === "done" && (
            <div className="flex items-center justify-between w-full gap-3">
              <button
                onClick={() => {
                  setStep("configure");
                  setLog([]);
                  setResult(null);
                  setRefineMessage("");
                  setShowReceipt(false);
                  setBulkStep("idle");
                  setBulkResult(null);
                }}
                className="doodle-button doodle-button-primary flex items-center gap-1.5 text-sm"
              >
                <Sparkles className="w-4 h-4" />
                Generate Another
              </button>
              {result?.success && result?.threadId && (
                <button
                  onClick={() => setStep("refining")}
                  className="doodle-button flex items-center gap-1.5 text-sm"
                >
                  <Sparkles className="w-4 h-4" />
                  Refine
                </button>
              )}
              <button
                onClick={handleClose}
                className="doodle-button-secondary text-sm"
              >
                Close
              </button>
            </div>
          )}

          {step === "refining" && (
            <div className="flex items-center justify-between w-full gap-3">
              <button
                onClick={() => setStep("done")}
                className="doodle-button-secondary text-sm"
              >
                &lt; Back
              </button>
              <button
                onClick={handleRefine}
                disabled={!refineMessage.trim()}
                className="doodle-button doodle-button-primary flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-4 h-4" />
                Re-generate Order
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default GenerateOrdersWizardDialog;
