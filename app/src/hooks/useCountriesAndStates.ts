import { useState, useEffect } from "react";
import { getRestApiUrl } from "@/lib/utils";

interface CountryRegion {
  CountryRegionCode: string;
  Name: string;
}

interface StateProvince {
  StateProvinceID: number;
  StateProvinceCode: string;
  Name: string;
  CountryRegionCode: string;
}

export const useCountriesAndStates = (countryCode?: string) => {
  const [countries, setCountries] = useState<CountryRegion[]>([]);
  const [states, setStates] = useState<StateProvince[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch all countries on mount
  useEffect(() => {
    const fetchCountries = async () => {
      setIsLoading(true);
      try {
        const dabApiUrl = getRestApiUrl();
        let allCountries: CountryRegion[] = [];
        let nextLink = `${dabApiUrl}/CountryRegion`;

        // Fetch all pages
        while (nextLink) {
          const response = await fetch(nextLink);
          if (response.ok) {
            const data = await response.json();
            allCountries = [...allCountries, ...(data.value || [])];
            nextLink = data.nextLink || null;
          } else {
            break;
          }
        }

        // Sort countries alphabetically by name
        allCountries.sort((a, b) => a.Name.localeCompare(b.Name));
        setCountries(allCountries);
      } catch (error) {
        console.error("Failed to fetch countries:", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchCountries();
  }, []);

  // Fetch states when country changes
  useEffect(() => {
    if (!countryCode) {
      setStates([]);
      return;
    }

    const fetchStates = async () => {
      setIsLoading(true);
      try {
        const dabApiUrl = getRestApiUrl();
        const response = await fetch(
          `${dabApiUrl}/StateProvince?$filter=CountryRegionCode eq '${countryCode}'`
        );
        if (response.ok) {
          const data = await response.json();
          const stateList = data.value || [];
          // Sort states alphabetically by name
          stateList.sort((a: StateProvince, b: StateProvince) =>
            a.Name.localeCompare(b.Name)
          );
          setStates(stateList);
        }
      } catch (error) {
        console.error("Failed to fetch states:", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchStates();
  }, [countryCode]);

  return { countries, states, isLoading };
};
