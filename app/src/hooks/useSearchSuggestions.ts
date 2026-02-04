import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { getFunctionsApiUrl } from "@/lib/utils";

export interface SearchSuggestionsResponse {
  query: string;
  suggestions: string[];
}

/**
 * Hook to get AI-powered search suggestions with debouncing
 * @param query - The search query to get suggestions for
 * @param debounceMs - Milliseconds to wait before triggering search (default: 300)
 */
export const useSearchSuggestions = (
  query: string,
  debounceMs: number = 300,
) => {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  // Debounce the query to avoid excessive API calls
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(query);
    }, debounceMs);

    return () => {
      clearTimeout(handler);
    };
  }, [query, debounceMs]);

  return useQuery<SearchSuggestionsResponse>({
    queryKey: ["searchSuggestions", debouncedQuery],
    queryFn: async () => {
      if (!debouncedQuery || debouncedQuery.trim().length < 2) {
        return {
          query: debouncedQuery,
          suggestions: [],
        };
      }

      const functionsApiUrl = getFunctionsApiUrl();
      const response = await fetch(
        `${functionsApiUrl}/api/search/suggestions?q=${encodeURIComponent(debouncedQuery.trim())}`,
      );

      if (!response.ok) {
        throw new Error(`Search suggestions failed: ${response.statusText}`);
      }

      return response.json();
    },
    enabled: debouncedQuery.trim().length >= 2,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    retry: 1, // Only retry once for faster fallback
  });
};
