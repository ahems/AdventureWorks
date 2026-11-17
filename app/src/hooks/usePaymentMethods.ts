import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { z } from "zod";
import { getFunctionsApiUrl, getRestApiUrl } from "@/lib/utils";
import { dabFetch } from "@/lib/dabFetch";
import { functionsFetch } from "@/services/functionsAuth";
import { trackError } from "@/lib/appInsights";

export interface SavedPaymentMethod {
  id: string;
  type: "card" | "paypal";
  label: string;
  // For cards - only store masked info for security
  cardLast4?: string;
  cardBrand?: string;
  cardExpiry?: string;
  cardholderName?: string;
  // For PayPal
  paypalEmail?: string;
  isDefault: boolean;
}

const paymentCardsSchema = z.array(z.object({
  id: z.number().int().positive(),
  cardType: z.string(),
  last4: z.string().max(4),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().positive(),
}).strict());

// Detect card brand from card type
const getCardBrand = (cardType: string): string => {
  if (cardType === "Vista") return "Visa";
  if (cardType === "SuperiorCard") return "Mastercard";
  if (cardType === "Distinguish") return "Discover";
  if (cardType === "ColonialVoice") return "Amex";
  return cardType;
};

export const usePaymentMethods = () => {
  const { user } = useAuth();
  const [paymentMethods, setPaymentMethods] = useState<SavedPaymentMethod[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(false);

  const fetchPaymentMethods = useCallback(async () => {
    if (!user?.businessEntityId) return;

    setIsLoading(true);
    try {
      const response = await functionsFetch(`${getFunctionsApiUrl()}/api/payment-methods`);
      if (!response.ok) {
        throw new Error(`Failed to load payment methods (HTTP ${response.status}).`);
      }
      const cards = paymentCardsSchema.parse(await response.json());

      // Transform to SavedPaymentMethod format
      const methods: SavedPaymentMethod[] = cards.map((card, index) => ({
        id: card.id.toString(),
        type: "card" as const,
        label: `${getCardBrand(card.cardType)} •••• ${card.last4}`,
        cardLast4: card.last4,
        cardBrand: getCardBrand(card.cardType),
        cardExpiry: `${String(card.expMonth).padStart(2, "0")}/${card.expYear}`,
        isDefault: index === 0, // First card is default for now
      }));

      setPaymentMethods(methods);
    } catch (error) {
      trackError("Error fetching payment methods", error as Error, {
        hook: "usePaymentMethods",
        context: "fetchPaymentMethods",
        businessEntityId: user?.businessEntityId,
      });
      setPaymentMethods([]);
    } finally {
      setIsLoading(false);
    }
  }, [user?.businessEntityId]);

  useEffect(() => {
    fetchPaymentMethods();
  }, [fetchPaymentMethods]);

  const addPaymentMethod = useCallback(
    (method: {
      type: "card" | "paypal";
      label?: string;
      cardNumber?: string;
      cardExpiry?: string;
      cardholderName?: string;
      paypalEmail?: string;
      isDefault?: boolean;
    }) => {
      if (!user?.businessEntityId) return;

      // TODO: Implement API call to create credit card and link to person
    },
    [user?.businessEntityId],
  );

  const removePaymentMethod = useCallback(
    async (methodId: string) => {
      if (!user?.businessEntityId) return;

      try {
        const creditCardId = parseInt(methodId, 10);

        // Delete the PersonCreditCard link via REST API
        const restUrl = getRestApiUrl();
        const response = await dabFetch(
          `${restUrl}/PersonCreditCard/BusinessEntityID/${user.businessEntityId}/CreditCardID/${creditCardId}`,
          {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to delete payment method: ${errorText}`);
        }

        // Refetch to update the list
        await fetchPaymentMethods();
      } catch (error) {
        trackError("Error removing payment method", error as Error, {
          hook: "usePaymentMethods",
          context: "removePaymentMethod",
          methodId,
          businessEntityId: user?.businessEntityId,
        });
        throw error;
      }
    },
    [user?.businessEntityId, fetchPaymentMethods],
  );

  const getDefaultPaymentMethod = useCallback(() => {
    return paymentMethods.find((m) => m.isDefault) || paymentMethods[0] || null;
  }, [paymentMethods]);

  return {
    paymentMethods,
    isLoading,
    addPaymentMethod,
    removePaymentMethod,
    getDefaultPaymentMethod,
    refetch: fetchPaymentMethods,
  };
};
