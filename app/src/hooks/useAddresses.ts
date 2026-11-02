import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { getRestApiUrl, getFunctionsApiUrl } from "@/lib/utils";
import { dabFetch } from "@/lib/dabFetch";
import { functionsFetch } from "@/services/functionsAuth";
import { trackError } from "@/lib/appInsights";

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

// API response type from Functions API (camelCase from C# JSON serialization)
interface ApiAddress {
  addressID: number;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvinceID: number;
  postalCode: string;
  rowguid: string;
  modifiedDate: string;
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

const DEFAULT_ADDRESS_TYPE_ID = 2; // Home
const SHIPPING_ADDRESS_TYPE_ID = 3;

const addressTypeIdFor = (label?: string): number | undefined => {
  const entry = Object.entries(ADDRESS_TYPE_MAP).find(([, l]) => l === label);
  return entry ? Number(entry[0]) : undefined;
};

/**
 * Atomically sets an address's type via the Functions API. Setting Home (2) makes it the
 * owner's single default and demotes any other default to Shipping (3).
 */
const putAddressType = async (addressId: number, addressTypeId: number) => {
  const response = await functionsFetch(
    `${getFunctionsApiUrl()}/api/addresses/${addressId}/type`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ AddressTypeID: addressTypeId }),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to update address type: ${response.status} ${errorText}`,
    );
  }
};

/**
 * Loads the owner's addresses. An address can have several BusinessEntityAddress links (one per
 * type); it is listed once and is the default when any of its links is Home (2).
 */
const loadAddresses = async (businessEntityId: number): Promise<Address[]> => {
  const dabApiUrl = getRestApiUrl();
  const response = await dabFetch(
    `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${businessEntityId}`,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch business entity addresses (HTTP ${response.status})`,
    );
  }

  const data = await response.json();
  const businessEntityAddresses: BusinessEntityAddress[] = data.value || [];

  const typeByAddress = new Map<number, number>();
  for (const bea of businessEntityAddresses) {
    if (
      !typeByAddress.has(bea.AddressID) ||
      bea.AddressTypeID === DEFAULT_ADDRESS_TYPE_ID
    ) {
      typeByAddress.set(bea.AddressID, bea.AddressTypeID);
    }
  }

  const functionsApiUrl = getFunctionsApiUrl();
  const addressPromises = [...typeByAddress.entries()].map(
    async ([addressId, addressTypeId]) => {
      try {
        const addrResponse = await functionsFetch(
          `${functionsApiUrl}/api/addresses/${addressId}`,
        );
        if (!addrResponse.ok) return null;

        const apiAddress: ApiAddress = await addrResponse.json();

        // Fetch StateProvince to get the code and country
        let stateCode = apiAddress.stateProvinceID.toString();
        let countryCode: string | undefined;
        let countryName: string | undefined;

        try {
          const stateResponse = await dabFetch(
            `${dabApiUrl}/StateProvince/StateProvinceID/${apiAddress.stateProvinceID}`,
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
                const countryResponse = await dabFetch(
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
                trackError("Failed to fetch CountryRegion", error as Error, {
                  hook: "useAddresses",
                  context: "fetchAddresses",
                  countryCode,
                });
              }
            }
          }
        } catch (error) {
          trackError("Failed to fetch StateProvince", error as Error, {
            hook: "useAddresses",
            context: "fetchAddresses",
            stateProvinceID: apiAddress.stateProvinceID,
          });
        }

        return {
          id: apiAddress.addressID.toString(),
          addressLine1: apiAddress.addressLine1,
          addressLine2: apiAddress.addressLine2 || undefined,
          city: apiAddress.city,
          stateProvinceId: apiAddress.stateProvinceID,
          stateProvinceCode: stateCode,
          countryRegionCode: countryCode,
          countryName: countryName,
          postalCode: apiAddress.postalCode,
          addressType: ADDRESS_TYPE_MAP[addressTypeId] || "Other",
          isDefault: addressTypeId === DEFAULT_ADDRESS_TYPE_ID,
        } as Address;
      } catch (error) {
        trackError("Failed to fetch address", error as Error, {
          hook: "useAddresses",
          context: "fetchAddresses",
          addressID: addressId,
        });
        return null;
      }
    },
  );

  return (await Promise.all(addressPromises))
    .filter((addr): addr is Address => addr !== null)
    .sort((a, b) => parseInt(a.id) - parseInt(b.id));
};

