import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as apiService from '@/data/apiService';
import { ShoppingCartItem, Product } from '@/types/product';

// Hook to fetch shopping cart items
export const useShoppingCart = (shoppingCartId: string | null) => {
  return useQuery<ShoppingCartItem[]>({
    queryKey: ['shoppingCart', shoppingCartId],
    queryFn: () => apiService.getShoppingCartItems(shoppingCartId!),
    enabled: !!shoppingCartId,
    staleTime: 30 * 1000, // 30 seconds
  });
};

// Hook to add item to cart
export const useAddToCart = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({
      shoppingCartId,
      productId,
      quantity
    }: {
      shoppingCartId: string;
      productId: number;
      quantity: number;
    }) => apiService.createCartItem(shoppingCartId, productId, quantity),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['shoppingCart', variables.shoppingCartId] });
    },
  });
};

// Hook to update cart item quantity
export const useUpdateCartItem = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({
      shoppingCartItemId,
      quantity,
      shoppingCartId
    }: {
      shoppingCartItemId: number;
      quantity: number;
      shoppingCartId: string;
    }) => apiService.updateCartItemQuantity(shoppingCartItemId, quantity),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['shoppingCart', variables.shoppingCartId] });
    },
  });
};

// Hook to delete cart item
export const useDeleteCartItem = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({
      shoppingCartItemId,
      shoppingCartId
    }: {
      shoppingCartItemId: number;
      shoppingCartId: string;
    }) => apiService.deleteCartItem(shoppingCartItemId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['shoppingCart', variables.shoppingCartId] });
    },
  });
};

// Hook to clear entire cart
export const useClearCart = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (shoppingCartId: string) => apiService.clearShoppingCart(shoppingCartId),
    onSuccess: (_, shoppingCartId) => {
      queryClient.invalidateQueries({ queryKey: ['shoppingCart', shoppingCartId] });
    },
  });
};
