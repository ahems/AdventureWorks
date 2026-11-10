import React, { createContext, useContext, useMemo, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Product,
  CartItem,
  getSalePrice,
  ShoppingCartItem,
} from "@/types/product";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useAuth } from "@/context/AuthContext";
import {
  useShoppingCart,
  useAddToCart,
  useUpdateCartItem,
  useDeleteCartItem,
  useClearCart,
} from "@/hooks/useShoppingCart";
import { trackEvent, trackError } from "@/lib/appInsights";
import { useProductsByIds } from "@/hooks/useProducts";
import { useLanguage } from "@/context/LanguageContext";
import {
  GuestCartSession, GUEST_CART_EVENT, GUEST_CART_STORAGE_KEY, ensureGuestCartSession,
  mergeGuestCartSession, readGuestCartSession,
} from "@/services/ownedCart";

interface CartContextType {
  items: CartItem[];
  isLoading: boolean;
  error: string | null;
  canRetryGuestMerge: boolean;
  retryGuestMerge: () => void;
  addToCart: (
    product: Product,
    quantity?: number,
    selectedSize?: string,
    selectedColor?: string,
  ) => void;
  removeFromCart: (
    productId: number,
    selectedSize?: string,
    selectedColor?: string,
  ) => void;
  updateQuantity: (
    productId: number,
    quantity: number,
    selectedSize?: string,
    selectedColor?: string,
  ) => void;
  clearCart: () => void;
  getTotalItems: () => number;
  getTotalPrice: () => number;
  getOriginalPrice: () => number;
  getTotalDiscount: () => number;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export const CartProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [guestSession, setGuestSession] = useState<GuestCartSession | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const mergeGeneration = useRef(0);
  const previousCartId = useRef<string | null>(null);
  const businessEntityId = user?.businessEntityId;
  const { selectedLanguage } = useLanguage();
  const shoppingCartId = businessEntityId?.toString() || guestSession?.cartId || null;

  useEffect(() => {
    const previous = previousCartId.current;
    previousCartId.current = shoppingCartId;
    if (previous && previous !== shoppingCartId) {
      void queryClient.cancelQueries({ queryKey: ["shoppingCart", previous] });
      queryClient.removeQueries({ queryKey: ["shoppingCart", previous] });
    }
  }, [shoppingCartId, queryClient]);

