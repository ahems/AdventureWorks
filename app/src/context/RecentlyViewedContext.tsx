import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import { Product } from "@/types/product";
import { trackError } from "@/lib/appInsights";

// Lightweight version for localStorage - no photo binary data
interface RecentlyViewedProduct {
  ProductID: number;
  Name: string;
  ProductNumber: string;
  Color: string | null;
  ListPrice: number;
  Size: string | null;
  ProductSubcategoryID: number | null;
  DiscountPct?: number;
  SpecialOfferDescription?: string;
  ThumbnailPhotoFileName?: string | null;
  LargePhotoFileName?: string | null;
}

interface RecentlyViewedContextType {
  recentlyViewed: Product[];
  addToRecentlyViewed: (product: Product) => void;
  clearRecentlyViewed: () => void;
}

const RecentlyViewedContext = createContext<
  RecentlyViewedContextType | undefined
>(undefined);

const STORAGE_KEY = "adventureworks_recently_viewed";
const MAX_ITEMS = 8;

// Convert full Product to lightweight version (no binary photo data)
const toLightweightProduct = (product: Product): RecentlyViewedProduct => ({
  ProductID: product.ProductID,
  Name: product.Name,
  ProductNumber: product.ProductNumber,
  Color: product.Color,
  ListPrice: product.ListPrice,
  Size: product.Size,
  ProductSubcategoryID: product.ProductSubcategoryID,
  DiscountPct: product.DiscountPct,
  SpecialOfferDescription: product.SpecialOfferDescription,
  ThumbnailPhotoFileName: product.ThumbnailPhotoFileName,
  LargePhotoFileName: product.LargePhotoFileName,
});

export const RecentlyViewedProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [recentlyViewed, setRecentlyViewed] = useState<Product[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const lightweight: RecentlyViewedProduct[] = JSON.parse(stored);
        // Convert back to Product (without photo data - will be fetched when needed)
        setRecentlyViewed(lightweight as Product[]);
      }
    } catch (error) {
      // Invalid stored data - clear it
      trackError("Failed to load recently viewed products", error, {
        component: "RecentlyViewedContext",
      });
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // Save to localStorage whenever recentlyViewed changes (lightweight version only)
  useEffect(() => {
    try {
      const lightweight = recentlyViewed.map(toLightweightProduct);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lightweight));
    } catch (error) {
      // Quota exceeded or other error - clear old data and try again with fewer items
      trackError("Failed to save recently viewed products", error, {
        component: "RecentlyViewedContext",
        itemCount: recentlyViewed.length,
      });
      try {
        localStorage.removeItem(STORAGE_KEY);
        const reduced = recentlyViewed.slice(0, Math.min(3, MAX_ITEMS));
        const lightweight = reduced.map(toLightweightProduct);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(lightweight));
      } catch (retryError) {
        // Give up - localStorage not available
        trackError("localStorage not available", retryError, {
          component: "RecentlyViewedContext",
        });
      }
    }
  }, [recentlyViewed]);

  const addToRecentlyViewed = useCallback((product: Product) => {
    setRecentlyViewed((prev) => {
      // Remove if already exists
      const filtered = prev.filter((p) => p.ProductID !== product.ProductID);
      // Add to front of array
      const updated = [product, ...filtered];
      // Keep only MAX_ITEMS
      return updated.slice(0, MAX_ITEMS);
    });
  }, []);

  const clearRecentlyViewed = useCallback(() => {
    setRecentlyViewed([]);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <RecentlyViewedContext.Provider
      value={{
        recentlyViewed,
        addToRecentlyViewed,
        clearRecentlyViewed,
      }}
    >
      {children}
    </RecentlyViewedContext.Provider>
  );
};

export const useRecentlyViewed = () => {
  const context = useContext(RecentlyViewedContext);
  if (context === undefined) {
    throw new Error(
      "useRecentlyViewed must be used within a RecentlyViewedProvider",
    );
  }
  return context;
};
