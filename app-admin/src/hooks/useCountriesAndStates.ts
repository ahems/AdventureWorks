import { useState, useEffect } from "react";
import { getRestApiUrl } from "@/lib/utils";
import { dabFetch } from "@/services/dabFetch";

export interface CountryRegion {
  CountryRegionCode: string;
  Name: string;
}

export interface StateProvince {
  StateProvinceID: number;
  StateProvinceCode: string;
  Name: string;
  CountryRegionCode: string;
}

// Module-level cache: countries never change between sessions
let countriesCache: CountryRegion[] | null = null;
let countriesFetchPromise: Promise<CountryRegion[]> | null = null;

const fetchCountriesOnce = async (): Promise<CountryRegion[]> => {
  if (countriesCache) return countriesCache;
  if (countriesFetchPromise) return countriesFetchPromise;

  countriesFetchPromise = (async () => {
    const dabApiUrl = getRestApiUrl();
    let allCountries: CountryRegion[] = [];
    let nextLink: string | null = `${dabApiUrl}/CountryRegion`;

    while (nextLink) {
      const response = await dabFetch(nextLink);
      if (response.ok) {
        const data = await response.json();
        allCountries = [...allCountries, ...(data.value || [])];
        nextLink = data.nextLink || null;
      } else {
        // Don't cache a partial/empty list (e.g. a rejected read); retry on next mount.
        countriesFetchPromise = null;
        throw new Error(`Failed to load countries: ${response.status}`);
      }
    }

    allCountries.sort((a, b) => a.Name.localeCompare(b.Name));
    countriesCache = allCountries;
    return allCountries;
  })();

  return countriesFetchPromise;
};

export const useCountriesAndStates = (countryCode?: string) => {
  const [countries, setCountries] = useState<CountryRegion[]>(
    countriesCache ?? [],
  );
  const [states, setStates] = useState<StateProvince[]>([]);
  const [isCountriesLoading, setIsCountriesLoading] = useState(!countriesCache);
  const [isStatesLoading, setIsStatesLoading] = useState(false);

  useEffect(() => {
    if (countriesCache) {
      setCountries(countriesCache);
      setIsCountriesLoading(false);
      return;
    }
    setIsCountriesLoading(true);
    fetchCountriesOnce()
      .then((result) => setCountries(result))
      .catch(console.error)
      .finally(() => setIsCountriesLoading(false));
  }, []);

  useEffect(() => {
    if (!countryCode) {
      setStates([]);
      return;
    }
    const fetchStates = async () => {
      setIsStatesLoading(true);
      try {
        const dabApiUrl = getRestApiUrl();
        const response = await dabFetch(
          `${dabApiUrl}/StateProvince?$filter=CountryRegionCode eq '${countryCode}'`,
        );
        if (response.ok) {
          const data = await response.json();
          const stateList: StateProvince[] = data.value || [];
          stateList.sort((a, b) => a.Name.localeCompare(b.Name));
          setStates(stateList);
        }
      } catch (err) {
        console.error("Failed to fetch states", err);
      } finally {
        setIsStatesLoading(false);
      }
    };
    fetchStates();
  }, [countryCode]);

  return { countries, states, isCountriesLoading, isStatesLoading };
};
