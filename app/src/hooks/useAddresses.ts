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

// API response type from Functions API
interface ApiAddress {
  AddressID: number;
  AddressLine1: string;
  AddressLine2: string | null;
  City: string;
  StateProvinceID: number;
  PostalCode: string;
  rowguid: string;
  ModifiedDate: string;
}

// User address mapping stored in localStorage
interface UserAddressMapping {
  addressId: number;
  label: string;
  firstName: string;
  lastName: string;
  phone: string;
  country: string;
  isDefault: boolean;
}

const ADDRESSES_MAPPING_KEY = 'user_addresses_mapping';

const getUserAddressMappings = (userId: string): UserAddressMapping[] => {
  const data = localStorage.getItem(`${ADDRESSES_MAPPING_KEY}_${userId}`);
  return data ? JSON.parse(data) : [];
};

const saveUserAddressMappings = (userId: string, mappings: UserAddressMapping[]) => {
  localStorage.setItem(`${ADDRESSES_MAPPING_KEY}_${userId}`, JSON.stringify(mappings));
};

// Map API address to frontend Address type
const mapApiAddressToFrontend = (apiAddress: ApiAddress, mapping: UserAddressMapping): Address => {
  return {
    id: apiAddress.AddressID.toString(),
    label: mapping.label,
    firstName: mapping.firstName,
    lastName: mapping.lastName,
    phone: mapping.phone,
    address: apiAddress.AddressLine2 
      ? `${apiAddress.AddressLine1}, ${apiAddress.AddressLine2}`
      : apiAddress.AddressLine1,
    city: apiAddress.City,
    state: apiAddress.StateProvinceID.toString(), // TODO: Map StateProvinceID to state name
    zipCode: apiAddress.PostalCode,
    country: mapping.country,
    isDefault: mapping.isDefault,
  };
};

const getFunctionsApiUrl = (): string => {
  // Get Functions API URL from environment or config
  const functionsUrl = (window as any).APP_CONFIG?.API_FUNCTIONS_URL || 
                       import.meta.env.VITE_API_FUNCTIONS_URL || 
                       'http://localhost:7071';
  return functionsUrl;
};

