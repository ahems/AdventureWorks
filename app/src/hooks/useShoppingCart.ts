import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as apiService from "@/data/apiService";
import { ShoppingCartItem, Product } from "@/types/product";

// Hook to fetch shopping cart items
export const useShoppingCart = (shoppingCartId: string | null) => {
  return useQuery<ShoppingCartItem[]>({
    queryKey: ["shoppingCart", shoppingCartId],
    queryFn: () => apiService.getShoppingCartItems(shoppingCartId!),
    enabled: !!shoppingCartId,
    staleTime: 0, // Always fetch fresh data
    refetchOnMount: "always", // Force refetch when component mounts
  });
};

// Hook to add item to cart
export const useAddToCart = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      shoppingCartId,
      productId,
      quantity,
    }: {
      shoppingCartId: string;
      productId: number;
      quantity: number;
    }) => apiService.createCartItem(shoppingCartId, productId, quantity),
    onMutate: async ({ shoppingCartId, productId, quantity }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: ["shoppingCart", shoppingCartId],
      });

      // Snapshot previous value
      const previousCart = queryClient.getQueryData<ShoppingCartItem[]>([
        "shoppingCart",
        shoppingCartId,
      ]);

      // Optimistically update to the new value
      if (previousCart) {
        const optimisticItem: ShoppingCartItem = {
          ShoppingCartItemID: Date.now(), // Temporary ID
          ShoppingCartID: shoppingCartId,
          ProductID: productId,
          Quantity: quantity,
          DateCreated: new Date().toISOString(),
          ModifiedDate: new Date().toISOString(),
        };
        queryClient.setQueryData<ShoppingCartItem[]>(
          ["shoppingCart", shoppingCartId],
          [...previousCart, optimisticItem],
        );
      }

      return { previousCart };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousCart) {
        queryClient.setQueryData(
          ["shoppingCart", variables.shoppingCartId],
          context.previousCart,
        );
      }
    },
    onSettled: (_, __, variables) => {
      // Always refetch after error or success
      queryClient.invalidateQueries({
        queryKey: ["shoppingCart", variables.shoppingCartId],
      });
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
      shoppingCartId,
    }: {
      shoppingCartItemId: number;
      quantity: number;
      shoppingCartId: string;
    }) => apiService.updateCartItemQuantity(shoppingCartItemId, quantity),
    onMutate: async ({ shoppingCartId, shoppingCartItemId, quantity }) => {
      await queryClient.cancelQueries({
        queryKey: ["shoppingCart", shoppingCartId],
      });

      const previousCart = queryClient.getQueryData<ShoppingCartItem[]>([
        "shoppingCart",
        shoppingCartId,
      ]);

      if (previousCart) {
        queryClient.setQueryData<ShoppingCartItem[]>(
          ["shoppingCart", shoppingCartId],
          previousCart.map((item) =>
            item.ShoppingCartItemID === shoppingCartItemId
              ? {
                  ...item,
                  Quantity: quantity,
                  ModifiedDate: new Date().toISOString(),
                }
              : item,
          ),
        );
      }

      return { previousCart };
    },
    onError: (err, variables, context) => {
      if (context?.previousCart) {
        queryClient.setQueryData(
          ["shoppingCart", variables.shoppingCartId],
          context.previousCart,
        );
      }
    },
    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["shoppingCart", variables.shoppingCartId],
      });
    },
  });
};

// Hook to delete cart item
export const useDeleteCartItem = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      shoppingCartItemId,
      shoppingCartId,
    }: {
      shoppingCartItemId: number;
      shoppingCartId: string;
    }) => apiService.deleteCartItem(shoppingCartItemId),
    onMutate: async ({ shoppingCartId, shoppingCartItemId }) => {
      await queryClient.cancelQueries({
        queryKey: ["shoppingCart", shoppingCartId],
      });

      const previousCart = queryClient.getQueryData<ShoppingCartItem[]>([
        "shoppingCart",
        shoppingCartId,
      ]);

      if (previousCart) {
        queryClient.setQueryData<ShoppingCartItem[]>(
          ["shoppingCart", shoppingCartId],
          previousCart.filter(
            (item) => item.ShoppingCartItemID !== shoppingCartItemId,
          ),
        );
      }

      return { previousCart };
    },
    onError: (err, variables, context) => {
      if (context?.previousCart) {
        queryClient.setQueryData(
          ["shoppingCart", variables.shoppingCartId],
          context.previousCart,
        );
      }
    },
    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["shoppingCart", variables.shoppingCartId],
      });
    },
  });
};

// Hook to clear entire cart
export const useClearCart = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (shoppingCartId: string) =>
      apiService.clearShoppingCart(shoppingCartId),
    onSuccess: (_, shoppingCartId) => {
      queryClient.invalidateQueries({
        queryKey: ["shoppingCart", shoppingCartId],
      });
    },
  });
};
