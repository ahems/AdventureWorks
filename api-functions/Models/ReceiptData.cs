namespace api_functions.Models;

/// <summary>
/// Represents complete order receipt data for PDF generation
/// </summary>
public class ReceiptData
{
    public int SalesOrderID { get; set; }
    public string SalesOrderNumber { get; set; } = string.Empty;
    public int CustomerID { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime? ShipDate { get; set; }
    public string Status { get; set; } = string.Empty;
    public string StatusText { get; set; } = string.Empty;

    // Customer Information
    public string CustomerName { get; set; } = string.Empty;
    public string CustomerEmail { get; set; } = string.Empty;

    // Shipping Address
    public string ShipToAddressLine1 { get; set; } = string.Empty;
    public string? ShipToAddressLine2 { get; set; }
    public string ShipToCity { get; set; } = string.Empty;
    public string ShipToStateProvince { get; set; } = string.Empty;
    public string ShipToPostalCode { get; set; } = string.Empty;
    public string ShipToCountry { get; set; } = string.Empty;

    // Billing Address
    public string BillToAddressLine1 { get; set; } = string.Empty;
    public string? BillToAddressLine2 { get; set; }
    public string BillToCity { get; set; } = string.Empty;
    public string BillToStateProvince { get; set; } = string.Empty;
    public string BillToPostalCode { get; set; } = string.Empty;
    public string BillToCountry { get; set; } = string.Empty;

    // Shipping Information
    public string ShipMethod { get; set; } = string.Empty;

    // Order Items
    public List<ReceiptLineItem> LineItems { get; set; } = new();

    // Pricing
    public decimal SubTotal { get; set; }
    public decimal TaxAmt { get; set; }
    public decimal Freight { get; set; }
    public decimal DiscountAmt { get; set; }
    public decimal TotalDue { get; set; }

    // Special Offers Applied
    public List<string> SpecialOffers { get; set; } = new();
}

/// <summary>
/// Represents a single line item on the receipt
/// </summary>
public class ReceiptLineItem
{
    public int LineNumber { get; set; }
    public string ProductName { get; set; } = string.Empty;
    public string ProductNumber { get; set; } = string.Empty;
    public int Quantity { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal UnitPriceDiscount { get; set; }
    public decimal LineTotal { get; set; }
}