export const useAddresses = () => {
  const { user } = useAuth();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch addresses from Functions API
  const fetchAddresses = useCallback(async () => {
    if (!user?.id) return;
    
    setIsLoading(true);
    try {
      const mappings = getUserAddressMappings(user.id);
      if (mappings.length === 0) {
        setAddresses([]);
        return;
      }

      const apiUrl = getFunctionsApiUrl();
      const addressPromises = mappings.map(async (mapping) => {
        const response = await fetch(`${apiUrl}/api/addresses/${mapping.addressId}`);
        if (!response.ok) {
          console.error(`Failed to fetch address ${mapping.addressId}`);
          return null;
        }
        const apiAddress: ApiAddress = await response.json();
        return mapApiAddressToFrontend(apiAddress, mapping);
      });

      const fetchedAddresses = (await Promise.all(addressPromises)).filter((addr): addr is Address => addr !== null);
      setAddresses(fetchedAddresses);
    } catch (error) {
      console.error('Error fetching addresses:', error);
      setAddresses([]);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchAddresses();
  }, [fetchAddresses]);

  const addAddress = useCallback(async (address: Omit<Address, 'id'>) => {
    if (!user?.id) return;
    
    setIsLoading(true);
    try {
      const apiUrl = getFunctionsApiUrl();
      
      // Create address via Functions API
      const response = await fetch(`${apiUrl}/api/addresses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          AddressLine1: address.address.split(',')[0].trim(),
          AddressLine2: address.address.includes(',') ? address.address.split(',').slice(1).join(',').trim() : null,
          City: address.city,
          StateProvinceID: parseInt(address.state) || 79, // Default to Washington if invalid
          PostalCode: address.zipCode,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create address');
      }

      const createdAddress: ApiAddress = await response.json();
      
      // Save mapping to localStorage
      const mappings = getUserAddressMappings(user.id);
      const newMapping: UserAddressMapping = {
        addressId: createdAddress.AddressID,
        label: address.label,
        firstName: address.firstName,
        lastName: address.lastName,
        phone: address.phone,
        country: address.country,
        isDefault: mappings.length === 0 || address.isDefault,
      };

      // If this is default, unset others
      const updatedMappings = newMapping.isDefault
        ? mappings.map(m => ({ ...m, isDefault: false }))
        : mappings;
      
      updatedMappings.push(newMapping);
      saveUserAddressMappings(user.id, updatedMappings);
      
      // Refresh addresses
      await fetchAddresses();
      
      return mapApiAddressToFrontend(createdAddress, newMapping);
    } catch (error) {
      console.error('Error adding address:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [user?.id, fetchAddresses]);

  const updateAddress = useCallback(async (id: string, updates: Partial<Address>) => {
    if (!user?.id) return;
    
    setIsLoading(true);
    try {
      const addressId = parseInt(id);
      const apiUrl = getFunctionsApiUrl();
      const mappings = getUserAddressMappings(user.id);
      const mapping = mappings.find(m => m.addressId === addressId);
      
      if (!mapping) {
        throw new Error('Address mapping not found');
      }

      // Update address via Functions API if address fields changed
      if (updates.address || updates.city || updates.state || updates.zipCode) {
        const addressParts = (updates.address || '').split(',');
        const response = await fetch(`${apiUrl}/api/addresses/${addressId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            AddressLine1: updates.address ? addressParts[0].trim() : undefined,
            AddressLine2: updates.address && addressParts.length > 1 ? addressParts.slice(1).join(',').trim() : undefined,
            City: updates.city,
            StateProvinceID: updates.state ? parseInt(updates.state) : undefined,
            PostalCode: updates.zipCode,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to update address');
        }
      }

      // Update mapping in localStorage
      const updatedMappings = mappings.map(m => {
        if (m.addressId === addressId) {
          return {
            ...m,
            label: updates.label ?? m.label,
            firstName: updates.firstName ?? m.firstName,
            lastName: updates.lastName ?? m.lastName,
            phone: updates.phone ?? m.phone,
            country: updates.country ?? m.country,
            isDefault: updates.isDefault !== undefined 
              ? updates.isDefault 
              : (updates.isDefault === true ? true : m.isDefault),
          };
        }
        // If setting another address as default, unset this one
        if (updates.isDefault === true && m.addressId !== addressId) {
          return { ...m, isDefault: false };
        }
        return m;
      });

      saveUserAddressMappings(user.id, updatedMappings);
      
      // Refresh addresses
      await fetchAddresses();
    } catch (error) {
      console.error('Error updating address:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [user?.id, fetchAddresses]);

  const deleteAddress = useCallback(async (id: string) => {
    if (!user?.id) return;
    
    setIsLoading(true);
    try {
      const addressId = parseInt(id);
      const apiUrl = getFunctionsApiUrl();

      // Delete address via Functions API
      const response = await fetch(`${apiUrl}/api/addresses/${addressId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete address');
      }

      // Remove mapping from localStorage
      let mappings = getUserAddressMappings(user.id);
      mappings = mappings.filter(m => m.addressId !== addressId);
      
      // If we deleted the default, make the first one default
      if (mappings.length > 0 && !mappings.some(m => m.isDefault)) {
        mappings[0].isDefault = true;
      }
      
      saveUserAddressMappings(user.id, mappings);
      
      // Refresh addresses
      await fetchAddresses();
    } catch (error) {
      console.error('Error deleting address:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [user?.id, fetchAddresses]);

  const setDefaultAddress = useCallback(async (id: string) => {
    if (!user?.id) return;
    
    try {
      const addressId = parseInt(id);
      const mappings = getUserAddressMappings(user.id);
      
      const updatedMappings = mappings.map(m => ({
        ...m,
        isDefault: m.addressId === addressId,
      }));
      
      saveUserAddressMappings(user.id, updatedMappings);
      
      // Refresh addresses
      await fetchAddresses();
    } catch (error) {
      console.error('Error setting default address:', error);
      throw error;
    }
  }, [user?.id, fetchAddresses]);

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
    isLoading,
  };
};
