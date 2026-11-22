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

// Demo storefront: only well-known public test card numbers may be saved. The full number is
// checked in the browser and discarded; the API receives only brand, last four digits and expiry.
export const TEST_CARD_NUMBERS: ReadonlySet<string> = new Set([
  "4242424242424242",
  "4111111111111111",
  "4000056655665556",
  "4012888888881881",
  "5555555555554444",
  "5105105105105100",
  "2223003122003222",
  "378282246310005",
  "371449635398431",
  "6011111111111117",
  "6011000990139424",
]);

export const isLuhnValid = (digits: string): boolean => {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
};

// Maps a card number prefix to the AdventureWorks Sales.CreditCard.CardType values.
export const detectCardType = (digits: string): string | null => {
  if (/^4/.test(digits)) return "Vista";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "SuperiorCard";
  if (/^3[47]/.test(digits)) return "ColonialVoice";
  if (/^6(011|5)/.test(digits)) return "Distinguish";
  return null;
};

export interface SaveCardPayload {
  cardType: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

// `reason?: undefined` keeps `result.reason` readable after `if (result.ok)`; the app
// compiles without strictNullChecks, which disables boolean-literal narrowing.
export type SaveCardResult =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: "invalid-card" | "not-test-card" | "expired" | "request-failed" };

export const toSaveCardPayload = (
  cardNumber: string,
  cardExpiry: string,
  now: Date = new Date(),
): SaveCardPayload | Exclude<SaveCardResult, { ok: true }> => {
  const digits = cardNumber.replace(/[\s-]/g, "");
  const cardType = detectCardType(digits);
  if (!isLuhnValid(digits) || !cardType) return { ok: false, reason: "invalid-card" };
  if (!TEST_CARD_NUMBERS.has(digits)) return { ok: false, reason: "not-test-card" };
  const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(cardExpiry.trim());
  if (!match) return { ok: false, reason: "expired" };
  const expMonth = Number(match[1]);
  const expYear = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  const currentMonth = now.getFullYear() * 12 + now.getMonth() + 1;
  if (expMonth < 1 || expMonth > 12 || expYear * 12 + expMonth < currentMonth) {
    return { ok: false, reason: "expired" };
  }
  return { cardType, last4: digits.slice(-4), expMonth, expYear };
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

  // Resolves (never rejects) so fire-and-forget callers cannot leak unhandled rejections.
  const addPaymentMethod = useCallback(
    async (method: {
      type: "card" | "paypal";
      label?: string;
      cardNumber?: string;
      cardExpiry?: string;
      cardholderName?: string;
      paypalEmail?: string;
      isDefault?: boolean;
    }): Promise<SaveCardResult> => {
      if (!user?.businessEntityId || method.type !== "card") {
        return { ok: false, reason: "request-failed" };
      }

      const payload = toSaveCardPayload(method.cardNumber ?? "", method.cardExpiry ?? "");
      if ("ok" in payload) return payload;

      try {
        const response = await functionsFetch(`${getFunctionsApiUrl()}/api/payment-methods`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`Failed to save payment method (HTTP ${response.status}).`);
        }
        await fetchPaymentMethods();
        return { ok: true };
      } catch (error) {
        trackError("Error saving payment method", error as Error, {
          hook: "usePaymentMethods",
          context: "addPaymentMethod",
          businessEntityId: user?.businessEntityId,
        });
        return { ok: false, reason: "request-failed" };
      }
    },
    [user?.businessEntityId, fetchPaymentMethods],
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
