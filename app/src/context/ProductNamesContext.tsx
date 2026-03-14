import React, { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { GET_PRODUCT_NAMES_BY_CULTURE } from "@/lib/graphql-queries";
import { useLanguage } from "@/context/LanguageContext";

interface ProductNameItem {
  ProductID: number;
  Name: string;
}

interface ProductNamesContextType {
  getLocalizedName: (productId: number) => string | undefined;
  isLoading: boolean;
}

const ProductNamesContext = createContext<ProductNamesContextType | undefined>(
  undefined
);

export const ProductNamesProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { selectedLanguage } = useLanguage();

  const { data, isLoading } = useQuery({
    queryKey: ["productNames", selectedLanguage],
    queryFn: async () => {
      try {
        // Pad to 6 chars to match SQL Server NCHAR(6) CultureID
        const cultureIdPadded =
          selectedLanguage.length >= 6
            ? selectedLanguage.slice(0, 6)
            : selectedLanguage.padEnd(6, " ");
        const result = await graphqlClient.request<{
          productNames: { items: ProductNameItem[] };
        }>(GET_PRODUCT_NAMES_BY_CULTURE, { cultureId: cultureIdPadded });
        return result.productNames.items;
      } catch {
        // API may not expose productNames yet (e.g. DAB not redeployed); fall back to English names
        return [];
      }
    },
    staleTime: 10 * 60 * 1000, // 10 minutes — product names rarely change
    gcTime: 30 * 60 * 1000,
    retry: false, // Avoid retrying on 400 (e.g. schema missing productNames)
  });

  // Build a lookup map keyed by ProductID for O(1) access
  const nameMap = useMemo(() => {
    if (!data) return new Map<number, string>();
    return new Map(data.map((item) => [item.ProductID, item.Name]));
  }, [data]);

  const getLocalizedName = (productId: number): string | undefined => {
    return nameMap.get(productId);
  };

  return (
    <ProductNamesContext.Provider value={{ getLocalizedName, isLoading }}>
      {children}
    </ProductNamesContext.Provider>
  );
};

export const useProductNames = () => {
  const context = useContext(ProductNamesContext);
  if (context === undefined) {
    throw new Error(
      "useProductNames must be used within a ProductNamesProvider"
    );
  }
  return context;
};
