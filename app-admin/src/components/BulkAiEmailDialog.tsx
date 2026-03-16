import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Customer } from "@/types/customer";
import { Order } from "@/types/order";
import { useAdminOrders } from "@/hooks/useAdminOrders";
import { useAdminShoppingCarts } from "@/hooks/useAdminCatalog";
import { StaleCart } from "@/types/shoppingCart";
import { toast } from "sonner";
import {
  Mail,
  Sparkles,
  ShoppingCart,
  Package,
  Heart,
  Gift,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Send,
  Eye,
  Users,
  Wand2,
} from "lucide-react";

type EmailTemplate =
  | "stale_cart"
  | "recent_order_thanks"
  | "re_engagement"
  | "vip_appreciation"
  | "product_recommendation"
  | "feedback_request";

interface TemplateConfig {
  id: EmailTemplate;
  name: string;
  icon: React.ReactNode;
  description: string;
  color: string;
}

const EMAIL_TEMPLATES: TemplateConfig[] = [
  {
    id: "stale_cart",
    name: "Abandoned Cart Recovery",
    icon: <ShoppingCart className="w-4 h-4" />,
    description: "Remind customers about items left in their cart",
    color: "text-amber-600",
  },
  {
    id: "recent_order_thanks",
    name: "Order Thank You",
    icon: <Package className="w-4 h-4" />,
    description: "Thank customers for recent purchases",
    color: "text-green-600",
  },
  {
    id: "re_engagement",
    name: "Re-engagement Campaign",
    icon: <RefreshCw className="w-4 h-4" />,
    description: "Win back inactive customers",
    color: "text-blue-600",
  },
  {
    id: "vip_appreciation",
    name: "VIP Appreciation",
    icon: <Heart className="w-4 h-4" />,
    description: "Special offers for top spenders",
    color: "text-pink-600",
  },
  {
    id: "product_recommendation",
    name: "Product Recommendations",
    icon: <Gift className="w-4 h-4" />,
    description: "AI-curated product suggestions",
    color: "text-purple-600",
  },
  {
    id: "feedback_request",
    name: "Feedback Request",
    icon: <Mail className="w-4 h-4" />,
    description: "Request reviews and feedback",
    color: "text-indigo-600",
  },
];

interface EmailStatus {
  customerId: number;
  status: "pending" | "generating" | "sending" | "success" | "failed";
  subject?: string;
  preview?: string;
  error?: string;
}

interface BulkAiEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCustomers: Customer[];
  onComplete: () => void;
}

