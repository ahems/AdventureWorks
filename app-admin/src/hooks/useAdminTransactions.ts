import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";

export type TransactionType = "W" | "S" | "P";

export interface TransactionRecord {
  TransactionID: number;
  ProductID: number;
  ReferenceOrderID: number;
  ReferenceOrderLineID: number;
  TransactionDate: string;
  TransactionType: TransactionType;
  Quantity: number;
  ActualCost: number;
  ModifiedDate: string;
  product?: { Name: string; ProductNumber: string } | null;
}

export interface TransactionHistoryPage {
  items: TransactionRecord[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const TRANSACTION_FIELDS = `
  TransactionID
  ProductID
  ReferenceOrderID
  ReferenceOrderLineID
  TransactionDate
  TransactionType
  Quantity
  ActualCost
  ModifiedDate
  product {
    Name
    ProductNumber
  }
`;

const GET_TRANSACTION_HISTORY = gql`
  query GetTransactionHistory(
    $first: Int
    $after: String
    $filter: TransactionHistoryFilterInput
  ) {
    transactionHistories(
      first: $first
      after: $after
      orderBy: { TransactionDate: DESC }
      filter: $filter
    ) {
      items {
        ${TRANSACTION_FIELDS}
      }
      hasNextPage
      endCursor
    }
  }
`;

const GET_TRANSACTION_HISTORY_ARCHIVE = gql`
  query GetTransactionHistoryArchive(
    $first: Int
    $after: String
    $filter: TransactionHistoryArchiveFilterInput
  ) {
    transactionHistoryArchives(
      first: $first
      after: $after
      orderBy: { TransactionDate: DESC }
      filter: $filter
    ) {
      items {
        ${TRANSACTION_FIELDS}
      }
      hasNextPage
      endCursor
    }
  }
`;

const GET_TRANSACTIONS_FOR_PRODUCT = gql`
  query GetTransactionsForProduct($productId: Int!, $first: Int) {
    transactionHistories(
      first: $first
      filter: { ProductID: { eq: $productId } }
      orderBy: { TransactionDate: DESC }
    ) {
      items {
        ${TRANSACTION_FIELDS}
      }
      hasNextPage
    }
    transactionHistoryArchives(
      first: $first
      filter: { ProductID: { eq: $productId } }
      orderBy: { TransactionDate: DESC }
    ) {
      items {
        ${TRANSACTION_FIELDS}
      }
      hasNextPage
    }
  }
`;

export interface TransactionFilters {
  productId?: number;
  transactionType?: TransactionType;
  dateFrom?: string;
  dateTo?: string;
  showArchive?: boolean;
  cursor?: string | null;
  pageSize?: number;
}

function buildFilter(filters: TransactionFilters) {
  const conditions: object[] = [];
  if (filters.productId != null) {
    conditions.push({ ProductID: { eq: filters.productId } });
  }
  if (filters.transactionType) {
    conditions.push({ TransactionType: { eq: filters.transactionType } });
  }
  if (filters.dateFrom) {
    conditions.push({ TransactionDate: { gte: filters.dateFrom } });
  }
  if (filters.dateTo) {
    conditions.push({ TransactionDate: { lte: filters.dateTo } });
  }
  return conditions.length > 0 ? { and: conditions } : null;
}

export function useTransactionHistory(filters: TransactionFilters) {
  const query = filters.showArchive
    ? GET_TRANSACTION_HISTORY_ARCHIVE
    : GET_TRANSACTION_HISTORY;

  const variables = {
    first: filters.pageSize ?? 50,
    after: filters.cursor ?? null,
    filter: buildFilter(filters),
  };

  return useQuery({
    queryKey: ["transactionHistory", filters],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        transactionHistories?: TransactionHistoryPage;
        transactionHistoryArchives?: TransactionHistoryPage;
      }>(query, variables);
      const page = filters.showArchive
        ? data.transactionHistoryArchives
        : data.transactionHistories;
      return page ?? { items: [], hasNextPage: false, endCursor: null };
    },
    placeholderData: (prev) => prev,
  });
}

export function useProductTransactionHistory(
  productId: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ["productTransactionHistory", productId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        transactionHistories: TransactionHistoryPage;
        transactionHistoryArchives: TransactionHistoryPage;
      }>(GET_TRANSACTIONS_FOR_PRODUCT, { productId, first: 50 });

      const current = data.transactionHistories?.items ?? [];
      const archived = data.transactionHistoryArchives?.items ?? [];

      // Merge and sort by date desc, take top 50
      return [...current, ...archived]
        .sort(
          (a, b) =>
            new Date(b.TransactionDate).getTime() -
            new Date(a.TransactionDate).getTime(),
        )
        .slice(0, 50);
    },
    enabled: enabled && productId > 0,
  });
}
