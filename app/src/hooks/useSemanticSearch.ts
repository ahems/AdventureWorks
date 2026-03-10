import { useQuery, useMutation } from "@tanstack/react-query";
import { getFunctionsApiUrl } from "@/lib/utils";
import { useLanguage } from "@/context/LanguageContext";

export interface SemanticSearchResult {
  ProductID: number;
  Name: string;
  Description: string | null;
  ListPrice: number | null;
  Color: string | null;
  SimilarityScore: number;
  MatchSource: "Description" | "Review" | "ProductName" | string;
  MatchText: string | null;
}

export interface SemanticSearchResponse {
  query: string;
  results: SemanticSearchResult[];
  totalResults: number;
  descriptionMatches: number;
  reviewMatches: number;
  nameMatches: number;
}

// Hook to perform semantic search
export const useSemanticSearch = (query: string, enabled: boolean = false) => {
  const { selectedLanguage } = useLanguage();

  return useQuery<SemanticSearchResponse>({
    queryKey: ["semanticSearch", query, selectedLanguage],
    queryFn: async () => {
      if (!query || query.trim().length === 0) {
        return {
          query: "",
          results: [],
          totalResults: 0,
          descriptionMatches: 0,
          reviewMatches: 0,
          nameMatches: 0,
        };
      }

      const functionsApiUrl = getFunctionsApiUrl();
      const response = await fetch(`${functionsApiUrl}/api/search/semantic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.trim(),
          topN: 20,
          cultureId: selectedLanguage,
        }),
      });

      if (!response.ok) {
        throw new Error(`Semantic search failed: ${response.statusText}`);
      }

      return response.json();
    },
    enabled: enabled && query.trim().length > 0,
    staleTime: 1 * 60 * 1000, // 1 minute
  });
};

// Hook to manually trigger semantic search
export const useSemanticSearchMutation = () => {
  const { selectedLanguage } = useLanguage();

  return useMutation({
    mutationFn: async ({
      query,
      topN = 20,
    }: {
      query: string;
      topN?: number;
    }) => {
      const functionsApiUrl = getFunctionsApiUrl();
      const response = await fetch(`${functionsApiUrl}/api/search/semantic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.trim(),
          topN,
          cultureId: selectedLanguage,
        }),
      });

      if (!response.ok) {
        throw new Error(`Semantic search failed: ${response.statusText}`);
      }

      const data: SemanticSearchResponse = await response.json();
      return data;
    },
  });
};
