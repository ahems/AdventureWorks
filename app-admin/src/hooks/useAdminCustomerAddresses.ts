import { useState, useEffect, useCallback } from "react";
import { getRestApiUrl, getFunctionsApiUrl } from "@/lib/utils";

export interface Address {
  id: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateProvinceId: number;
  stateProvinceCode?: string;
  countryRegionCode?: string;
  countryName?: string;
  postalCode: string;
  addressType: string;
  isDefault: boolean;
}

interface ApiAddress {
  addressID: number;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvinceID: number;
  postalCode: string;
}

interface BusinessEntityAddress {
  BusinessEntityID: number;
  AddressID: number;
  AddressTypeID: number;
}

const ADDRESS_TYPE_MAP: Record<number, string> = {
  1: "Archive",
  2: "Home",
  3: "Shipping",
  4: "Billing",
  5: "Main Office",
  6: "Primary",
};

export const useAdminCustomerAddresses = (businessEntityId: number | null) => {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchAddresses = useCallback(async () => {
    if (!businessEntityId) return;

    setIsLoading(true);
    try {
      const dabApiUrl = getRestApiUrl();

      const response = await fetch(
        `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${businessEntityId}`,
      );
      if (!response.ok) {
        setAddresses([]);
        return;
      }

      const data = await response.json();
      const businessEntityAddresses: BusinessEntityAddress[] = data.value || [];

      if (businessEntityAddresses.length === 0) {
        setAddresses([]);
        return;
      }

      const functionsApiUrl = getFunctionsApiUrl();
      const addressPromises = businessEntityAddresses.map(async (bea) => {
        try {
          const addrResponse = await fetch(
            `${functionsApiUrl}/api/addresses/${bea.AddressID}`,
          );
          if (!addrResponse.ok) return null;

          const apiAddress: ApiAddress = await addrResponse.json();

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
                const countryResponse = await fetch(
                  `${dabApiUrl}/CountryRegion/CountryRegionCode/${countryCode}`,
                );
                if (countryResponse.ok) {
                  const countryData = await countryResponse.json();
                  countryName = countryData.value?.[0]?.Name;
                }
              }
            }
          } catch {
            // ignore state/country lookup errors
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
            addressType: ADDRESS_TYPE_MAP[bea.AddressTypeID] || "Other",
            isDefault: bea.AddressTypeID === 2,
          } as Address;
        } catch {
          return null;
        }
      });

      const fetched = (await Promise.all(addressPromises)).filter(
        (addr): addr is Address => addr !== null,
      );
      setAddresses(fetched);
    } catch {
      setAddresses([]);
    } finally {
      setIsLoading(false);
    }
  }, [businessEntityId]);

  useEffect(() => {
    fetchAddresses();
  }, [fetchAddresses]);

  const addAddress = useCallback(
    async (address: Omit<Address, "id">): Promise<string | undefined> => {
      if (!businessEntityId) return undefined;

      setIsLoading(true);
      try {
        const functionsApiUrl = getFunctionsApiUrl();
        const dabApiUrl = getRestApiUrl();

        const beaResponse = await fetch(
          `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${businessEntityId} and AddressTypeID eq 2`,
        );
        const beaData = await beaResponse.json();
        const hasDefault = beaData.value?.length > 0;

        const requestedTypeId = Object.entries(ADDRESS_TYPE_MAP).find(
          ([_, label]) => label === address.addressType,
        )?.[0];

        let addressTypeId: string;
        if (requestedTypeId === "2" && hasDefault) {
          addressTypeId = "3";
        } else if (requestedTypeId) {
          addressTypeId = requestedTypeId;
        } else {
          addressTypeId = hasDefault ? "3" : "2";
        }

        const response = await fetch(`${functionsApiUrl}/api/addresses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            AddressLine1: address.addressLine1,
            AddressLine2: address.addressLine2 || null,
            City: address.city,
            StateProvinceID: address.stateProvinceId,
            PostalCode: address.postalCode,
            BusinessEntityID: businessEntityId,
            AddressTypeID: parseInt(addressTypeId),
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Failed to create address: ${response.status} ${errorText}`,
          );
        }

        const created: ApiAddress = await response.json();
        await fetchAddresses();
        return created.addressID != null
          ? String(created.addressID)
          : undefined;
      } finally {
        setIsLoading(false);
      }
    },
    [businessEntityId, fetchAddresses],
  );

  const updateAddress = useCallback(
    async (id: string, updates: Partial<Address>) => {
      if (!businessEntityId) return;

      setIsLoading(true);
      try {
        const addressId = parseInt(id);
        const functionsApiUrl = getFunctionsApiUrl();
        const dabApiUrl = getRestApiUrl();

        const hasAddressFields =
          updates.addressLine1 !== undefined ||
          updates.addressLine2 !== undefined ||
          updates.city !== undefined ||
          updates.stateProvinceId !== undefined ||
          updates.postalCode !== undefined;

        if (hasAddressFields) {
          const payload: Record<string, unknown> = {};
          if (updates.addressLine1 !== undefined)
            payload.AddressLine1 = updates.addressLine1;
          if (updates.addressLine2 !== undefined)
            payload.AddressLine2 = updates.addressLine2 || null;
          if (updates.city !== undefined) payload.City = updates.city;
          if (updates.stateProvinceId !== undefined)
            payload.StateProvinceID = updates.stateProvinceId;
          if (updates.postalCode !== undefined)
            payload.PostalCode = updates.postalCode;

          const response = await fetch(
            `${functionsApiUrl}/api/addresses/${addressId}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          if (!response.ok) throw new Error("Failed to update address");
        }

        if (updates.addressType !== undefined) {
          const newTypeId = Object.entries(ADDRESS_TYPE_MAP).find(
            ([_, label]) => label === updates.addressType,
          )?.[0];
          if (newTypeId) {
            const beaSearch = await fetch(
              `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${businessEntityId} and AddressID eq ${addressId}`,
            );
            const beaData = await beaSearch.json();
            const bea = beaData.value?.[0] as BusinessEntityAddress | undefined;
            if (bea) {
              await fetch(
                `${dabApiUrl}/BusinessEntityAddress/BusinessEntityID/${businessEntityId}/AddressID/${addressId}/AddressTypeID/${bea.AddressTypeID}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ AddressTypeID: parseInt(newTypeId) }),
                },
              );
            }
          }
        }

        await fetchAddresses();
      } finally {
        setIsLoading(false);
      }
    },
    [businessEntityId, fetchAddresses],
  );

  const deleteAddress = useCallback(
    async (id: string) => {
      if (!businessEntityId) return;

      setIsLoading(true);
      try {
        const addressId = parseInt(id);
        const dabApiUrl = getRestApiUrl();
        const functionsApiUrl = getFunctionsApiUrl();

        const beaResponse = await fetch(
          `${dabApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${businessEntityId} and AddressID eq ${addressId}`,
        );
        if (beaResponse.ok) {
          const beaData = await beaResponse.json();
          const bea = beaData.value?.[0] as BusinessEntityAddress | undefined;
          if (bea) {
            await fetch(
              `${dabApiUrl}/BusinessEntityAddress/BusinessEntityID/${businessEntityId}/AddressID/${addressId}/AddressTypeID/${bea.AddressTypeID}`,
              { method: "DELETE" },
            );
          }
        }

        await fetch(`${functionsApiUrl}/api/addresses/${addressId}`, {
          method: "DELETE",
        });

        await fetchAddresses();
      } finally {
        setIsLoading(false);
      }
    },
    [businessEntityId, fetchAddresses],
  );

  return {
    addresses,
    isLoading,
    addAddress,
    updateAddress,
    deleteAddress,
    refetch: fetchAddresses,
  };
};
