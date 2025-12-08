import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Product } from '@/types/product';
import { useAuth } from './AuthContext';
import { toast } from '@/hooks/use-toast';

interface WishlistContextType {
  items: Product[];
  addToWishlist: (product: Product) => void;
  removeFromWishlist: (productId: number) => void;
  isInWishlist: (productId: number) => boolean;
  clearWishlist: () => void;
}

const WishlistContext = createContext<WishlistContextType | undefined>(undefined);

const WISHLIST_STORAGE_KEY = 'adventure_wishlist';

export const WishlistProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<Product[]>([]);
  const { user } = useAuth();

  // Load wishlist from localStorage when user changes
  useEffect(() => {
    if (user) {
      const storageKey = `${WISHLIST_STORAGE_KEY}_${user.id}`;
      const savedWishlist = localStorage.getItem(storageKey);
      if (savedWishlist) {
        setItems(JSON.parse(savedWishlist));
      } else {
        setItems([]);
      }
    } else {
      setItems([]);
    }
  }, [user]);

  // Save wishlist to localStorage when items change
  useEffect(() => {
    if (user) {
      const storageKey = `${WISHLIST_STORAGE_KEY}_${user.id}`;
      localStorage.setItem(storageKey, JSON.stringify(items));
    }
  }, [items, user]);

  const addToWishlist = (product: Product) => {
    if (!user) {
      toast({
        title: "Sign in required",
        description: "Please sign in to add items to your wishlist",
        variant: "destructive",
      });
      return;
    }

    if (!items.find(item => item.ProductID === product.ProductID)) {
      setItems(prev => [...prev, product]);
      toast({
        title: "Added to Wishlist",
        description: `${product.Name} has been added to your wishlist`,
      });
    }
  };

  const removeFromWishlist = (productId: number) => {
    const product = items.find(item => item.ProductID === productId);
    setItems(prev => prev.filter(item => item.ProductID !== productId));
    if (product) {
      toast({
        title: "Removed from Wishlist",
        description: `${product.Name} has been removed from your wishlist`,
      });
    }
  };

  const isInWishlist = (productId: number) => {
    return items.some(item => item.ProductID === productId);
  };

  const clearWishlist = () => {
    setItems([]);
  };

  return (
    <WishlistContext.Provider value={{ items, addToWishlist, removeFromWishlist, isInWishlist, clearWishlist }}>
      {children}
    </WishlistContext.Provider>
  );
};

export const useWishlist = () => {
  const context = useContext(WishlistContext);
  if (context === undefined) {
    throw new Error('useWishlist must be used within a WishlistProvider');
  }
  return context;
};