export const useAddresses = () => {
  const { user } = useAuth();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const lastHealKeyRef = useRef<string | null>(null);

  // Fetch addresses from both APIs
  const fetchAddresses = useCallback(async () => {
    if (!user?.businessEntityId) {
      return;
    }

    setIsLoading(true);
    try {
      let fetchedAddresses = await loadAddresses(user.businessEntityId);

      // Enforce exactly one default. Older data may have none or several (e.g. addresses
      // created before the single-default rule); keep the earliest as the default.
      const defaults = fetchedAddresses.filter((a) => a.isDefault);
      if (fetchedAddresses.length > 0 && defaults.length !== 1) {
        const healKey = fetchedAddresses
          .map((a) => `${a.id}:${a.isDefault ? 1 : 0}`)
          .join(",");
        if (lastHealKeyRef.current !== healKey) {
          lastHealKeyRef.current = healKey;
          const candidates = defaults.length > 0 ? defaults : fetchedAddresses;
          const keepId = Math.min(...candidates.map((a) => parseInt(a.id)));
          try {
            await putAddressType(keepId, DEFAULT_ADDRESS_TYPE_ID);
            fetchedAddresses = await loadAddresses(user.businessEntityId);
          } catch (error) {
            trackError("Failed to normalize default address", error as Error, {
              hook: "useAddresses",
              context: "fetchAddresses",
              businessEntityId: user.businessEntityId,
            });
          }
        }
      }

      setAddresses(fetchedAddresses);
    } catch (error) {
      trackError("Error fetching addresses", error as Error, {
        hook: "useAddresses",
        context: "fetchAddresses",
        businessEntityId: user?.businessEntityId,
      });
      setAddresses([]);
    } finally {
      setIsLoading(false);
    }
  }, [user?.businessEntityId]);

  useEffect(() => {
    fetchAddresses();
  }, [fetchAddresses]);

  const addAddress = useCallback(
    async (address: Omit<Address, "id">): Promise<string | undefined> => {
      if (!user?.businessEntityId) return undefined;

      setIsLoading(true);
      try {
        const functionsApiUrl = getFunctionsApiUrl();
        // The server makes the first address the default and keeps exactly one default.
        const requestedTypeId =
          addressTypeIdFor(address.addressType) ?? SHIPPING_ADDRESS_TYPE_ID;
        const addressTypeId = address.isDefault
          ? DEFAULT_ADDRESS_TYPE_ID
          : requestedTypeId === DEFAULT_ADDRESS_TYPE_ID
            ? SHIPPING_ADDRESS_TYPE_ID
            : requestedTypeId;

        // Create address via Functions API (with BusinessEntityID to create link automatically)
        const response = await functionsFetch(
          `${functionsApiUrl}/api/addresses`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              AddressLine1: address.addressLine1,
              AddressLine2: address.addressLine2 || null,
              City: address.city,
              StateProvinceID: address.stateProvinceId,
              PostalCode: address.postalCode,
              BusinessEntityID: user.businessEntityId,
              AddressTypeID: addressTypeId,
            }),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          trackError("Failed to create address", new Error(errorText), {
            hook: "useAddresses",
            context: "addAddress",
            status: response.status,
            businessEntityId: user.businessEntityId,
          });
          throw new Error(
            `Failed to create address: ${response.status} ${errorText}`,
          );
        }

        const createdAddress: ApiAddress = await response.json();

        // Refresh addresses to show the newly created address
        await fetchAddresses();

        // Return the new address ID so checkout can use it for the order
        const newId = createdAddress.addressID;
        return newId != null ? String(newId) : undefined;
      } catch (error) {
        trackError("Error adding address", error as Error, {
          hook: "useAddresses",
          context: "addAddress",
          businessEntityId: user?.businessEntityId,
        });
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

          const response = await functionsFetch(
            `${functionsApiUrl}/api/addresses/${addressId}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(updatePayload),
            },
          );

          if (!response.ok) throw new Error("Failed to update address");
        }

        // Default changes are atomic server-side. The current default keeps its type until
        // another address is made the default.
        const current = addresses.find((addr) => addr.id === id);
        if (!current?.isDefault) {
          const requestedTypeId = addressTypeIdFor(updates.addressType);
          if (
            updates.isDefault ||
            requestedTypeId === DEFAULT_ADDRESS_TYPE_ID
          ) {
            await putAddressType(addressId, DEFAULT_ADDRESS_TYPE_ID);
          } else if (
            requestedTypeId &&
            updates.addressType !== current?.addressType
          ) {
            await putAddressType(addressId, requestedTypeId);
          }
        }

        // Refresh addresses
        await fetchAddresses();
      } catch (error) {
        trackError("Error updating address", error as Error, {
          hook: "useAddresses",
          context: "updateAddress",
          addressId: id,
          businessEntityId: user?.businessEntityId,
        });
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [user?.businessEntityId, addresses, fetchAddresses],
  );

  const deleteAddress = useCallback(
    async (id: string) => {
      if (!user?.businessEntityId) return;

      setIsLoading(true);
      try {
        const addressId = parseInt(id);
        const dabApiUrl = getRestApiUrl();

        // First, find the AddressTypeID for this BusinessEntityAddress
        const beaResponse = await dabFetch(
          `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${user.businessEntityId} and AddressID eq ${addressId}`,
        );

        if (beaResponse.ok) {
          const beaData = await beaResponse.json();
          const links: BusinessEntityAddress[] = beaData.value || [];

          // Delete every BusinessEntityAddress link so the Address row can be removed
          for (const bea of links) {
            await dabFetch(
              `${dabApiUrl}/BusinessEntityAddress/BusinessEntityID/${user.businessEntityId}/AddressID/${addressId}/AddressTypeID/${bea.AddressTypeID}`,
              { method: "DELETE" },
            );
          }
        }

        // Delete address from Functions API
        const functionsApiUrl = getFunctionsApiUrl();
        await functionsFetch(`${functionsApiUrl}/api/addresses/${addressId}`, {
          method: "DELETE",
        });

        // Refresh addresses
        await fetchAddresses();
      } catch (error) {
        trackError("Error deleting address", error as Error, {
          hook: "useAddresses",
          context: "deleteAddress",
          addressId: id,
          businessEntityId: user?.businessEntityId,
        });
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [user?.businessEntityId, fetchAddresses],
  );

  const setDefaultAddress = useCallback(
    async (id: string) => {
      if (!user?.businessEntityId) return;

      setIsLoading(true);
      try {
        await putAddressType(parseInt(id), DEFAULT_ADDRESS_TYPE_ID);

        // Refresh addresses to reflect changes
        await fetchAddresses();
      } catch (error) {
        trackError("Error setting default address", error as Error, {
          hook: "useAddresses",
          context: "setDefaultAddress",
          addressId: id,
          businessEntityId: user?.businessEntityId,
        });
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [user?.businessEntityId, fetchAddresses],
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
