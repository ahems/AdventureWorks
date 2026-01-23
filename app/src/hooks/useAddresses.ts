import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { getRestApiUrl, getFunctionsApiUrl } from "@/lib/utils";

export interface Address {
  id: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateProvinceId: number;
  stateProvinceCode?: string; // e.g., "WA", "CA", "NY"
  countryRegionCode?: string; // e.g., "US", "CA", "GB"
  countryName?: string; // e.g., "United States"
  postalCode: string;
  addressType: string;
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

// BusinessEntityAddress from DAB
interface BusinessEntityAddress {
  BusinessEntityID: number;
  AddressID: number;
  AddressTypeID: number;
  rowguid: string;
  ModifiedDate: string;
}

// Address type lookup
const ADDRESS_TYPE_MAP: Record<number, string> = {
  1: "Archive",
  2: "Home",
  3: "Shipping",
  4: "Billing",
  5: "Main Office",
  6: "Primary",
};

export const useAddresses = () => {
  const { user } = useAuth();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch addresses from both APIs
  const fetchAddresses = useCallback(async () => {
    if (!user?.businessEntityId) {
      console.log("[useAddresses] No businessEntityId found for user:", user);
      return;
    }

    console.log(
      "[useAddresses] Fetching addresses for businessEntityId:",
      user.businessEntityId,
    );
    setIsLoading(true);
    try {
      const dabApiUrl = getRestApiUrl();

      // Get BusinessEntityAddress links from DAB
      const url = `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${user.businessEntityId}`;
      console.log("[useAddresses] Fetching BusinessEntityAddress from:", url);
      const response = await fetch(url);

      if (!response.ok) {
        console.error(
          "[useAddresses] Failed to fetch business entity addresses, status:",
          response.status,
        );
        setAddresses([]);
        return;
      }

      const data = await response.json();
      console.log("[useAddresses] BusinessEntityAddress data:", data);
      const businessEntityAddresses: BusinessEntityAddress[] = data.value || [];

      if (businessEntityAddresses.length === 0) {
        console.log("[useAddresses] No addresses found for this user");
        setAddresses([]);
        return;
      }

      console.log(
        "[useAddresses] Found",
        businessEntityAddresses.length,
        "linked addresses",
      );
      // Fetch each address from Functions API
      const functionsApiUrl = getFunctionsApiUrl();
      const addressPromises = businessEntityAddresses.map(async (bea) => {
        try {
          const addrResponse = await fetch(
            `${functionsApiUrl}/api/addresses/${bea.AddressID}`,
          );
          if (!addrResponse.ok) return null;

          const apiAddress: ApiAddress = await addrResponse.json();

          // Fetch StateProvince to get the code and country
          let stateCode = apiAddress.StateProvinceID.toString();
          let countryCode: string | undefined;
          let countryName: string | undefined;

          try {
            const stateResponse = await fetch(
              `${dabApiUrl}/StateProvince/StateProvinceID/${apiAddress.StateProvinceID}`,
            );
            if (stateResponse.ok) {
              const stateData = await stateResponse.json();
              const stateProvince = stateData.value?.[0];
              if (stateProvince?.StateProvinceCode) {
                stateCode = stateProvince.StateProvinceCode.trim();
              }
              if (stateProvince?.CountryRegionCode) {
                countryCode = stateProvince.CountryRegionCode;

                // Fetch CountryRegion to get the name
                try {
                  const countryResponse = await fetch(
                    `${dabApiUrl}/CountryRegion/CountryRegionCode/${countryCode}`,
                  );
                  if (countryResponse.ok) {
                    const countryData = await countryResponse.json();
                    const country = countryData.value?.[0];
                    if (country?.Name) {
                      countryName = country.Name;
                    }
                  }
                } catch (error) {
                  console.error(
                    `Failed to fetch CountryRegion ${countryCode}:`,
                    error,
                  );
                }
              }
            }
          } catch (error) {
            console.error(
              `Failed to fetch StateProvince ${apiAddress.StateProvinceID}:`,
              error,
            );
          }

          // Map to frontend format
          return {
            id: apiAddress.AddressID.toString(),
            addressLine1: apiAddress.AddressLine1,
            addressLine2: apiAddress.AddressLine2 || undefined,
            city: apiAddress.City,
            stateProvinceId: apiAddress.StateProvinceID,
            stateProvinceCode: stateCode,
            countryRegionCode: countryCode,
            countryName: countryName,
            postalCode: apiAddress.PostalCode,
            addressType: ADDRESS_TYPE_MAP[bea.AddressTypeID] || "Other",
            isDefault: bea.AddressTypeID === 2, // Home is default
          } as Address;
        } catch (error) {
          console.error(`Failed to fetch address ${bea.AddressID}:`, error);
          return null;
        }
      });

      const fetchedAddresses = (await Promise.all(addressPromises)).filter(
        (addr): addr is Address => addr !== null,
      );
      setAddresses(fetchedAddresses);
    } catch (error) {
      console.error("Error fetching addresses:", error);
      setAddresses([]);
    } finally {
      setIsLoading(false);
    }
  }, [user?.businessEntityId]);

  useEffect(() => {
    fetchAddresses();
  }, [fetchAddresses]);

  const addAddress = useCallback(
    async (address: Omit<Address, "id">) => {
      if (!user?.businessEntityId) return;

      setIsLoading(true);
      try {
        const functionsApiUrl = getFunctionsApiUrl();

        // Parse address type from addressType
        const addressTypeId =
          Object.entries(ADDRESS_TYPE_MAP).find(
            ([_, label]) => label === address.addressType,
          )?.[0] || "2"; // Default to Home

        // Create address via Functions API (with BusinessEntityID to create link automatically)
        const response = await fetch(`${functionsApiUrl}/api/addresses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            AddressLine1: address.addressLine1,
            AddressLine2: address.addressLine2 || null,
            City: address.city,
            StateProvinceID: address.stateProvinceId,
            PostalCode: address.postalCode,
            BusinessEntityID: user.businessEntityId,
            AddressTypeID: parseInt(addressTypeId),
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            "Failed to create address:",
            response.status,
            errorText,
          );
          throw new Error(
            `Failed to create address: ${response.status} ${errorText}`,
          );
        }

        const createdAddress: ApiAddress = await response.json();

        // Refresh addresses to show the newly created address
        await fetchAddresses();
      } catch (error) {
        console.error("Error adding address:", error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [user?.businessEntityId, fetchAddresses],
  );

  const updateAddress = useCallback(
    async (id: string, updates: Partial<Address>) => {
      if (!user?.businessEntityId) return;

      setIsLoading(true);
      try {
        const addressId = parseInt(id);
        const functionsApiUrl = getFunctionsApiUrl();

        // Update address via Functions API if address fields changed
        if (
          updates.addressLine1 ||
          updates.addressLine2 !== undefined ||
          updates.city ||
          updates.stateProvinceId ||
          updates.postalCode
        ) {
          const updatePayload: any = {};

          if (updates.addressLine1)
            updatePayload.AddressLine1 = updates.addressLine1;
          if (updates.addressLine2 !== undefined)
            updatePayload.AddressLine2 = updates.addressLine2 || null;
          if (updates.city) updatePayload.City = updates.city;
          if (updates.stateProvinceId)
            updatePayload.StateProvinceID = updates.stateProvinceId;
          if (updates.postalCode) updatePayload.PostalCode = updates.postalCode;

          const response = await fetch(
            `${functionsApiUrl}/api/addresses/${addressId}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(updatePayload),
            },
          );

          if (!response.ok) throw new Error("Failed to update address");
        }

        // If addressType changed, update AddressTypeID via DAB
        if (updates.addressType) {
          const newAddressTypeId = Object.entries(ADDRESS_TYPE_MAP).find(
            ([_, label]) => label === updates.addressType,
          )?.[0];

          if (newAddressTypeId) {
            const dabApiUrl = getRestApiUrl();
            await fetch(
              `${dabApiUrl}/BusinessEntityAddress/BusinessEntityID/${user.businessEntityId}/AddressID/${addressId}/AddressTypeID/${newAddressTypeId}`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  AddressTypeID: parseInt(newAddressTypeId),
                }),
              },
            );
          }
        }

        // Refresh addresses
        await fetchAddresses();
      } catch (error) {
        console.error("Error updating address:", error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [user?.businessEntityId, fetchAddresses],
  );

  const deleteAddress = useCallback(
    async (id: string) => {
      if (!user?.businessEntityId) return;

      setIsLoading(true);
      try {
        const addressId = parseInt(id);
        const dabApiUrl = getRestApiUrl();

        // First, find the AddressTypeID for this BusinessEntityAddress
        const beaResponse = await fetch(
          `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${user.businessEntityId} and AddressID eq ${addressId}`,
        );

        if (beaResponse.ok) {
          const beaData = await beaResponse.json();
          const bea = beaData.value?.[0] as BusinessEntityAddress;

          if (bea) {
            // Delete BusinessEntityAddress link
            await fetch(
              `${dabApiUrl}/BusinessEntityAddress/BusinessEntityID/${user.businessEntityId}/AddressID/${addressId}/AddressTypeID/${bea.AddressTypeID}`,
              { method: "DELETE" },
            );
          }
        }

        // Delete address from Functions API
        const functionsApiUrl = getFunctionsApiUrl();
        await fetch(`${functionsApiUrl}/api/addresses/${addressId}`, {
          method: "DELETE",
        });

        // Refresh addresses
        await fetchAddresses();
      } catch (error) {
        console.error("Error deleting address:", error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [user?.businessEntityId, fetchAddresses],
  );

  const setDefaultAddress = useCallback(
    async (id: string) => {
      // In this implementation, we use AddressTypeID = 2 (Home) as the default
      // To change default, we could update the AddressTypeID of the addresses
      // For now, just refresh to re-sort
      await fetchAddresses();
    },
    [fetchAddresses],
  );

  const getDefaultAddress = useCallback(() => {
    return addresses.find((addr) => addr.isDefault) || addresses[0] || null;
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
