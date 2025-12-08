import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { Product, CartItem, getSalePrice } from '@/types/product';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';

const CART_STORAGE_KEY = 'adventure_cart';

interface CartContextType {
  items: CartItem[];
  addToCart: (product: Product, quantity?: number, selectedSize?: string, selectedColor?: string) => void;
  removeFromCart: (productId: number, selectedSize?: string, selectedColor?: string) => void;
  updateQuantity: (productId: number, quantity: number, selectedSize?: string, selectedColor?: string) => void;
  clearCart: () => void;
  getTotalItems: () => number;
  getTotalPrice: () => number;
  getOriginalPrice: () => number;
  getTotalDiscount: () => number;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

// Helper to create unique cart item key
const getCartItemKey = (productId: number, size?: string, color?: string) => {
  return `${productId}-${size || 'none'}-${color || 'none'}`;
};

// Load cart from localStorage
const loadCart = (): CartItem[] => {
  try {
    const saved = localStorage.getItem(CART_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
};

// Save cart to localStorage
const saveCart = (items: CartItem[]) => {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
};

export const CartProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<CartItem[]>(() => loadCart());

  // Persist cart to localStorage whenever it changes
  useEffect(() => {
    saveCart(items);
  }, [items]);

  const addToCart = useCallback((product: Product, quantity: number = 1, selectedSize?: string, selectedColor?: string) => {
    setItems(prevItems => {
      const existingItem = prevItems.find(item => 
        item.ProductID === product.ProductID &&
        item.selectedSize === selectedSize &&
        item.selectedColor === selectedColor
      );
      
      const displayName = selectedSize || selectedColor 
        ? `${product.Name}${selectedSize ? ` (${selectedSize})` : ''}${selectedColor ? ` - ${selectedColor}` : ''}`
        : product.Name;

      if (existingItem) {
        toast({
          title: "Cart Updated!",
          description: `Added another ${displayName} to your cart`,
          action: (
            <ToastAction altText="View cart" asChild>
              <a href="/cart">View Cart</a>
            </ToastAction>
          ),
        });
        return prevItems.map(item =>
          item.ProductID === product.ProductID &&
          item.selectedSize === selectedSize &&
          item.selectedColor === selectedColor
            ? { ...item, quantity: item.quantity + quantity }
            : item
        );
      } else {
        toast({
          title: "Added to Cart!",
          description: `${displayName} is now in your cart`,
          action: (
            <ToastAction altText="View cart" asChild>
              <a href="/cart">View Cart</a>
            </ToastAction>
          ),
        });
        return [...prevItems, { ...product, quantity, selectedSize, selectedColor }];
      }
    });
  }, []);

  const removeFromCart = useCallback((productId: number, selectedSize?: string, selectedColor?: string) => {
    setItems(prevItems => {
      const item = prevItems.find(i => 
        i.ProductID === productId &&
        i.selectedSize === selectedSize &&
        i.selectedColor === selectedColor
      );
      if (item) {
        const displayName = selectedSize || selectedColor 
          ? `${item.Name}${selectedSize ? ` (${selectedSize})` : ''}${selectedColor ? ` - ${selectedColor}` : ''}`
          : item.Name;
        toast({
          title: "Removed from Cart",
          description: `${displayName} has been removed`,
        });
      }
      return prevItems.filter(item => 
        !(item.ProductID === productId &&
          item.selectedSize === selectedSize &&
          item.selectedColor === selectedColor)
      );
    });
  }, []);

  const updateQuantity = useCallback((productId: number, quantity: number, selectedSize?: string, selectedColor?: string) => {
    if (quantity <= 0) {
      removeFromCart(productId, selectedSize, selectedColor);
      return;
    }
    setItems(prevItems =>
      prevItems.map(item =>
        item.ProductID === productId &&
        item.selectedSize === selectedSize &&
        item.selectedColor === selectedColor
          ? { ...item, quantity }
          : item
      )
    );
  }, [removeFromCart]);

  const clearCart = useCallback(() => {
    setItems([]);
    toast({
      title: "Cart Cleared",
      description: "All items have been removed from your cart",
    });
  }, []);

  const getTotalItems = useCallback(() => {
    return items.reduce((total, item) => total + item.quantity, 0);
  }, [items]);

  // Get total price with sale prices applied
  const getTotalPrice = useCallback(() => {
    return items.reduce((total, item) => {
      const salePrice = getSalePrice(item);
      const price = salePrice !== null ? salePrice : item.ListPrice;
      return total + (price * item.quantity);
    }, 0);
  }, [items]);

  // Get original price without discounts
  const getOriginalPrice = useCallback(() => {
    return items.reduce((total, item) => total + (item.ListPrice * item.quantity), 0);
  }, [items]);

  // Get total discount amount
  const getTotalDiscount = useCallback(() => {
    return items.reduce((total, item) => {
      const salePrice = getSalePrice(item);
      if (salePrice !== null) {
        return total + ((item.ListPrice - salePrice) * item.quantity);
      }
      return total;
    }, 0);
  }, [items]);

  return (
    <CartContext.Provider value={{
      items,
      addToCart,
      removeFromCart,
      updateQuantity,
      clearCart,
      getTotalItems,
      getTotalPrice,
      getOriginalPrice,
      getTotalDiscount,
    }}>
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};
