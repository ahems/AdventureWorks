import { useState, useEffect } from "react";
import { getRestApiUrl } from "@/lib/utils";
import { trackError } from "@/lib/appInsights";

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

// Module-level cache: countries never change between sessions, so fetch once per page load
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
      const response = await fetch(nextLink);
      if (response.ok) {
        const data = await response.json();
        allCountries = [...allCountries, ...(data.value || [])];
        nextLink = data.nextLink || null;
      } else {
        break;
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
  const [isCountriesLoading, setIsCountriesLoading] = useState(
    !countriesCache,
  );
  const [isStatesLoading, setIsStatesLoading] = useState(false);

  // Fetch countries once, using shared cache so parallel mounts don't each hit the API
  useEffect(() => {
    if (countriesCache) {
      setCountries(countriesCache);
      setIsCountriesLoading(false);
      return;
    }

    setIsCountriesLoading(true);
    fetchCountriesOnce()
      .then((result) => setCountries(result))
      .catch((error) =>
        trackError("Failed to fetch countries", error as Error, {
          hook: "useCountriesAndStates",
          context: "fetchCountries",
        }),
      )
      .finally(() => setIsCountriesLoading(false));
  }, []);

  // Fetch states when country changes (separate loading flag from countries)
  useEffect(() => {
    if (!countryCode) {
      setStates([]);
      return;
    }

    const fetchStates = async () => {
      setIsStatesLoading(true);
      try {
        const dabApiUrl = getRestApiUrl();
        const response = await fetch(
          `${dabApiUrl}/StateProvince?$filter=CountryRegionCode eq '${countryCode}'`,
        );
        if (response.ok) {
          const data = await response.json();
          const stateList: StateProvince[] = data.value || [];
          stateList.sort((a, b) => a.Name.localeCompare(b.Name));
          setStates(stateList);
        }
      } catch (error) {
        trackError("Failed to fetch states", error as Error, {
          hook: "useCountriesAndStates",
          context: "fetchStates",
          countryCode,
        });
      } finally {
        setIsStatesLoading(false);
      }
    };
    fetchStates();
  }, [countryCode]);

  return {
    countries,
    states,
    isLoading: isCountriesLoading || isStatesLoading,
    isCountriesLoading,
    isStatesLoading,
  };
};