// AI content generation using live order/cart data
const generateMockAIContent = async (
  template: EmailTemplate,
  customer: Customer,
  orders: Order[],
  staleCarts: StaleCart[],
): Promise<{ subject: string; body: string }> => {
  // Simulate AI generation delay
  await new Promise((resolve) =>
    setTimeout(resolve, 800 + Math.random() * 600),
  );

  const firstName = customer.FirstName;
  const lastOrder = orders.find((o) => o.CustomerID === customer.CustomerID);
  const staleCart = staleCarts.find(
    (c) =>
      c.customerEmail.toLowerCase() === customer.EmailAddress.toLowerCase(),
  );

  const templates: Record<EmailTemplate, { subject: string; body: string }> = {
    stale_cart: {
      subject: `${firstName}, your cart misses you! 🛒`,
      body: staleCart
        ? `Hi ${firstName},\n\nWe noticed you left ${staleCart.totalItems} item(s) worth $${staleCart.totalValue.toFixed(2)} in your cart. Don't let them get away!\n\nComplete your purchase now and enjoy free shipping on orders over $50.\n\nBest,\nAdventureWorks Team`
        : `Hi ${firstName},\n\nWe noticed you've been browsing our collection recently. Ready to make that purchase?\n\nShop now and enjoy exclusive member pricing.\n\nBest,\nAdventureWorks Team`,
    },
    recent_order_thanks: {
      subject: `Thank you for your order, ${firstName}! 🎉`,
      body: lastOrder
        ? `Dear ${firstName},\n\nThank you for your recent order #${lastOrder.SalesOrderID}! We're thrilled to have you as a customer.\n\nYour order of $${lastOrder.TotalDue.toFixed(2)} is ${lastOrder.Status === "Delivered" ? "delivered" : "on its way"}.\n\nAs a token of our appreciation, here's 10% off your next purchase: THANKS10\n\nWarm regards,\nAdventureWorks Team`
        : `Dear ${firstName},\n\nThank you for being a valued AdventureWorks customer!\n\nWe appreciate your business and look forward to serving you again soon.\n\nBest,\nAdventureWorks Team`,
    },
    re_engagement: {
      subject: `We miss you, ${firstName}! Come back for 20% off 💙`,
      body: `Hi ${firstName},\n\nIt's been a while since we've seen you at AdventureWorks, and we miss you!\n\nAs a valued customer with ${customer.TotalOrders} previous orders, we'd love to welcome you back with an exclusive 20% discount.\n\nUse code: WELCOME20 at checkout.\n\nHope to see you soon!\nAdventureWorks Team`,
    },
    vip_appreciation: {
      subject: `${firstName}, you're a VIP! Exclusive perks inside 👑`,
      body: `Dear ${firstName},\n\nAs one of our most valued customers with $${customer.TotalSpent.toFixed(2)} in lifetime purchases, we want to say THANK YOU!\n\nYou've unlocked VIP status with these exclusive benefits:\n• Early access to new arrivals\n• Free express shipping on all orders\n• Dedicated customer support line\n• Special VIP-only promotions\n\nYour loyalty means everything to us.\n\nWith gratitude,\nAdventureWorks VIP Team`,
    },
    product_recommendation: {
      subject: `${firstName}, we picked these just for you! ✨`,
      body: `Hi ${firstName},\n\nBased on your interests and purchase history, our AI has curated a special selection just for you!\n\n🚴 Top Picks This Week:\n• Premium Mountain Bike Series - 15% off\n• All-Weather Cycling Gear - New arrivals\n• Exclusive Accessories Bundle - Limited stock\n\nThese items are flying off our shelves, so don't wait!\n\nHappy shopping,\nAdventureWorks Team`,
    },
    feedback_request: {
      subject: `${firstName}, we'd love your feedback! ⭐`,
      body: lastOrder
        ? `Hi ${firstName},\n\nWe hope you're enjoying your recent purchase from order #${lastOrder.SalesOrderID}!\n\nYour feedback helps us improve and helps other adventurers make great choices. Would you take 2 minutes to share your experience?\n\n[Leave a Review] - Click here\n\nAs a thank you, you'll receive 100 reward points!\n\nBest,\nAdventureWorks Team`
        : `Hi ${firstName},\n\nWe value your opinion as a long-time customer!\n\nWould you take a moment to share your AdventureWorks experience? Your feedback helps us serve you better.\n\nThank you for being part of our community!\n\nAdventureWorks Team`,
    },
  };

  return templates[template];
};

