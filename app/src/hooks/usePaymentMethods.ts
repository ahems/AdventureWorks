import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';

export interface SavedPaymentMethod {
  id: string;
  type: 'card' | 'paypal';
  label: string;
  // For cards - only store masked info for security
  cardLast4?: string;
  cardBrand?: string;
  cardExpiry?: string;
  cardholderName?: string;
  // For PayPal
  paypalEmail?: string;
  isDefault: boolean;
}

const PAYMENT_METHODS_KEY = 'user_payment_methods';

const getStoredPaymentMethods = (userId: string): SavedPaymentMethod[] => {
  try {
    const data = localStorage.getItem(`${PAYMENT_METHODS_KEY}_${userId}`);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
};

const savePaymentMethods = (userId: string, methods: SavedPaymentMethod[]) => {
  localStorage.setItem(`${PAYMENT_METHODS_KEY}_${userId}`, JSON.stringify(methods));
};

// Detect card brand from number
const getCardBrand = (cardNumber: string): string => {
  const cleanNumber = cardNumber.replace(/\s/g, '');
  if (/^4/.test(cleanNumber)) return 'Visa';
  if (/^5[1-5]/.test(cleanNumber)) return 'Mastercard';
  if (/^3[47]/.test(cleanNumber)) return 'Amex';
  if (/^6(?:011|5)/.test(cleanNumber)) return 'Discover';
  return 'Card';
};

export const usePaymentMethods = () => {
  const { user } = useAuth();
  const [paymentMethods, setPaymentMethods] = useState<SavedPaymentMethod[]>([]);

  useEffect(() => {
    if (user?.id) {
      setPaymentMethods(getStoredPaymentMethods(user.id));
    }
  }, [user?.id]);

  const addPaymentMethod = useCallback((method: {
    type: 'card' | 'paypal';
    label?: string;
    cardNumber?: string;
    cardExpiry?: string;
    cardholderName?: string;
    paypalEmail?: string;
    isDefault?: boolean;
  }) => {
    if (!user?.id) return;

    const newMethod: SavedPaymentMethod = {
      id: `pm_${Date.now()}`,
      type: method.type,
      label: method.label || (method.type === 'card' ? 'Credit Card' : 'PayPal'),
      isDefault: method.isDefault || paymentMethods.length === 0,
    };

    if (method.type === 'card' && method.cardNumber) {
      const cleanNumber = method.cardNumber.replace(/\s/g, '');
      newMethod.cardLast4 = cleanNumber.slice(-4);
      newMethod.cardBrand = getCardBrand(method.cardNumber);
      newMethod.cardExpiry = method.cardExpiry;
      newMethod.cardholderName = method.cardholderName;
    } else if (method.type === 'paypal' && method.paypalEmail) {
      newMethod.paypalEmail = method.paypalEmail;
    }

    let updatedMethods = [...paymentMethods];

    // If this is the first or marked as default, unset other defaults
    if (newMethod.isDefault) {
      updatedMethods = updatedMethods.map(m => ({ ...m, isDefault: false }));
    }

    updatedMethods.push(newMethod);
    setPaymentMethods(updatedMethods);
    savePaymentMethods(user.id, updatedMethods);

    return newMethod;
  }, [user?.id, paymentMethods]);

  const deletePaymentMethod = useCallback((id: string) => {
    if (!user?.id) return;

    let updatedMethods = paymentMethods.filter(m => m.id !== id);

    // If we deleted the default, make the first one default
    if (updatedMethods.length > 0 && !updatedMethods.some(m => m.isDefault)) {
      updatedMethods[0].isDefault = true;
    }

    setPaymentMethods(updatedMethods);
    savePaymentMethods(user.id, updatedMethods);
  }, [user?.id, paymentMethods]);

  const setDefaultPaymentMethod = useCallback((id: string) => {
    if (!user?.id) return;

    const updatedMethods = paymentMethods.map(m => ({
      ...m,
      isDefault: m.id === id,
    }));

    setPaymentMethods(updatedMethods);
    savePaymentMethods(user.id, updatedMethods);
  }, [user?.id, paymentMethods]);

  const getDefaultPaymentMethod = useCallback(() => {
    return paymentMethods.find(m => m.isDefault) || paymentMethods[0] || null;
  }, [paymentMethods]);

  return {
    paymentMethods,
    addPaymentMethod,
    deletePaymentMethod,
    setDefaultPaymentMethod,
    getDefaultPaymentMethod,
  };
};
