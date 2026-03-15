import { Currency, CurrencyRate } from "@/types/currency";

export const currencies: Currency[] = [
  { CurrencyCode: "USD", Name: "US Dollar", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "EUR", Name: "Euro", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "GBP", Name: "British Pound", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "CAD", Name: "Canadian Dollar", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "AUD", Name: "Australian Dollar", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "JPY", Name: "Japanese Yen", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "CHF", Name: "Swiss Franc", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "CNY", Name: "Chinese Yuan", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "INR", Name: "Indian Rupee", ModifiedDate: "2024-01-15T10:30:00Z" },
  { CurrencyCode: "MXN", Name: "Mexican Peso", ModifiedDate: "2024-01-15T10:30:00Z" },
];

export const currencyRates: CurrencyRate[] = [
  { CurrencyRateID: 1, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "EUR", AverageRate: 0.92, EndOfDayRate: 0.915, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 2, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "GBP", AverageRate: 0.79, EndOfDayRate: 0.788, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 3, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "CAD", AverageRate: 1.35, EndOfDayRate: 1.348, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 4, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "AUD", AverageRate: 1.52, EndOfDayRate: 1.518, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 5, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "JPY", AverageRate: 148.5, EndOfDayRate: 148.25, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 6, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "CHF", AverageRate: 0.86, EndOfDayRate: 0.858, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 7, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "CNY", AverageRate: 7.18, EndOfDayRate: 7.175, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 8, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "INR", AverageRate: 83.12, EndOfDayRate: 83.10, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 9, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "USD", ToCurrencyCode: "MXN", AverageRate: 17.15, EndOfDayRate: 17.12, ModifiedDate: "2024-01-15T23:59:00Z" },
  { CurrencyRateID: 10, CurrencyRateDate: "2024-01-15", FromCurrencyCode: "EUR", ToCurrencyCode: "GBP", AverageRate: 0.86, EndOfDayRate: 0.858, ModifiedDate: "2024-01-15T23:59:00Z" },
];
