namespace AddressFunctions.Models;

/// <summary>
/// Aggregate summary of all individual customers (PersonType='IN').
/// Returned by GET /api/customer-stats.
/// </summary>
public class CustomerStatsSummary
{
    public int TotalCustomers { get; set; }
    public decimal TotalRevenue { get; set; }
    public decimal AvgRevenue { get; set; }
    public int CountriesServed { get; set; }
    public List<CustomerSpendingBucket> SpendingBuckets { get; set; } = new();
}

/// <summary>
/// Customer count and revenue aggregated per country.
/// Returned by GET /api/customer-country-breakdown.
/// </summary>
public class CustomerCountryStat
{
    public string CountryCode { get; set; } = string.Empty;
    public string CountryName { get; set; } = string.Empty;
    public int CustomerCount { get; set; }
    public decimal TotalRevenue { get; set; }
    public decimal AvgRevenue { get; set; }
}

/// <summary>
/// Customer count and revenue aggregated per sales territory group (North America / Europe / Pacific).
/// Returned by GET /api/customer-region-breakdown.
/// </summary>
public class CustomerRegionStat
{
    public string RegionGroup { get; set; } = string.Empty;
    public int CustomerCount { get; set; }
    public decimal TotalRevenue { get; set; }
}

/// <summary>
/// Spending bucket for the distribution chart.
/// </summary>
public class CustomerSpendingBucket
{
    public string Bucket { get; set; } = string.Empty;
    public int Count { get; set; }
}

/// <summary>
/// Monthly revenue aggregate across all individual customer orders.
/// Returned by GET /api/customer-monthly-revenue.
/// </summary>
public class CustomerMonthlyRevenue
{
    public int Year { get; set; }
    public int Month { get; set; }
    public string MonthLabel { get; set; } = string.Empty;
    public decimal Revenue { get; set; }
}
