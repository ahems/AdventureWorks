import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';

export interface Address {
  id: string;
  label: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  isDefault: boolean;
}

const ADDRESSES_KEY = 'user_addresses';

const getStoredAddresses = (userId: string): Address[] => {
  const data = localStorage.getItem(`${ADDRESSES_KEY}_${userId}`);
  return data ? JSON.parse(data) : [];
};

const saveAddresses = (userId: string, addresses: Address[]) => {
  localStorage.setItem(`${ADDRESSES_KEY}_${userId}`, JSON.stringify(addresses));
};

export const useAddresses = () => {
  const { user } = useAuth();
  const [addresses, setAddresses] = useState<Address[]>([]);

  useEffect(() => {
    if (user?.id) {
      setAddresses(getStoredAddresses(user.id));
    }
  }, [user?.id]);

  const addAddress = useCallback((address: Omit<Address, 'id'>) => {
    if (!user?.id) return;
    
    const newAddress: Address = {
      ...address,
      id: `addr_${Date.now()}`,
    };
    
    let updatedAddresses = [...addresses];
    
    // If this is the first address or marked as default, set it as default
    if (updatedAddresses.length === 0 || address.isDefault) {
      updatedAddresses = updatedAddresses.map(a => ({ ...a, isDefault: false }));
      newAddress.isDefault = true;
    }
    
    updatedAddresses.push(newAddress);
    setAddresses(updatedAddresses);
    saveAddresses(user.id, updatedAddresses);
    
    return newAddress;
  }, [user?.id, addresses]);

  const updateAddress = useCallback((id: string, updates: Partial<Address>) => {
    if (!user?.id) return;
    
    let updatedAddresses = addresses.map(addr => 
      addr.id === id ? { ...addr, ...updates } : addr
    );
    
    // If setting as default, unset others
    if (updates.isDefault) {
      updatedAddresses = updatedAddresses.map(addr => ({
        ...addr,
        isDefault: addr.id === id,
      }));
    }
    
    setAddresses(updatedAddresses);
    saveAddresses(user.id, updatedAddresses);
  }, [user?.id, addresses]);

  const deleteAddress = useCallback((id: string) => {
    if (!user?.id) return;
    
    let updatedAddresses = addresses.filter(addr => addr.id !== id);
    
    // If we deleted the default, make the first one default
    if (updatedAddresses.length > 0 && !updatedAddresses.some(a => a.isDefault)) {
      updatedAddresses[0].isDefault = true;
    }
    
    setAddresses(updatedAddresses);
    saveAddresses(user.id, updatedAddresses);
  }, [user?.id, addresses]);

  const setDefaultAddress = useCallback((id: string) => {
    if (!user?.id) return;
    
    const updatedAddresses = addresses.map(addr => ({
      ...addr,
      isDefault: addr.id === id,
    }));
    
    setAddresses(updatedAddresses);
    saveAddresses(user.id, updatedAddresses);
  }, [user?.id, addresses]);

  const getDefaultAddress = useCallback(() => {
    return addresses.find(addr => addr.isDefault) || addresses[0] || null;
  }, [addresses]);

  return {
    addresses,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
    getDefaultAddress,
  };
};
