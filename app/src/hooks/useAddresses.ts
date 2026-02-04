import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { getRestApiUrl, getFunctionsApiUrl } from "@/lib/utils";
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

export const useAddresses = () => {
  const { user } = useAuth();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch addresses from both APIs
  const fetchAddresses = useCallback(async () => {
    if (!user?.businessEntityId) {
      return;
    }

    setIsLoading(true);
    try {
      const dabApiUrl = getRestApiUrl();

      // Get BusinessEntityAddress links from DAB
      const url = `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${user.businessEntityId}`;
      const response = await fetch(url);

      if (!response.ok) {
        trackError(
          "Failed to fetch business entity addresses",
          new Error(`HTTP ${response.status}`),
          {
            hook: "useAddresses",
            context: "fetchAddresses",
            businessEntityId: user.businessEntityId,
            status: response.status,
          },
        );
        setAddresses([]);
        return;
      }

      const data = await response.json();
      const businessEntityAddresses: BusinessEntityAddress[] = data.value || [];

      if (businessEntityAddresses.length === 0) {
        setAddresses([]);
        return;
      }
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
          let stateCode = apiAddress.stateProvinceID.toString();
          let countryCode: string | undefined;
          let countryName: string | undefined;

          try {
            const stateResponse = await fetch(
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

          // Map to frontend format
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
            addressType: ADDRESS_TYPE_MAP[bea.AddressTypeID] || "Other",
            isDefault: bea.AddressTypeID === 2, // Home is default
          } as Address;
        } catch (error) {
          trackError("Failed to fetch address", error as Error, {
            hook: "useAddresses",
            context: "fetchAddresses",
            addressID: bea.AddressID,
          });
          return null;
        }
      });

      const fetchedAddresses = (await Promise.all(addressPromises)).filter(
        (addr): addr is Address => addr !== null,
      );
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
    async (address: Omit<Address, "id">) => {
      if (!user?.businessEntityId) return;

      setIsLoading(true);
      try {
        const functionsApiUrl = getFunctionsApiUrl();
        const dabApiUrl = getRestApiUrl();

        // Check if there's already a default address by querying the database
        const beaResponse = await fetch(
          `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${user.businessEntityId} and AddressTypeID eq 2`,
        );
        const beaData = await beaResponse.json();
        const hasDefaultAddress = beaData.value && beaData.value.length > 0;

        // Parse address type from addressType, but enforce single default rule
        let addressTypeId: string;
        const requestedTypeId = Object.entries(ADDRESS_TYPE_MAP).find(
          ([_, label]) => label === address.addressType,
        )?.[0];

        if (requestedTypeId === "2" && hasDefaultAddress) {
          // User requested Home (default) but there's already a default, use Shipping instead
          addressTypeId = "3";
        } else if (requestedTypeId) {
          // Use the requested type
          addressTypeId = requestedTypeId;
        } else {
          // No type specified, use Home (2) for first address, Shipping (3) otherwise
          addressTypeId = hasDefaultAddress ? "3" : "2";
        }

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
        const dabApiUrl = getRestApiUrl();
        const addressId = parseInt(id);

        // Find the current default address (AddressTypeID = 2 means Home/Default)
        const currentDefault = addresses.find((addr) => addr.isDefault);

        // Find the BusinessEntityAddress for the new default address
        const beaResponse = await fetch(
          `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${user.businessEntityId} and AddressID eq ${addressId}`,
        );

        if (!beaResponse.ok) {
          throw new Error("Failed to fetch BusinessEntityAddress");
        }

        const beaData = await beaResponse.json();
        const newDefaultBea = beaData.value?.[0] as BusinessEntityAddress;

        if (!newDefaultBea) {
          throw new Error("Address not found");
        }

        // If there's a current default that's different, change it away from Home (2)
        if (currentDefault && currentDefault.id !== id) {
          const currentAddressId = parseInt(currentDefault.id);
          const currentBeaResponse = await fetch(
            `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${user.businessEntityId} and AddressID eq ${currentAddressId}`,
          );

          if (currentBeaResponse.ok) {
            const currentBeaData = await currentBeaResponse.json();
            const currentBea = currentBeaData
              .value?.[0] as BusinessEntityAddress;

            if (currentBea && currentBea.AddressTypeID === 2) {
              // Delete the old Home (2) record
              const deleteResponse = await fetch(
                `${dabApiUrl}/BusinessEntityAddress/BusinessEntityID/${user.businessEntityId}/AddressID/${currentAddressId}/AddressTypeID/2`,
                {
                  method: "DELETE",
                },
              );

              if (!deleteResponse.ok) {
                const errorText = await deleteResponse.text();
                trackError(
                  "Failed to delete old default address",
                  new Error(errorText),
                  {
                    hook: "useAddresses",
                    context: "setDefaultAddress",
                    addressId: currentAddressId,
                    businessEntityId: user.businessEntityId,
                  },
                );
                throw new Error("Failed to remove old default address");
              }

              // Create new record with Shipping (3) type
              const createResponse = await fetch(
                `${dabApiUrl}/BusinessEntityAddress`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    BusinessEntityID: user.businessEntityId,
                    AddressID: currentAddressId,
                    AddressTypeID: 3, // Shipping
                  }),
                },
              );

              if (!createResponse.ok) {
                const errorText = await createResponse.text();
                trackError(
                  "Failed to create new record for old default address",
                  new Error(errorText),
                  {
                    hook: "useAddresses",
                    context: "setDefaultAddress",
                    addressId: currentAddressId,
                    businessEntityId: user.businessEntityId,
                  },
                );
                throw new Error("Failed to update old default address");
              }
            }
          }
        }

        // Change the new default address to Home (2) if it's not already
        if (newDefaultBea.AddressTypeID !== 2) {
          // Delete the old record
          const deleteResponse = await fetch(
            `${dabApiUrl}/BusinessEntityAddress/BusinessEntityID/${user.businessEntityId}/AddressID/${addressId}/AddressTypeID/${newDefaultBea.AddressTypeID}`,
            {
              method: "DELETE",
            },
          );

          if (!deleteResponse.ok) {
            const errorText = await deleteResponse.text();
            trackError(
              "Failed to delete old address record",
              new Error(errorText),
              {
                hook: "useAddresses",
                context: "setDefaultAddress",
                addressId,
                businessEntityId: user.businessEntityId,
              },
            );
            throw new Error("Failed to delete old address record");
          }

          // Create new record with Home (2) type
          const createResponse = await fetch(
            `${dabApiUrl}/BusinessEntityAddress`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                BusinessEntityID: user.businessEntityId,
                AddressID: addressId,
                AddressTypeID: 2, // Home (default)
              }),
            },
          );

          if (!createResponse.ok) {
            const errorText = await createResponse.text();
            trackError(
              "Failed to create new default address",
              new Error(errorText),
              {
                hook: "useAddresses",
                context: "setDefaultAddress",
                addressId,
                businessEntityId: user.businessEntityId,
              },
            );
            throw new Error("Failed to set new default address");
          }
        }

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
    [user?.businessEntityId, addresses, fetchAddresses],
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
