import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { getRestApiUrl } from "@/lib/utils";

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

const GET_PERSON_CREDIT_CARDS = gql`
  query GetPersonCreditCards($businessEntityId: Int!) {
    personCreditCards(filter: { BusinessEntityID: { eq: $businessEntityId } }) {
      items {
        BusinessEntityID
        CreditCardID
      }
    }
  }
`;

const GET_CREDIT_CARDS = gql`
  query GetCreditCards($cardIds: [Int!]) {
    creditCards(filter: { CreditCardID: { in: $cardIds } }) {
      items {
        CreditCardID
        CardType
        CardNumber
        ExpMonth
        ExpYear
      }
    }
  }
`;

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
    []
  );
  const [isLoading, setIsLoading] = useState(false);

  const fetchPaymentMethods = useCallback(async () => {
    if (!user?.businessEntityId) return;

    setIsLoading(true);
    try {
      // Get PersonCreditCard links
      const personCardsResponse: any = await graphqlClient.request(
        GET_PERSON_CREDIT_CARDS,
        { businessEntityId: user.businessEntityId }
      );

      const personCards = personCardsResponse.personCreditCards?.items || [];

      if (personCards.length === 0) {
        setPaymentMethods([]);
        return;
      }

      // Get CreditCard details
      const cardIds = personCards.map((pc: any) => pc.CreditCardID);
      const cardsResponse: any = await graphqlClient.request(GET_CREDIT_CARDS, {
        cardIds,
      });

      const cards = cardsResponse.creditCards?.items || [];

      // Transform to SavedPaymentMethod format
      const methods: SavedPaymentMethod[] = cards.map(
        (card: any, index: number) => ({
          id: card.CreditCardID.toString(),
          type: "card" as const,
          label: `${getCardBrand(card.CardType)} •••• ${card.CardNumber.slice(
            -4
          )}`,
          cardLast4: card.CardNumber.slice(-4),
          cardBrand: getCardBrand(card.CardType),
          cardExpiry: `${String(card.ExpMonth).padStart(2, "0")}/${
            card.ExpYear
          }`,
          isDefault: index === 0, // First card is default for now
        })
      );

      setPaymentMethods(methods);
    } catch (error) {
      console.error(
        "[usePaymentMethods] Error fetching payment methods:",
        error
      );
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
      console.log(
        "[usePaymentMethods] Add payment method not yet implemented via API",
        method
      );
    },
    [user?.businessEntityId]
  );

  const removePaymentMethod = useCallback(
    async (methodId: string) => {
      if (!user?.businessEntityId) return;

      try {
        const creditCardId = parseInt(methodId, 10);

        // Delete the PersonCreditCard link via REST API
        const restUrl = getRestApiUrl();
        const response = await fetch(
          `${restUrl}/PersonCreditCard/BusinessEntityID/${user.businessEntityId}/CreditCardID/${creditCardId}`,
          {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to delete payment method: ${errorText}`);
        }

        console.log("[usePaymentMethods] Payment method removed successfully");

        // Refetch to update the list
        await fetchPaymentMethods();
      } catch (error) {
        console.error(
          "[usePaymentMethods] Error removing payment method:",
          error
        );
        throw error;
      }
    },
    [user?.businessEntityId, fetchPaymentMethods]
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
