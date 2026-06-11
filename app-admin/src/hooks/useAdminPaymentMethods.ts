import { useState, useEffect, useCallback } from "react";
import { graphqlClient } from "@/lib/graphql-client";
import { getRestApiUrl } from "@/lib/utils";
import { gql } from "graphql-request";

export interface AdminPaymentMethod {
  id: string;
  cardLast4: string;
  cardBrand: string;
  cardExpiry: string;
}

interface PersonCreditCard {
  BusinessEntityID: number;
  CreditCardID: number;
}

interface CreditCard {
  CreditCardID: number;
  CardType: string;
  CardNumber: string;
  ExpMonth: number;
  ExpYear: number;
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

const getCardBrand = (cardType: string): string => {
  const map: Record<string, string> = {
    Vista: "Visa",
    SuperiorCard: "Mastercard",
    Distinguish: "Discover",
    ColonialVoice: "Amex",
  };
  return map[cardType] ?? cardType;
};

export const useAdminPaymentMethods = (businessEntityId: number | null) => {
  const [paymentMethods, setPaymentMethods] = useState<AdminPaymentMethod[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(false);

  const fetchPaymentMethods = useCallback(async () => {
    if (!businessEntityId) return;

    setIsLoading(true);
    try {
      const personCardsResponse = await graphqlClient.request<{
        personCreditCards: { items: PersonCreditCard[] };
      }>(GET_PERSON_CREDIT_CARDS, { businessEntityId });

      const personCards = personCardsResponse.personCreditCards?.items ?? [];
      if (personCards.length === 0) {
        setPaymentMethods([]);
        return;
      }

      const cardIds = personCards.map((pc) => pc.CreditCardID);
      const cardsResponse = await graphqlClient.request<{
        creditCards: { items: CreditCard[] };
      }>(GET_CREDIT_CARDS, { cardIds });

      const cards = cardsResponse.creditCards?.items ?? [];
      setPaymentMethods(
        cards.map((card) => ({
          id: card.CreditCardID.toString(),
          cardLast4: card.CardNumber.slice(-4),
          cardBrand: getCardBrand(card.CardType),
          cardExpiry: `${String(card.ExpMonth).padStart(2, "0")}/${card.ExpYear}`,
        })),
      );
    } catch {
      setPaymentMethods([]);
    } finally {
      setIsLoading(false);
    }
  }, [businessEntityId]);

  useEffect(() => {
    fetchPaymentMethods();
  }, [fetchPaymentMethods]);

  const removePaymentMethod = useCallback(
    async (creditCardId: string) => {
      if (!businessEntityId) return;

      const restUrl = getRestApiUrl();
      const response = await fetch(
        `${restUrl}/PersonCreditCard/BusinessEntityID/${businessEntityId}/CreditCardID/${creditCardId}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to remove payment method: ${text}`);
      }
      await fetchPaymentMethods();
    },
    [businessEntityId, fetchPaymentMethods],
  );

  return {
    paymentMethods,
    isLoading,
    removePaymentMethod,
    refetch: fetchPaymentMethods,
  };
};