const BulkAiEmailDialog: React.FC<BulkAiEmailDialogProps> = ({
  open,
  onOpenChange,
  selectedCustomers,
  onComplete,
}) => {
  const { data: allOrders = [] } = useAdminOrders();
  const { data: allCarts = [] } = useAdminShoppingCarts();

  const [selectedTemplate, setSelectedTemplate] =
    useState<EmailTemplate>("stale_cart");
  const [emailStatuses, setEmailStatuses] = useState<EmailStatus[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [previewCustomerId, setPreviewCustomerId] = useState<number | null>(
    null,
  );
  const [generatedEmails, setGeneratedEmails] = useState<
    Map<number, { subject: string; body: string }>
  >(new Map());

  useEffect(() => {
    if (open) {
      setEmailStatuses(
        selectedCustomers.map((c) => ({
          customerId: c.CustomerID,
          status: "pending",
        })),
      );
      setGeneratedEmails(new Map());
      setPreviewCustomerId(null);
      setIsGenerating(false);
      setIsSending(false);
    }
  }, [open, selectedCustomers]);

  const handleGenerateAll = async () => {
    setIsGenerating(true);
    const newEmails = new Map<number, { subject: string; body: string }>();

    for (const customer of selectedCustomers) {
      setEmailStatuses((prev) =>
        prev.map((s) =>
          s.customerId === customer.CustomerID
            ? { ...s, status: "generating" }
            : s,
        ),
      );

      try {
        const content = await generateMockAIContent(
          selectedTemplate,
          customer,
          allOrders,
          allCarts,
        );
        newEmails.set(customer.CustomerID, content);

        setEmailStatuses((prev) =>
          prev.map((s) =>
            s.customerId === customer.CustomerID
              ? {
                  ...s,
                  status: "pending",
                  subject: content.subject,
                  preview: content.body.substring(0, 80) + "...",
                }
              : s,
          ),
        );
      } catch (error) {
        setEmailStatuses((prev) =>
          prev.map((s) =>
            s.customerId === customer.CustomerID
              ? { ...s, status: "failed", error: "Generation failed" }
              : s,
          ),
        );
      }
    }

    setGeneratedEmails(newEmails);
    setIsGenerating(false);
    toast.success(`Generated ${newEmails.size} personalized emails`);
  };

  const handleSendAll = async () => {
    if (generatedEmails.size === 0) {
      toast.error("Please generate emails first");
      return;
    }

    setIsSending(true);
    let successCount = 0;
    let failCount = 0;

    for (const customer of selectedCustomers) {
      if (!generatedEmails.has(customer.CustomerID)) continue;

      setEmailStatuses((prev) =>
        prev.map((s) =>
          s.customerId === customer.CustomerID
            ? { ...s, status: "sending" }
            : s,
        ),
      );

      // Simulate sending delay
      await new Promise((resolve) =>
        setTimeout(resolve, 300 + Math.random() * 400),
      );

      // 5% simulated failure rate
      const success = Math.random() > 0.05;

      if (success) {
        successCount++;
        setEmailStatuses((prev) =>
          prev.map((s) =>
            s.customerId === customer.CustomerID
              ? { ...s, status: "success" }
              : s,
          ),
        );
      } else {
        failCount++;
        setEmailStatuses((prev) =>
          prev.map((s) =>
            s.customerId === customer.CustomerID
              ? { ...s, status: "failed", error: "Send failed" }
              : s,
          ),
        );
      }
    }

    setIsSending(false);
    toast.success(
      `Sent ${successCount} emails${failCount > 0 ? `, ${failCount} failed` : ""}`,
    );
  };

  const selectedTemplateConfig = EMAIL_TEMPLATES.find(
    (t) => t.id === selectedTemplate,
  )!;
  const allGenerated = generatedEmails.size === selectedCustomers.length;
  const allSent = emailStatuses.every(
    (s) => s.status === "success" || s.status === "failed",
  );
  const successCount = emailStatuses.filter(
    (s) => s.status === "success",
  ).length;
  const failCount = emailStatuses.filter((s) => s.status === "failed").length;

  const previewEmail = previewCustomerId
    ? generatedEmails.get(previewCustomerId)
    : null;
  const previewCustomer = previewCustomerId
    ? selectedCustomers.find((c) => c.CustomerID === previewCustomerId)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-doodle text-xl flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-doodle-accent" />
            AI Bulk Email Campaign
          </DialogTitle>
          <DialogDescription className="font-doodle">
            Generate and send personalized AI emails to{" "}
            {selectedCustomers.length} selected customer
            {selectedCustomers.length !== 1 ? "s" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-4">
          {/* Template Selection */}
          <div>
            <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
              Email Template
            </label>
            <Select
              value={selectedTemplate}
              onValueChange={(v) => setSelectedTemplate(v as EmailTemplate)}
              disabled={isGenerating || isSending}
            >
              <SelectTrigger className="w-full font-doodle">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMAIL_TEMPLATES.map((template) => (
                  <SelectItem
                    key={template.id}
                    value={template.id}
                    className="font-doodle"
                  >
                    <div className="flex items-center gap-2">
                      <span className={template.color}>{template.icon}</span>
                      <span>{template.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="font-doodle text-xs text-doodle-text/60 mt-1 flex items-center gap-1">
              <span className={selectedTemplateConfig.color}>
                {selectedTemplateConfig.icon}
              </span>
              {selectedTemplateConfig.description}
            </p>
          </div>

          {/* Generate Button */}
          {!allGenerated && (
            <button
              onClick={handleGenerateAll}
              disabled={isGenerating || isSending}
              className="w-full doodle-button doodle-button-primary flex items-center justify-center gap-2 py-3"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating AI Content...
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4" />
                  Generate {selectedCustomers.length} Personalized Emails
                </>
              )}
            </button>
          )}

          {/* Email Preview Panel */}
          {previewEmail && previewCustomer && (
            <div className="border-2 border-doodle-accent bg-doodle-accent/5 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-doodle font-bold text-doodle-text flex items-center gap-2">
                  <Eye className="w-4 h-4" />
                  Preview: {previewCustomer.FirstName}{" "}
                  {previewCustomer.LastName}
                </h4>
                <button
                  onClick={() => setPreviewCustomerId(null)}
                  className="font-doodle text-sm text-doodle-text/60 hover:text-doodle-text"
                >
                  Close
                </button>
              </div>
              <div className="space-y-2">
                <div>
                  <span className="font-doodle text-xs text-doodle-text/60">
                    To:{" "}
                  </span>
                  <span className="font-doodle text-sm">
                    {previewCustomer.EmailAddress}
                  </span>
                </div>
                <div>
                  <span className="font-doodle text-xs text-doodle-text/60">
                    Subject:{" "}
                  </span>
                  <span className="font-doodle text-sm font-bold">
                    {previewEmail.subject}
                  </span>
                </div>
                <div className="border-t border-doodle-text/20 pt-2 mt-2">
                  <pre className="font-doodle text-sm whitespace-pre-wrap text-doodle-text/80">
                    {previewEmail.body}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {/* Recipients List */}
          <div>
            <h4 className="font-doodle font-bold text-doodle-text mb-2 flex items-center gap-2">
              <Users className="w-4 h-4" />
              Recipients ({selectedCustomers.length})
            </h4>
            <div className="border-2 border-doodle-text/20 max-h-64 overflow-y-auto">
              {emailStatuses.map((status) => {
                const customer = selectedCustomers.find(
                  (c) => c.CustomerID === status.customerId,
                );
                if (!customer) return null;

                return (
                  <div
                    key={status.customerId}
                    className={`p-3 border-b border-doodle-text/10 last:border-b-0 flex items-center justify-between gap-4 ${
                      status.status === "success"
                        ? "bg-green-50"
                        : status.status === "failed"
                          ? "bg-red-50"
                          : ""
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-doodle font-bold text-sm text-doodle-text truncate">
                        {customer.FirstName} {customer.LastName}
                      </p>
                      <p className="font-doodle text-xs text-doodle-text/60 truncate">
                        {customer.EmailAddress}
                      </p>
                      {status.subject && (
                        <p className="font-doodle text-xs text-doodle-text/80 mt-1 truncate">
                          📧 {status.subject}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {status.status === "pending" && status.subject && (
                        <button
                          onClick={() =>
                            setPreviewCustomerId(status.customerId)
                          }
                          className="font-doodle text-xs text-doodle-accent hover:underline flex items-center gap-1"
                        >
                          <Eye className="w-3 h-3" /> Preview
                        </button>
                      )}
                      {status.status === "generating" && (
                        <span className="flex items-center gap-1 text-amber-600">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="font-doodle text-xs">
                            Generating...
                          </span>
                        </span>
                      )}
                      {status.status === "sending" && (
                        <span className="flex items-center gap-1 text-blue-600">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="font-doodle text-xs">
                            Sending...
                          </span>
                        </span>
                      )}
                      {status.status === "success" && (
                        <span className="flex items-center gap-1 text-green-600">
                          <CheckCircle className="w-4 h-4" />
                          <span className="font-doodle text-xs">Sent</span>
                        </span>
                      )}
                      {status.status === "failed" && (
                        <span className="flex items-center gap-1 text-red-600">
                          <XCircle className="w-4 h-4" />
                          <span className="font-doodle text-xs">
                            {status.error}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Progress Summary */}
          {(allGenerated || allSent) && (
            <div className="bg-doodle-text/5 p-4 border-2 border-doodle-text/20">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-doodle font-bold text-doodle-text">
                    {allSent ? "Campaign Complete!" : "Ready to Send"}
                  </p>
                  <p className="font-doodle text-sm text-doodle-text/60">
                    {allSent
                      ? `${successCount} sent successfully${failCount > 0 ? `, ${failCount} failed` : ""}`
                      : `${generatedEmails.size} personalized emails ready`}
                  </p>
                </div>
                {allSent ? (
                  <CheckCircle className="w-8 h-8 text-green-600" />
                ) : (
                  <Sparkles className="w-8 h-8 text-doodle-accent" />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-doodle-text/20">
          <button
            onClick={() => {
              onOpenChange(false);
              if (allSent) onComplete();
            }}
            className="px-4 py-2 font-doodle border-2 border-doodle-text hover:bg-doodle-text/10"
          >
            {allSent ? "Done" : "Cancel"}
          </button>
          {allGenerated && !allSent && (
            <button
              onClick={handleSendAll}
              disabled={isSending}
              className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
            >
              {isSending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Send All Emails
                </>
              )}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BulkAiEmailDialog;
