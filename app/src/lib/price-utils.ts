// Utility functions for price display with currency conversion
// Import and use formatPrice from CurrencyContext for consistent pricing

/**
 * Price formatting component that uses currency context
 * Use this instead of manual price formatting throughout the app
 */
export interface PriceDisplayProps {
  price: number;
  className?: string;
  showCurrency?: boolean;
}

// This will be replaced with actual implementation using useCurrency hook
// Individual components should import useCurrency and use formatPrice directly