  useEffect(() => {
    const refresh = () => {
      try {
        setGuestSession(readGuestCartSession());
      } catch (error) {
        setGuestSession(null);
        trackError("Guest cart session could not be restored", error as Error, { component: "CartContext" });
        toast({ title: "Guest Cart", description: (error as Error).message, variant: "destructive" });
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key === GUEST_CART_STORAGE_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener(GUEST_CART_EVENT, refresh);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(GUEST_CART_EVENT, refresh);
      window.removeEventListener("storage", storage);
    };
  }, []);

  const retryGuestMerge = useCallback(async () => {
    if (!businessEntityId || !guestSession) return;
    const generation = ++mergeGeneration.current;
    setIsMerging(true);
    setMergeError(null);
    try {
      await mergeGuestCartSession(businessEntityId.toString(), guestSession);
      await queryClient.invalidateQueries({ queryKey: ["shoppingCart", businessEntityId.toString()] });
    } catch (error) {
      trackError("Guest cart merge could not be confirmed", error as Error, { component: "CartContext" });
      if (generation === mergeGeneration.current)
        setMergeError("Unable to merge the guest cart. " + (error as Error).message);
    } finally {
      if (generation === mergeGeneration.current) setIsMerging(false);
    }
  }, [businessEntityId, guestSession, queryClient]);

  const invalidatePendingMerge = useCallback(() => { mergeGeneration.current++; }, []);
  useEffect(() => {
    setMergeError(null);
    if (businessEntityId && guestSession) void retryGuestMerge();
    else setIsMerging(false);
    return invalidatePendingMerge;
  }, [businessEntityId, guestSession, retryGuestMerge, invalidatePendingMerge]);

  // Fetch cart items from API
  const { data: cartItems = [], isLoading: cartLoading, error: cartError } =
    useShoppingCart(shoppingCartId);

  // Extract product IDs from cart items
  const productIds = useMemo(
    () => cartItems.map((item) => item.ProductID),
    [cartItems],
  );

  // Fetch only the products that are in the cart (optimized), with discount text in current culture
  const { data: cartProducts = [], isLoading: productsLoading } =
    useProductsByIds(productIds, selectedLanguage);

  // Mutations
  const addToCartMutation = useAddToCart();
  const updateCartMutation = useUpdateCartItem();
  const deleteCartMutation = useDeleteCartItem();
  const clearCartMutation = useClearCart();

  const isLoading = cartLoading || productsLoading || isMerging;

  // Combine cart items with product details to create CartItem objects
  const items = useMemo<CartItem[]>(() => {
    // Return empty if cart items haven't loaded yet (loading state)
    if (!cartItems.length) return [];

    // If we have cart items but products haven't loaded yet, show loading
    if (productsLoading) {
      return [];
    }

    // Map cart items to products
    return cartItems
      .map((cartItem) => {
        const product = cartProducts.find(
          (p) => p.ProductID === cartItem.ProductID,
        );
        if (!product) {
          trackError(`Product not found for cart item`, undefined, {
            component: "CartContext",
            productId: cartItem.ProductID,
          });
          return null;
        }

        return {
          ...product,
          quantity: cartItem.Quantity,
          ShoppingCartItemID: cartItem.ShoppingCartItemID,
        } as CartItem & { ShoppingCartItemID: number };
      })
      .filter(
        (item): item is CartItem & { ShoppingCartItemID: number } =>
          item !== null,
      );
  }, [cartItems, cartProducts, productsLoading]);

  const addToCart = async (
    product: Product,
    quantity: number = 1,
    selectedSize?: string,
    selectedColor?: string,
  ) => {
    let activeCartId = shoppingCartId;
    try {
      if (!activeCartId) activeCartId = (await ensureGuestCartSession()).cartId;
    } catch (error) {
      trackError("Guest cart session could not be created", error as Error, { component: "CartContext" });
      toast({ title: "Cart Unavailable", description: (error as Error).message, variant: "destructive" });
      return;
    }

    const displayName =
      selectedSize || selectedColor
        ? `${product.Name}${selectedSize ? ` (${selectedSize})` : ""}${
            selectedColor ? ` - ${selectedColor}` : ""
          }`
        : product.Name;

      try {
        await addToCartMutation.mutateAsync({
          shoppingCartId: activeCartId,
          productId: product.ProductID,
          quantity,
        });

        // Track add to cart event in Application Insights
        trackEvent("Product_AddToCart", {
          productId: product.ProductID,
          productName: product.Name,
          quantity: quantity,
          price: product.ListPrice,
          size: selectedSize,
          color: selectedColor,
        });

        toast({
          title: "Added to Cart!",
          description: `${displayName} is now in your cart`,
          action: (
            <ToastAction altText="View cart" asChild>
              <a href="/cart">View Cart</a>
            </ToastAction>
          ),
        });
      } catch (error) {
        trackError("Failed to add item to cart", error, {
          component: "CartContext",
          productId: product.ProductID,
          quantity: quantity,
        });
        toast({
          title: "Error",
          description: "Failed to add item to cart. Please try again.",
          variant: "destructive",
        });
      }
  };

  const removeFromCart = async (
    productId: number,
    selectedSize?: string,
    selectedColor?: string,
  ) => {
    if (!shoppingCartId) return;

    const item = items.find(
      (i) =>
        i.ProductID === productId &&
        i.selectedSize === selectedSize &&
        i.selectedColor === selectedColor,
    );

    if (item && "ShoppingCartItemID" in item) {
      const displayName =
        selectedSize || selectedColor
          ? `${item.Name}${selectedSize ? ` (${selectedSize})` : ""}${
              selectedColor ? ` - ${selectedColor}` : ""
            }`
          : item.Name;

      await deleteCartMutation.mutateAsync({
        shoppingCartItemId: (item as CartItem & { ShoppingCartItemID: number })
          .ShoppingCartItemID,
        shoppingCartId,
      });

      toast({
        title: "Removed from Cart",
        description: `${displayName} has been removed`,
      });
    }
  };

  const updateQuantity = async (
    productId: number,
    quantity: number,
    selectedSize?: string,
    selectedColor?: string,
  ) => {
    if (!shoppingCartId) return;

    if (quantity <= 0) {
      await removeFromCart(productId, selectedSize, selectedColor);
      return;
    }

    const item = items.find(
      (i) =>
        i.ProductID === productId &&
        i.selectedSize === selectedSize &&
        i.selectedColor === selectedColor,
    );

    if (item && "ShoppingCartItemID" in item) {
      await updateCartMutation.mutateAsync({
        shoppingCartItemId: (item as CartItem & { ShoppingCartItemID: number })
          .ShoppingCartItemID,
        quantity,
        shoppingCartId,
      });
    }
  };

  const clearCart = async () => {
    if (!shoppingCartId) return;

    await clearCartMutation.mutateAsync(shoppingCartId);

    toast({
      title: "Cart Cleared",
      description: "All items have been removed from your cart",
    });
  };

  const getTotalItems = () => {
    return items.reduce((total, item) => total + item.quantity, 0);
  };

  // Get total price with sale prices applied
  const getTotalPrice = () => {
    return items.reduce((total, item) => {
      const salePrice = getSalePrice(item);
      const price = salePrice !== null ? salePrice : item.ListPrice;
      return total + price * item.quantity;
    }, 0);
  };

  // Get original price without discounts
  const getOriginalPrice = () => {
    return items.reduce(
      (total, item) => total + item.ListPrice * item.quantity,
      0,
    );
  };

  // Get total discount amount
  const getTotalDiscount = () => {
    return items.reduce((total, item) => {
      const salePrice = getSalePrice(item);
      if (salePrice !== null) {
        return total + (item.ListPrice - salePrice) * item.quantity;
      }
      return total;
    }, 0);
  };

  return (
    <CartContext.Provider
      value={{
        items,
        isLoading,
        error: mergeError || cartError?.message || null,
        canRetryGuestMerge: mergeError !== null,
        retryGuestMerge: () => { void retryGuestMerge(); },
        addToCart,
        removeFromCart,
        updateQuantity,
        clearCart,
        getTotalItems,
        getTotalPrice,
        getOriginalPrice,
        getTotalDiscount,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error("useCart must be used within a CartProvider");
  }
  return context;
};
