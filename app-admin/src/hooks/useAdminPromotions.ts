import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { SpecialOffer } from "@/types/promotion";
import { SpecialOfferProduct } from "@/types/specialOfferProduct";

const GET_SPECIAL_OFFERS_ADMIN = gql`
  query GetSpecialOffersAdmin {
    specialOffers(first: 1000) {
      items {
        SpecialOfferID
        Description
        DiscountPct
        Type
        Category
        StartDate
        EndDate
        MinQty
        MaxQty
      }
    }
  }
`;

const GET_SPECIAL_OFFER_PRODUCTS_ADMIN = gql`
  query GetSpecialOfferProductsAdmin {
    specialOfferProducts(first: 1000) {
      items {
        SpecialOfferID
        ProductID
      }
    }
  }
`;

export const useAdminSpecialOffers = () =>
  useQuery<SpecialOffer[]>({
    queryKey: ["admin", "specialOffers"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        specialOffers?: { items: SpecialOffer[] };
      }>(GET_SPECIAL_OFFERS_ADMIN);
      return data.specialOffers?.items ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

export const useAdminSpecialOfferProducts = () =>
  useQuery<SpecialOfferProduct[]>({
    queryKey: ["admin", "specialOfferProducts"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        specialOfferProducts?: { items: SpecialOfferProduct[] };
      }>(GET_SPECIAL_OFFER_PRODUCTS_ADMIN);
      return data.specialOfferProducts?.items ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });
