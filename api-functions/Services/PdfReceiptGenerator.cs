using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;
using QuestPDF.Drawing;
using api_functions.Models;
using Azure.Storage.Blobs;
using Azure.Identity;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Service for generating styled PDF receipts using QuestPDF with DoodleCSS theme
/// </summary>
public class PdfReceiptGenerator
{
    private readonly ILogger<PdfReceiptGenerator> _logger;

    // AdventureWorks Company Information
    private const string COMPANY_NAME = "AdventureWorks";
    private const string COMPANY_ADDRESS_LINE1 = "1 Adventure Way";
    private const string COMPANY_CITY_STATE_ZIP = "Bothell, WA 98011";
    private const string COMPANY_PHONE = "(555) 123-4567";
    private const string COMPANY_EMAIL = "hello@adventureworks.com";

    // DoodleCSS Theme Colors (RGB values)
    private static readonly string PRIMARY_COLOR = "#FF5E5B";      // Adventure orange/rust
    private static readonly string ACCENT_COLOR = "#4a7c59";       // Forest green
    private static readonly string BACKGROUND_COLOR = "#FDF7F1";   // Warm cream
    private static readonly string TEXT_COLOR = "#3c3c3c";         // Dark gray
    private static readonly string SECONDARY_COLOR = "#E8DED3";    // Light cream

    public PdfReceiptGenerator(ILogger<PdfReceiptGenerator> logger)
    {
        _logger = logger;

        // Configure QuestPDF license (Community license for free use)
        QuestPDF.Settings.License = LicenseType.Community;

        // Register Short Stack font (DoodleCSS handwritten font)
        var fontPath = Path.Combine(AppContext.BaseDirectory, "Fonts", "ShortStack-Regular.ttf");
        if (File.Exists(fontPath))
        {
            FontManager.RegisterFont(File.OpenRead(fontPath));
            _logger.LogInformation("Short Stack font registered successfully");
        }
        else
        {
            _logger.LogWarning("Short Stack font file not found at {fontPath}, falling back to default font", fontPath);
        }
    }

    /// <summary>
    /// Generate a PDF receipt and upload to blob storage
    /// </summary>
    public async Task<string> GenerateAndUploadReceiptAsync(ReceiptData receipt)
    {
        try
        {
            _logger.LogInformation("Generating PDF receipt for order {orderNumber}", receipt.SalesOrderNumber);

            // Generate PDF in memory
            var pdfBytes = GeneratePdf(receipt);

            // Upload to blob storage
            var blobName = $"CustomerReceipts/{receipt.SalesOrderNumber}.pdf";
            var blobUrl = await UploadToBlobStorageAsync(pdfBytes, blobName);

            _logger.LogInformation("Successfully uploaded receipt to {blobUrl}", blobUrl);

            return blobUrl;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating receipt for order {orderNumber}", receipt.SalesOrderNumber);
            throw;
        }
    }

    /// <summary>
    /// Generate PDF document using QuestPDF
    /// </summary>
    private byte[] GeneratePdf(ReceiptData receipt)
    {
        var document = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.Letter);
                page.Margin(40);
                page.DefaultTextStyle(x => x.FontSize(10).FontColor(TEXT_COLOR).FontFamily("Short Stack"));

