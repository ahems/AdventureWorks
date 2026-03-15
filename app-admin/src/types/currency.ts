export interface Currency {
  CurrencyCode: string;
  Name: string;
  ModifiedDate: string;
}

export interface CurrencyRate {
  CurrencyRateID: number;
  CurrencyRateDate: string;
  FromCurrencyCode: string;
  ToCurrencyCode: string;
  AverageRate: number;
  EndOfDayRate: number;
  ModifiedDate: string;
}

export interface ExchangeRateApiResponse {
  result: string;
  base_code: string;
  conversion_rates: Record<string, number>;
  time_last_update_utc: string;
}
