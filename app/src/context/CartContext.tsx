import React, { createContext, useContext, useMemo, ReactNode } from "react";
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
import { trackEvent } from "@/lib/appInsights";
import { useProducts } from "@/hooks/useProducts";

interface CartContextType {
  items: CartItem[];
  isLoading: boolean;
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
  const shoppingCartId = user?.businessEntityId?.toString() || null;

  // Fetch cart items from API
  const { data: cartItems = [], isLoading: cartLoading } =
    useShoppingCart(shoppingCartId);
  const { data: allProducts = [], isLoading: productsLoading } = useProducts();

  // Mutations
  const addToCartMutation = useAddToCart();
  const updateCartMutation = useUpdateCartItem();
  const deleteCartMutation = useDeleteCartItem();
  const clearCartMutation = useClearCart();

  const isLoading = cartLoading || productsLoading;

  // Combine cart items with product details to create CartItem objects
  const items = useMemo<CartItem[]>(() => {
    if (!cartItems.length || !allProducts.length) return [];

    return cartItems
      .map((cartItem) => {
        const product = allProducts.find(
          (p) => p.ProductID === cartItem.ProductID,
        );
        if (!product) return null;

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
  }, [cartItems, allProducts]);

  const addToCart = async (
    product: Product,
    quantity: number = 1,
    selectedSize?: string,
    selectedColor?: string,
  ) => {
    if (!shoppingCartId) {
      toast({
        title: "Please Sign In",
        description: "You need to be signed in to add items to your cart",
        variant: "destructive",
      });
      return;
    }

    const displayName =
      selectedSize || selectedColor
        ? `${product.Name}${selectedSize ? ` (${selectedSize})` : ""}${
            selectedColor ? ` - ${selectedColor}` : ""
          }`
        : product.Name;

    // Check if item already exists in cart
    const existingItem = items.find(
      (item) =>
        item.ProductID === product.ProductID &&
        item.selectedSize === selectedSize &&
        item.selectedColor === selectedColor,
    );

    if (existingItem && "ShoppingCartItemID" in existingItem) {
      // Update existing item quantity
      const newQuantity = existingItem.quantity + quantity;
      try {
        await updateCartMutation.mutateAsync({
          shoppingCartItemId: (
            existingItem as CartItem & { ShoppingCartItemID: number }
          ).ShoppingCartItemID,
          quantity: newQuantity,
          shoppingCartId,
        });

        toast({
          title: "Cart Updated!",
          description: `Added another ${displayName} to your cart`,
          action: (
            <ToastAction altText="View cart" asChild>
              <a href="/cart">View Cart</a>
            </ToastAction>
          ),
        });
      } catch (error) {
        console.error("Failed to update cart item:", error);
        toast({
          title: "Error",
          description: "Failed to update cart. Please try again.",
          variant: "destructive",
        });
      }
    } else {
      // Add new item to cart
      try {
        await addToCartMutation.mutateAsync({
          shoppingCartId,
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
        console.error("Failed to add item to cart:", error);
        toast({
          title: "Error",
          description: "Failed to add item to cart. Please try again.",
          variant: "destructive",
        });
      }
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
