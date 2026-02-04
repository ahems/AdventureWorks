import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";

export interface Currency {
  CurrencyCode: string;
  Name: string;
}

export interface CurrencyRate {
  FromCurrencyCode: string;
  ToCurrencyCode: string;
  AverageRate: number;
  EndOfDayRate: number;
}

const GET_CURRENCIES = gql`
  query GetCurrencies {
    currencies {
      items {
        CurrencyCode
        Name
      }
    }
  }
`;

const GET_CURRENCY_RATES = gql`
  query GetCurrencyRates {
    currencyRates(first: 200) {
      items {
        FromCurrencyCode
        ToCurrencyCode
        AverageRate
        EndOfDayRate
      }
    }
  }
`;

export const useCurrencies = () => {
  return useQuery({
    queryKey: ["currencies"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        currencies: { items: Currency[] };
      }>(GET_CURRENCIES);
      return data.currencies.items;
    },
    staleTime: 24 * 60 * 60 * 1000, // 24 hours - currencies don't change often
  });
};

export const useCurrencyRates = () => {
  return useQuery({
    queryKey: ["currencyRates"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        currencyRates: { items: CurrencyRate[] };
      }>(GET_CURRENCY_RATES);
      return data.currencyRates.items;
    },
    staleTime: 60 * 60 * 1000, // 1 hour - rates are relatively static in this demo
  });
};
