export interface CustomerStatsSummary {
  totalCustomers: number;
  totalRevenue: number;
  avgRevenue: number;
  countriesServed: number;
  spendingBuckets: CustomerSpendingBucket[];
}

export interface CustomerCountryStat {
  countryCode: string;
  countryName: string;
  customerCount: number;
  totalRevenue: number;
  avgRevenue: number;
}

export interface CustomerRegionStat {
  regionGroup: string;
  customerCount: number;
  totalRevenue: number;
}

export interface CustomerSpendingBucket {
  bucket: string;
  count: number;
}

export interface CustomerMonthlyRevenue {
  year: number;
  month: number;
  monthLabel: string;
  revenue: number;
  cumulativeRevenue?: number; // added client-side
}
