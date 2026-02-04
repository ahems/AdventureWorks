import React, { createContext, useContext, useState, useCallback } from 'react';
import { Product } from '@/types/product';
import { toast } from '@/hooks/use-toast';

const MAX_COMPARE_ITEMS = 3;

interface CompareContextType {
  items: Product[];
  addToCompare: (product: Product) => void;
  removeFromCompare: (productId: number) => void;
  clearCompare: () => void;
  isInCompare: (productId: number) => boolean;
  canAddMore: boolean;
}

const CompareContext = createContext<CompareContextType | undefined>(undefined);

export const CompareProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<Product[]>([]);

  const addToCompare = useCallback((product: Product) => {
    setItems(prev => {
      if (prev.some(item => item.ProductID === product.ProductID)) {
        toast({
          title: "Already in comparison",
          description: `${product.Name} is already in your comparison list.`,
        });
        return prev;
      }
      
      if (prev.length >= MAX_COMPARE_ITEMS) {
        toast({
          title: "Comparison limit reached",
          description: `You can compare up to ${MAX_COMPARE_ITEMS} products. Remove one to add another.`,
          variant: "destructive",
        });
        return prev;
      }
      
      toast({
        title: "Added to comparison",
        description: `${product.Name} added to comparison.`,
      });
      
      return [...prev, product];
    });
  }, []);

  const removeFromCompare = useCallback((productId: number) => {
    setItems(prev => prev.filter(item => item.ProductID !== productId));
  }, []);

  const clearCompare = useCallback(() => {
    setItems([]);
  }, []);

  const isInCompare = useCallback((productId: number) => {
    return items.some(item => item.ProductID === productId);
  }, [items]);

  const canAddMore = items.length < MAX_COMPARE_ITEMS;

  return (
    <CompareContext.Provider value={{
      items,
      addToCompare,
      removeFromCompare,
      clearCompare,
      isInCompare,
      canAddMore,
    }}>
      {children}
    </CompareContext.Provider>
  );
};

export const useCompare = () => {
  const context = useContext(CompareContext);
  if (!context) {
    throw new Error('useCompare must be used within a CompareProvider');
  }
  return context;
};
