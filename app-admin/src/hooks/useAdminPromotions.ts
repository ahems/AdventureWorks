import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { SpecialOffer } from "@/types/promotion";
import { SpecialOfferProduct } from "@/types/specialOfferProduct";

// ─── Queries ──────────────────────────────────────────────────────────────────

const GET_SPECIAL_OFFERS_ADMIN = gql`
  query GetSpecialOffersAdmin {
    specialOffers(first: 1000) {
      items {
        SpecialOfferID
        CultureID
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

// ─── Mutations ────────────────────────────────────────────────────────────────

const CREATE_SPECIAL_OFFER = gql`
  mutation CreateSpecialOffer(
    $specialOfferID: Int!
    $cultureId: String!
    $description: String!
    $discountPct: Decimal!
    $type: String!
    $category: String!
    $startDate: DateTime!
    $endDate: DateTime!
    $minQty: Int!
    $maxQty: Int
    $modifiedDate: DateTime
  ) {
    createSpecialOffer(
      item: {
        SpecialOfferID: $specialOfferID
        CultureID: $cultureId
        Description: $description
        DiscountPct: $discountPct
        Type: $type
        Category: $category
        StartDate: $startDate
        EndDate: $endDate
        MinQty: $minQty
        MaxQty: $maxQty
        ModifiedDate: $modifiedDate
      }
    ) {
      SpecialOfferID
      CultureID
    }
  }
`;

const UPDATE_SPECIAL_OFFER = gql`
  mutation UpdateSpecialOffer(
    $id: Int!
    $cultureId: String!
    $description: String!
    $discountPct: Decimal!
    $type: String!
    $category: String!
    $startDate: DateTime!
    $endDate: DateTime!
    $minQty: Int!
    $maxQty: Int
    $modifiedDate: DateTime
  ) {
    updateSpecialOffer(
      SpecialOfferID: $id
      CultureID: $cultureId
      item: {
        Description: $description
        DiscountPct: $discountPct
        Type: $type
        Category: $category
        StartDate: $startDate
        EndDate: $endDate
        MinQty: $minQty
        MaxQty: $maxQty
        ModifiedDate: $modifiedDate
      }
    ) {
      SpecialOfferID
      CultureID
      Description
    }
  }
`;

const DELETE_SPECIAL_OFFER = gql`
  mutation DeleteSpecialOffer($id: Int!, $cultureId: String!) {
    deleteSpecialOffer(SpecialOfferID: $id, CultureID: $cultureId) {
      SpecialOfferID
      CultureID
    }
  }
`;

const CREATE_SPECIAL_OFFER_PRODUCT = gql`
  mutation CreateSpecialOfferProduct(
    $offerId: Int!
    $productId: Int!
    $modifiedDate: DateTime
  ) {
    createSpecialOfferProduct(
      item: {
        SpecialOfferID: $offerId
        ProductID: $productId
        ModifiedDate: $modifiedDate
      }
    ) {
      SpecialOfferID
      ProductID
    }
  }
`;

const DELETE_SPECIAL_OFFER_PRODUCT = gql`
  mutation DeleteSpecialOfferProduct($offerId: Int!, $productId: Int!) {
    deleteSpecialOfferProduct(SpecialOfferID: $offerId, ProductID: $productId) {
      SpecialOfferID
      ProductID
    }
  }
`;

type SpecialOfferInput = {
  SpecialOfferID?: number; // provided for create (not an identity column)
  CultureID: string;
  Description: string;
  DiscountPct: number;
  Type: string;
  Category: string;
  StartDate: string;
  EndDate: string;
  MinQty: number;
  MaxQty: number | null;
};

export const useCreateSpecialOffer = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: SpecialOfferInput & { SpecialOfferID: number },
    ) => {
      const modifiedDate = new Date().toISOString();
      const data = await graphqlClient.request<{
        createSpecialOffer: { SpecialOfferID: number; CultureID: string };
      }>(CREATE_SPECIAL_OFFER, {
        specialOfferID: input.SpecialOfferID,
        cultureId: input.CultureID,
        description: input.Description,
        discountPct: input.DiscountPct,
        type: input.Type,
        category: input.Category,
        startDate: input.StartDate,
        endDate: input.EndDate,
        minQty: input.MinQty,
        maxQty: input.MaxQty,
        modifiedDate,
      });
      return data.createSpecialOffer.SpecialOfferID;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "specialOffers"] });
    },
  });
};

export const useUpdateSpecialOffer = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SpecialOfferInput & { id: number }) => {
      const modifiedDate = new Date().toISOString();
      await graphqlClient.request(UPDATE_SPECIAL_OFFER, {
        id: input.id,
        cultureId: input.CultureID,
        description: input.Description,
        discountPct: input.DiscountPct,
        type: input.Type,
        category: input.Category,
        startDate: input.StartDate,
        endDate: input.EndDate,
        minQty: input.MinQty,
        maxQty: input.MaxQty,
        modifiedDate,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "specialOffers"] });
    },
  });
};

export const useDeleteSpecialOffer = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      cultureIds,
      productIds,
    }: {
      id: number;
      cultureIds: string[];
      productIds: number[];
    }) => {
      // Delete product assignments first to satisfy FK constraints
      await Promise.all(
        productIds.map((productId) =>
          graphqlClient.request(DELETE_SPECIAL_OFFER_PRODUCT, {
            offerId: id,
            productId,
          }),
        ),
      );
      // Delete all culture variants for this SpecialOfferID in parallel
      await Promise.all(
        cultureIds.map((cultureId) =>
          graphqlClient.request(DELETE_SPECIAL_OFFER, { id, cultureId }),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "specialOffers"] });
      queryClient.invalidateQueries({
        queryKey: ["admin", "specialOfferProducts"],
      });
    },
  });
};

type AssignProductsInput = {
  offerId: number;
  newProductIds: number[];
  currentProductIds: number[];
};

export const useAssignSpecialOfferProducts = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      offerId,
      newProductIds,
      currentProductIds,
    }: AssignProductsInput) => {
      const modifiedDate = new Date().toISOString();
      const toDelete = currentProductIds.filter(
        (id) => !newProductIds.includes(id),
      );
      const toCreate = newProductIds.filter(
        (id) => !currentProductIds.includes(id),
      );
      await Promise.all([
        ...toDelete.map((productId) =>
          graphqlClient.request(DELETE_SPECIAL_OFFER_PRODUCT, {
            offerId,
            productId,
          }),
        ),
        ...toCreate.map((productId) =>
          graphqlClient.request(CREATE_SPECIAL_OFFER_PRODUCT, {
            offerId,
            productId,
            modifiedDate,
          }),
        ),
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "specialOfferProducts"],
      });
    },
  });
};