                page.Header().Element(ComposeHeader);
                page.Content().Element(content => ComposeContent(content, receipt));
                page.Footer().Element(ComposeFooter);
            });
        });

        return document.GeneratePdf();
    }

    /// <summary>
    /// Compose the header section with company info
    /// </summary>
    private void ComposeHeader(IContainer container)
    {
        container.Column(column =>
        {
            // Company logo and name row
            column.Item().PaddingBottom(5).Row(row =>
            {
                // Bike icon
                var iconPath = Path.Combine(AppContext.BaseDirectory, "Fonts", "bike-icon.png");
                if (File.Exists(iconPath))
                {
                    row.ConstantItem(32).Image(iconPath);
                    row.ConstantItem(8); // Spacing
                }

                // Company name matching website header: "Adventure" in orange, "Works" in black
                row.AutoItem().AlignMiddle().Text(text =>
                {
                    text.Span("Adventure").FontSize(24).Bold().FontColor(PRIMARY_COLOR);
                    text.Span("Works").FontSize(24).Bold().FontColor(TEXT_COLOR);
                });
            });

            // Company address
            column.Item().Text(text =>
            {
                text.Line(COMPANY_ADDRESS_LINE1).FontSize(9).FontColor(TEXT_COLOR);
                text.Line(COMPANY_CITY_STATE_ZIP).FontSize(9).FontColor(TEXT_COLOR);
                text.Line(COMPANY_PHONE).FontSize(9).FontColor(TEXT_COLOR);
                text.Line(COMPANY_EMAIL).FontSize(9).FontColor(ACCENT_COLOR);
            });

            // Divider line
            column.Item().PaddingTop(10).PaddingBottom(10)
                .BorderBottom(2)
                .BorderColor(PRIMARY_COLOR);

            // Receipt title
            column.Item().PaddingTop(10).AlignCenter().Text("ORDER RECEIPT")
                .FontSize(18)
                .Bold()
                .FontColor(ACCENT_COLOR);
        });
    }

    /// <summary>
    /// Compose the main content section
    /// </summary>
    private void ComposeContent(IContainer container, ReceiptData receipt)
    {
        container.PaddingVertical(20).Column(column =>
        {
            column.Spacing(15);

            // Order Information Section
            column.Item().Element(c => ComposeOrderInfo(c, receipt));

            // Customer & Shipping Information
            column.Item().Element(c => ComposeAddressInfo(c, receipt));

            // Line Items Table
            column.Item().Element(c => ComposeLineItems(c, receipt));

            // Special Offers (if any)
            if (receipt.SpecialOffers.Any())
            {
                column.Item().Element(c => ComposeSpecialOffers(c, receipt));
            }

            // Totals Section
            column.Item().Element(c => ComposeTotals(c, receipt));
        });
    }

    /// <summary>
    /// Order information box
    /// </summary>
    private void ComposeOrderInfo(IContainer container, ReceiptData receipt)
    {
        container.Background(SECONDARY_COLOR).Padding(10).Column(column =>
        {
            column.Item().Row(row =>
            {
                row.RelativeItem().Text(text =>
                {
                    text.Span("Order Number: ").Bold();
                    text.Span(receipt.SalesOrderNumber).FontColor(PRIMARY_COLOR).Bold();
                });

                row.RelativeItem().AlignRight().Text(text =>
                {
                    text.Span("Order Date: ").Bold();
                    text.Span(receipt.OrderDate.ToString("MMM dd, yyyy"));
                });
            });

            column.Item().PaddingTop(5).Row(row =>
            {
                row.RelativeItem().Text(text =>
                {
                    text.Span("Order ID: ").Bold();
                    text.Span(receipt.SalesOrderID.ToString());
                });

                row.RelativeItem().AlignRight().Text(text =>
                {
                    text.Span("Customer ID: ").Bold();
                    text.Span(receipt.CustomerID.ToString());
                });
            });

            column.Item().PaddingTop(5).Row(row =>
            {
                row.RelativeItem().Text(text =>
                {
                    text.Span("Status: ").Bold();
                    text.Span(receipt.StatusText).FontColor(ACCENT_COLOR);
                });

                if (receipt.ShipDate.HasValue)
                {
                    row.RelativeItem().AlignRight().Text(text =>
                    {
                        text.Span("Ship Date: ").Bold();
                        text.Span(receipt.ShipDate.Value.ToString("MMM dd, yyyy"));
                    });
                }
            });
        });
    }

    /// <summary>
    /// Customer and shipping address section
    /// </summary>
    private void ComposeAddressInfo(IContainer container, ReceiptData receipt)
    {
        container.Row(row =>
        {
            // Customer Info
            row.RelativeItem().Column(column =>
            {
                column.Item().Text("CUSTOMER").Bold().FontSize(11).FontColor(ACCENT_COLOR);
                column.Item().PaddingTop(5).Text(receipt.CustomerName);
                column.Item().Text(receipt.CustomerEmail).FontColor(PRIMARY_COLOR);
            });

            // Ship To Address
            row.RelativeItem().Column(column =>
            {
                column.Item().Text("SHIP TO").Bold().FontSize(11).FontColor(ACCENT_COLOR);
                column.Item().PaddingTop(5).Text(receipt.ShipToAddressLine1);
                if (!string.IsNullOrEmpty(receipt.ShipToAddressLine2))
                {
                    column.Item().Text(receipt.ShipToAddressLine2);
                }
                column.Item().Text($"{receipt.ShipToCity}, {receipt.ShipToStateProvince} {receipt.ShipToPostalCode}");
                column.Item().Text(receipt.ShipToCountry);
            });
        });
    }

    /// <summary>
    /// Line items table
    /// </summary>
    private void ComposeLineItems(IContainer container, ReceiptData receipt)
    {
        container.Column(column =>
        {
            column.Item().Text("ORDER ITEMS").Bold().FontSize(12).FontColor(ACCENT_COLOR);

            column.Item().PaddingTop(10).Table(table =>
            {
                // Define columns
                table.ColumnsDefinition(columns =>
                {
                    columns.ConstantColumn(40);      // Qty
                    columns.RelativeColumn(3);       // Product Name
                    columns.RelativeColumn(2);       // Product Number
                    columns.ConstantColumn(80);      // Unit Price
                    columns.ConstantColumn(80);      // Total
                });

                // Header
                table.Header(header =>
                {
                    header.Cell().Background(PRIMARY_COLOR).Padding(5)
                        .Text("Qty").Bold().FontColor(Colors.White);
                    header.Cell().Background(PRIMARY_COLOR).Padding(5)
                        .Text("Product").Bold().FontColor(Colors.White);
                    header.Cell().Background(PRIMARY_COLOR).Padding(5)
                        .Text("SKU").Bold().FontColor(Colors.White);
                    header.Cell().Background(PRIMARY_COLOR).Padding(5).AlignRight()
                        .Text("Unit Price").Bold().FontColor(Colors.White);
                    header.Cell().Background(PRIMARY_COLOR).Padding(5).AlignRight()
                        .Text("Total").Bold().FontColor(Colors.White);
                });

                // Line items
                foreach (var item in receipt.LineItems)
                {
                    var isEven = receipt.LineItems.IndexOf(item) % 2 == 0;
                    var bgColor = isEven ? "#FFFFFF" : SECONDARY_COLOR;

                    table.Cell().Background(bgColor).Padding(5).AlignCenter()
                        .Text(item.Quantity.ToString());
                    table.Cell().Background(bgColor).Padding(5)
                        .Text(item.ProductName);
                    table.Cell().Background(bgColor).Padding(5)
                        .Text(item.ProductNumber).FontSize(8);
                    table.Cell().Background(bgColor).Padding(5).AlignRight()
                        .Text($"${item.UnitPrice:N2}");
                    table.Cell().Background(bgColor).Padding(5).AlignRight()
                        .Text($"${item.LineTotal:N2}").Bold();
                }
            });
        });
    }

    /// <summary>
    /// Special offers applied
    /// </summary>
    private void ComposeSpecialOffers(IContainer container, ReceiptData receipt)
    {
        container.Background("#FFF9E6").Padding(10).Column(column =>
        {
            column.Item().Text("🎉 Special Offers Applied").Bold().FontColor(ACCENT_COLOR);
            foreach (var offer in receipt.SpecialOffers)
            {
                column.Item().PaddingTop(3).Text($"• {offer}").FontSize(9);
            }
        });
    }

    /// <summary>
    /// Totals section
    /// </summary>
    private void ComposeTotals(IContainer container, ReceiptData receipt)
    {
        container.AlignRight().Width(250).Column(column =>
        {
            column.Item().BorderTop(1).BorderColor(Colors.Grey.Lighten2).PaddingTop(5);

            column.Item().Row(row =>
            {
                row.RelativeItem().Text("Subtotal:");
                row.ConstantItem(80).AlignRight().Text($"${receipt.SubTotal:N2}");
            });

            if (receipt.DiscountAmt > 0)
            {
                column.Item().PaddingTop(3).Row(row =>
                {
                    row.RelativeItem().Text("Discount:").FontColor(ACCENT_COLOR);
                    row.ConstantItem(80).AlignRight().Text($"-${receipt.DiscountAmt:N2}").FontColor(ACCENT_COLOR);
                });
            }

            column.Item().PaddingTop(3).Row(row =>
            {
                row.RelativeItem().Text("Shipping:");
                row.ConstantItem(80).AlignRight().Text($"${receipt.Freight:N2}");
            });

            column.Item().PaddingTop(3).Row(row =>
            {
                row.RelativeItem().Text($"Shipping Method: {receipt.ShipMethod}").FontSize(8).Italic();
            });

            column.Item().PaddingTop(3).Row(row =>
            {
                row.RelativeItem().Text("Tax:");
                row.ConstantItem(80).AlignRight().Text($"${receipt.TaxAmt:N2}");
            });

            column.Item().PaddingTop(8).BorderTop(2).BorderColor(PRIMARY_COLOR).PaddingTop(5);

            column.Item().Row(row =>
            {
                row.RelativeItem().Text("TOTAL:").Bold().FontSize(14).FontColor(PRIMARY_COLOR);
                row.ConstantItem(80).AlignRight().Text($"${receipt.TotalDue:N2}").Bold().FontSize(14).FontColor(PRIMARY_COLOR);
            });
        });
    }

    /// <summary>
    /// Footer with thank you message
    /// </summary>
    private void ComposeFooter(IContainer container)
    {
        container.AlignCenter().Column(column =>
        {
            column.Item().BorderTop(1).BorderColor(Colors.Grey.Lighten2).PaddingTop(10);
            column.Item().Text("Thank you for your order!")
                .FontSize(12)
                .Bold()
                .FontColor(PRIMARY_COLOR);
            column.Item().PaddingTop(5).Text("We hope you enjoy your adventure!")
                .FontSize(9)
                .Italic()
                .FontColor(TEXT_COLOR);
        });
    }

    /// <summary>
    /// Upload PDF to Azure Blob Storage
    /// </summary>
    private async Task<string> UploadToBlobStorageAsync(byte[] pdfBytes, string blobName)
    {
        // Get blob service URI from connection string or environment
        var blobServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__blobServiceUri");
        if (string.IsNullOrEmpty(blobServiceUri))
        {
            var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            blobServiceUri = $"https://{storageAccountName}.blob.core.windows.net";
        }

        // Create blob client with managed identity
        var blobServiceClient = new BlobServiceClient(
            new Uri(blobServiceUri),
            new DefaultAzureCredential()
        );

        // Container is pre-created in infrastructure - just get the client
        var containerClient = blobServiceClient.GetBlobContainerClient("adventureworks-receipts");
        var blobClient = containerClient.GetBlobClient(blobName);

        using var stream = new MemoryStream(pdfBytes);
        await blobClient.UploadAsync(stream, overwrite: true);

        return blobClient.Uri.ToString();
    }
}
