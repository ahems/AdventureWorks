import React from "react";
import { CreditCard, Trash2, Loader2 } from "lucide-react";
import { useAdminPaymentMethods } from "@/hooks/useAdminPaymentMethods";
import { toast } from "sonner";

interface AdminPaymentMethodsPanelProps {
  businessEntityId: number;
}

const CARD_BRAND_COLORS: Record<string, string> = {
  Visa: "bg-blue-600",
  Mastercard: "bg-orange-500",
  Amex: "bg-green-600",
  Discover: "bg-amber-500",
};

export const AdminPaymentMethodsPanel: React.FC<
  AdminPaymentMethodsPanelProps
> = ({ businessEntityId }) => {
  const { paymentMethods, isLoading, removePaymentMethod } =
    useAdminPaymentMethods(businessEntityId);

  const handleRemove = async (id: string, cardLast4: string) => {
    if (!confirm(`Remove card ending in ${cardLast4}?`)) return;
    try {
      await removePaymentMethod(id);
      toast.success(`Card ending in ${cardLast4} removed`);
    } catch {
      toast.error("Failed to remove payment method");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading payment methods…
      </div>
    );
  }

  if (paymentMethods.length === 0) {
    return (
      <div className="flex items-center gap-3 py-4 text-sm text-gray-400">
        <CreditCard className="w-5 h-5" />
        No saved payment methods on file.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {paymentMethods.map((pm) => {
        const brandColor = CARD_BRAND_COLORS[pm.cardBrand] ?? "bg-gray-500";
        return (
          <div
            key={pm.id}
            className="flex items-center gap-4 p-3 bg-white border-2 border-doodle-text/10"
          >
            <CreditCard className="w-6 h-6 text-gray-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`${brandColor} text-white text-xs font-bold px-1.5 py-0.5 rounded`}
                >
                  {pm.cardBrand}
                </span>
                <span className="font-medium text-sm text-gray-800">
                  •••• •••• •••• {pm.cardLast4}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                Expires {pm.cardExpiry}
              </p>
            </div>
            <button
              onClick={() => handleRemove(pm.id, pm.cardLast4)}
              className="p-1.5 text-gray-400 hover:text-red-500 transition-colors shrink-0"
              title="Remove card"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        );
      })}
      <p className="text-xs text-gray-400 pt-1">
        Card numbers are masked for security. Only the last 4 digits are shown.
      </p>
    </div>
  );
};
