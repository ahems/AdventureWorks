import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getFunctionsApiUrl } from "@/lib/utils";
import {
  StoreListItem,
  StoreDetail,
  StoreOrderSummary,
  StoreProductInfo,
  PlaceStoreOrderPayload,
  TerritoryStoreSummary,
  OrderLineDetail,
  ProductCategoryInfo,
} from "@/types/store";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";

// ── Ship Methods (for order form) ─────────────────────────────────────────────

const GET_SHIP_METHODS = gql`
  query GetShipMethods {
    shipMethods(orderBy: { ShipBase: ASC }) {
      items {
        ShipMethodID
        Name
        ShipBase
        ShipRate
      }
    }
  }
`;

export interface ShipMethod {
  ShipMethodID: number;
  Name: string;
  ShipBase: number;
  ShipRate: number;
}

export const useShipMethods = () =>
  useQuery<ShipMethod[]>({
    queryKey: ["ship-methods"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        shipMethods?: { items: ShipMethod[] };
      }>(GET_SHIP_METHODS);
      return data.shipMethods?.items ?? [];
    },
    staleTime: 10 * 60 * 1000,
  });

// ── Stores list ───────────────────────────────────────────────────────────────

export interface PagedStores {
  items: StoreListItem[];
  totalCount: number;
  hasMore: boolean;
}

export const useStores = (
  search?: string,
  territoryId?: number,
  sortBy: "revenue" | "orders" | "lastOrder" | "name" = "revenue",
  offset = 0,
  limit = 50,
  enabled = true,
) =>
  useQuery<PagedStores>({
    queryKey: [
      "admin",
      "stores",
      search ?? "",
      territoryId ?? 0,
      sortBy,
      offset,
      limit,
    ],
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (territoryId !== undefined)
        params.set("territoryId", String(territoryId));
      params.set("sortBy", sortBy);
      params.set("offset", String(offset));
      params.set("limit", String(limit));
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/stores?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
  });

// ── Territory summaries ───────────────────────────────────────────────────────

export const useStoreTerritories = () =>
  useQuery<TerritoryStoreSummary[]>({
    queryKey: ["admin", "store-territories"],
    queryFn: async () => {
      const res = await fetch(`${getFunctionsApiUrl()}/api/store-territories`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

// ── Store detail ─────────────────────────────────────────────────────────────

export const useStoreById = (storeId: number | null) =>
  useQuery<StoreDetail>({
    queryKey: ["admin", "store", storeId],
    enabled: storeId !== null,
    queryFn: async () => {
      const res = await fetch(`${getFunctionsApiUrl()}/api/stores/${storeId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

// ── Store orders ──────────────────────────────────────────────────────────────

export const useStoreOrders = (storeId: number | null) =>
  useQuery<StoreOrderSummary[]>({
    queryKey: ["admin", "store-orders", storeId],
    enabled: storeId !== null,
    queryFn: async () => {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/stores/${storeId}/orders`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 1 * 60 * 1000,
  });

// ── Store products (for order form) ──────────────────────────────────────────

export const useStoreProducts = (
  search?: string,
  categoryId?: number | null,
  subcategoryId?: number | null,
) =>
  useQuery<StoreProductInfo[]>({
    queryKey: [
      "store-products",
      search ?? "",
      categoryId ?? null,
      subcategoryId ?? null,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (categoryId != null) params.set("categoryId", String(categoryId));
      if (subcategoryId != null)
        params.set("subcategoryId", String(subcategoryId));
      params.set("limit", "150");
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/store-products?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
    // Only fetch when at least one filter is active
    enabled: !!(search || categoryId != null || subcategoryId != null),
  });

// ── Order line details (for Reorder) ─────────────────────────────────────────

export const useOrderLines = (salesOrderId: number | null) =>
  useQuery<OrderLineDetail[]>({
    queryKey: ["order-lines", salesOrderId],
    enabled: salesOrderId !== null,
    queryFn: async () => {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/orders/${salesOrderId}/lines`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

// ── Product catalog (categories + subcategories for nav) ──────────────────────

export const useProductCatalog = () =>
  useQuery<ProductCategoryInfo[]>({
    queryKey: ["product-catalog"],
    queryFn: async () => {
      const res = await fetch(`${getFunctionsApiUrl()}/api/product-catalog`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
  });

// ── All store products (no category filter, for promotion browsing) ────────────

export const useAllStoreProducts = (enabled = false) =>
  useQuery<StoreProductInfo[]>({
    queryKey: ["store-products", "all"],
    enabled,
    queryFn: async () => {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/store-products?limit=500`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

// ── Place store order mutation ────────────────────────────────────────────────

export interface PlaceStoreOrderResult {
  success: boolean;
  salesOrderId: number;
  message: string;
}

export const usePlaceStoreOrder = () => {
  const queryClient = useQueryClient();
  return useMutation<PlaceStoreOrderResult, Error, PlaceStoreOrderPayload>({
    mutationFn: async (payload) => {
      const res = await fetch(`${getFunctionsApiUrl()}/api/store-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "store-orders", vars.storeBusinessEntityId],
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "stores"] });
    },
  });
};
