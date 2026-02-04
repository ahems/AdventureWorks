import React, { createContext, useContext, useState, useEffect } from "react";
import { useCurrencyRates, Currency, CurrencyRate } from "@/hooks/useCurrency";

// Map language codes to currency codes
const LANGUAGE_CURRENCY_MAP: Record<string, string> = {
  en: "USD", // US English -> US Dollar
  "en-gb": "GBP", // UK English -> British Pound
  "en-ca": "CAD", // Canadian English -> Canadian Dollar
  "en-au": "AUD", // Australian English -> Australian Dollar
  "en-nz": "NZD", // New Zealand English -> New Zealand Dollar
  "en-ie": "EUR", // Irish English -> Euro
  es: "EUR", // Spanish -> Euro
  fr: "EUR", // French -> Euro
  de: "EUR", // German -> Euro
  pt: "EUR", // Portuguese -> Euro
  it: "EUR", // Italian -> Euro
  nl: "EUR", // Dutch -> Euro
  ru: "RUB", // Russian -> Russian Ruble
  zh: "CNY", // Chinese (Simplified) -> Yuan
  "zh-cht": "TWD", // Chinese (Traditional) -> Taiwan Dollar
  ja: "JPY", // Japanese -> Yen
  ko: "KRW", // Korean -> Won
  ar: "SAR", // Arabic -> Saudi Riyal
  he: "ILS", // Hebrew -> Israeli Shekel
  tr: "TRL", // Turkish -> Turkish Lira
  vi: "USD", // Vietnamese -> US Dollar (Vietnam not in currency list)
  th: "THB", // Thai -> Baht
  id: "IDR", // Indonesian -> Rupiah
};

// Currency symbols for display
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  CAD: "CA$",
  AUD: "A$",
  NZD: "NZ$",
  JPY: "¥",
  CNY: "¥",
  KRW: "₩",
  RUB: "₽",
  INR: "₹",
  BRL: "R$",
  MXN: "Mex$",
  CHF: "CHF",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  PLN: "zł",
  THB: "฿",
  IDR: "Rp",
  SAR: "﷼",
  ILS: "₪",
  TRL: "₺",
  TWD: "NT$",
  HKD: "HK$",
  SGD: "S$",
};

interface CurrencyContextType {
  selectedCurrency: string;
  setSelectedCurrency: (currency: string) => void;
  convertPrice: (priceInUSD: number) => number;
  formatPrice: (priceInUSD: number) => string;
  getCurrencyForLanguage: (languageCode: string) => string;
  isLoading: boolean;
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(
  undefined
);

export const CurrencyProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [selectedCurrency, setSelectedCurrencyState] = useState<string>(() => {
    // Try to get saved currency from localStorage
    const saved = localStorage.getItem("selectedCurrency");
    if (saved) return saved;

    // Otherwise, try to match with saved language
    const savedLanguage = localStorage.getItem("selectedLanguage");
    if (savedLanguage) {
      return LANGUAGE_CURRENCY_MAP[savedLanguage] || "USD";
    }

    return "USD";
  });

  const { data: rates = [], isLoading } = useCurrencyRates();

  // Save to localStorage whenever currency changes
  useEffect(() => {
    localStorage.setItem("selectedCurrency", selectedCurrency);
  }, [selectedCurrency]);

  const getCurrencyForLanguage = (languageCode: string): string => {
    return LANGUAGE_CURRENCY_MAP[languageCode] || "USD";
  };

  const convertPrice = (priceInUSD: number): number => {
    if (selectedCurrency === "USD") {
      return priceInUSD;
    }

    // Find the conversion rate from USD to the selected currency
    const rate = rates.find(
      (r) =>
        r.FromCurrencyCode === "USD" && r.ToCurrencyCode === selectedCurrency
    );

    if (rate) {
      // Use AverageRate for conversion
      return priceInUSD * rate.AverageRate;
    }

    // If no rate found, return original price
    return priceInUSD;
  };

  const formatPrice = (priceInUSD: number): string => {
    const convertedPrice = convertPrice(priceInUSD);
    const symbol = CURRENCY_SYMBOLS[selectedCurrency] || selectedCurrency;

    // Format with 2 decimal places for most currencies
    // JPY, KRW don't use decimal places
    const decimals = ["JPY", "KRW"].includes(selectedCurrency) ? 0 : 2;

    return `${symbol}${convertedPrice.toFixed(decimals)}`;
  };

  const setSelectedCurrency = (currency: string) => {
    setSelectedCurrencyState(currency);
  };

  return (
    <CurrencyContext.Provider
      value={{
        selectedCurrency,
        setSelectedCurrency,
        convertPrice,
        formatPrice,
        getCurrencyForLanguage,
        isLoading,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
};

export const useCurrency = () => {
  const context = useContext(CurrencyContext);
  if (!context) {
    throw new Error("useCurrency must be used within a CurrencyProvider");
  }
  return context;
};
