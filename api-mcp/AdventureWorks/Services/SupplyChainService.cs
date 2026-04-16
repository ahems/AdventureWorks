using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AdventureWorks.Services;

/// <summary>
/// Calls the api-functions supply-chain endpoints on behalf of MCP tools.
/// Base URL is read from the API_FUNCTIONS_URL environment variable / configuration.
/// </summary>
public class SupplyChainService
{
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public SupplyChainService(HttpClient http) => _http = http;

    // ── Vendors ───────────────────────────────────────────────────────────────

    public async Task<string> GetVendorsAsync()
    {
        var resp = await _http.GetAsync("api/supply/vendors");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving vendors: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array)
            return "Unexpected response format for vendors.";

        var sb = new StringBuilder();
        sb.AppendLine("## Supply Chain Vendors");
        sb.AppendLine($"Total vendors: {arr.GetArrayLength()}");
        sb.AppendLine();

        foreach (var v in arr.EnumerateArray())
        {
            var vendor = v.TryGetProperty("vendor", out var vd) ? vd : v;
            sb.AppendLine($"### {vendor.GetStringOrDefault("name")} (ID: {vendor.GetStringOrDefault("vendorId")})");
            sb.AppendLine($"  Credit rating: {vendor.GetIntOrDefault("creditRating")} | Active: {vendor.GetBoolOrDefault("activeFlag")}");
            sb.AppendLine($"  Preferred: {vendor.GetBoolOrDefault("preferredVendorStatus")}");

            if (v.TryGetProperty("totalStockUnits", out var stock))
                sb.AppendLine($"  Total stock units: {stock.GetInt32()}");
            if (v.TryGetProperty("uniqueProducts", out var prods))
                sb.AppendLine($"  Unique products supplied: {prods.GetInt32()}");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    public async Task<string> GetVendorAsync(string vendorId)
    {
        var resp = await _http.GetAsync($"api/supply/vendors/{Uri.EscapeDataString(vendorId)}");
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            return $"Vendor '{vendorId}' not found.";
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving vendor '{vendorId}': {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine($"## Vendor Details");

        if (root.TryGetProperty("vendor", out var vWrapper))
        {
            var vendor = vWrapper.TryGetProperty("vendor", out var vd) ? vd : vWrapper;
            sb.AppendLine($"Name: {vendor.GetStringOrDefault("name")} (ID: {vendor.GetStringOrDefault("vendorId")})");
            sb.AppendLine($"Credit rating: {vendor.GetIntOrDefault("creditRating")} | Preferred: {vendor.GetBoolOrDefault("preferredVendorStatus")}");
        }

        if (root.TryGetProperty("stock", out var stock) && stock.ValueKind == JsonValueKind.Array)
        {
            sb.AppendLine();
            sb.AppendLine("### Components in Catalog");
            foreach (var c in stock.EnumerateArray())
            {
                sb.AppendLine($"  - ProductID {c.GetIntOrDefault("productId")}: {c.GetStringOrDefault("productName")} — {c.GetIntOrDefault("stockAvailable")} units @ ${c.GetDecimalOrDefault("unitPrice"):N4}");
                sb.AppendLine($"    Lead time: {c.GetIntOrDefault("leadTimeDays")} days, min order: {c.GetIntOrDefault("minOrderQty")}");
            }
        }

        return sb.ToString();
    }

    // ── Catalog ───────────────────────────────────────────────────────────────

    public async Task<string> GetSupplyCatalogAsync(int? productId = null)
    {
        var url = productId.HasValue
            ? $"api/supply/catalog/{productId.Value}"
            : "api/supply/catalog";

        var resp = await _http.GetAsync(url);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            return productId.HasValue ? $"No vendor offers found for ProductID {productId.Value}." : "Catalog not found.";
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving supply catalog: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array)
            return "Unexpected response format for supply catalog.";

        var sb = new StringBuilder();
        sb.AppendLine("## Supply Catalog");
        sb.AppendLine($"Total entries: {arr.GetArrayLength()}");
        sb.AppendLine();
        sb.AppendLine("| ProductID | Product Name | Vendor | Stock | Unit Price | Lead Time |");
        sb.AppendLine("|-----------|-------------|--------|-------|------------|-----------|");

        foreach (var c in arr.EnumerateArray())
        {
            sb.AppendLine($"| {c.GetIntOrDefault("productId")} | {c.GetStringOrDefault("productName")} | {c.GetStringOrDefault("vendorName")} ({c.GetStringOrDefault("vendorId")}) | {c.GetIntOrDefault("stockAvailable")} | ${c.GetDecimalOrDefault("unitPrice"):N4} | {c.GetIntOrDefault("leadTimeDays")}d |");
        }

        return sb.ToString();
    }

    // ── Quotes ────────────────────────────────────────────────────────────────

    public async Task<string> GetQuoteAsync(string vendorId, int productId, int qty = 1)
    {
        var resp = await _http.GetAsync($"api/supply/quote?vendorId={Uri.EscapeDataString(vendorId)}&productId={productId}&qty={qty}");
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            return $"No quote available for vendor '{vendorId}', ProductID {productId}.";
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving quote: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Supply Quote");
        sb.AppendLine($"Vendor: {root.GetStringOrDefault("vendorName")} (ID: {root.GetStringOrDefault("vendorId")})");
        sb.AppendLine($"Product: {root.GetStringOrDefault("productName")} (ID: {root.GetIntOrDefault("productId")})");
        sb.AppendLine($"Requested qty: {qty}");
        sb.AppendLine($"Unit price: ${root.GetDecimalOrDefault("unitPrice"):N4}");
        sb.AppendLine($"Total cost: ${root.GetDecimalOrDefault("totalCost"):N2}");
        sb.AppendLine($"Stock available: {root.GetIntOrDefault("stockAvailable")}");
        sb.AppendLine($"Lead time: {root.GetIntOrDefault("leadTimeDays")} days");
        sb.AppendLine($"Discount applied: {root.GetDoubleOrDefault("discountPct"):P1}");

        return sb.ToString();
    }

    // ── Orders ────────────────────────────────────────────────────────────────

    public async Task<string> PlaceOrderAsync(string vendorId, int productId, int qty)
    {
        var body = new { vendorId, productId, qty };
        var resp = await _http.PostAsJsonAsync("api/supply/order", body, _json);
        var json = await resp.Content.ReadAsStringAsync();

        if (!resp.IsSuccessStatusCode)
        {
            using var errDoc = JsonDocument.Parse(json);
            var errMsg = errDoc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : json;
            return $"Failed to place order: {errMsg}";
        }

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var sb = new StringBuilder();
        sb.AppendLine("## Purchase Order Placed");
        sb.AppendLine($"Order ID: {root.GetStringOrDefault("orderId")}");
        sb.AppendLine($"Status: {root.GetStringOrDefault("status")}");
        sb.AppendLine($"Vendor: {root.GetStringOrDefault("vendorName")} (ID: {root.GetStringOrDefault("vendorId")})");
        sb.AppendLine($"Product: {root.GetStringOrDefault("productName")} (ID: {root.GetIntOrDefault("productId")})");
        sb.AppendLine($"Qty: {root.GetIntOrDefault("qty")}");
        sb.AppendLine($"Unit price: ${root.GetDecimalOrDefault("unitPrice"):N4}");
        sb.AppendLine($"Total cost: ${root.GetDecimalOrDefault("totalCost"):N2}");
        sb.AppendLine($"Expected delivery: {root.GetStringOrDefault("expectedDeliveryDate")}");

        return sb.ToString();
    }

    public async Task<string> GetOrdersAsync(bool includeHistory = false)
    {
        var url = includeHistory ? "api/supply/orders/history" : "api/supply/orders";
        var resp = await _http.GetAsync(url);
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving orders: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array)
            return "Unexpected response format for orders.";

        var sb = new StringBuilder();
        sb.AppendLine(includeHistory ? "## Supply Chain Order History" : "## Active Supply Chain Orders");
        sb.AppendLine($"Total: {arr.GetArrayLength()}");
        sb.AppendLine();

        foreach (var o in arr.EnumerateArray().Take(30))
        {
            sb.AppendLine($"- [{o.GetStringOrDefault("status")?.ToUpperInvariant()}] Order {o.GetStringOrDefault("orderId")}: {o.GetStringOrDefault("productName")} x{o.GetIntOrDefault("qty")}");
            sb.AppendLine($"  Vendor: {o.GetStringOrDefault("vendorName")}, Cost: ${o.GetDecimalOrDefault("totalCost"):N2}, Expected: {o.GetStringOrDefault("expectedDeliveryDate")}");
        }

        return sb.ToString();
    }

    public async Task<string> GetOrderAsync(string orderId)
    {
        var resp = await _http.GetAsync($"api/supply/order/{Uri.EscapeDataString(orderId)}");
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            return $"Order '{orderId}' not found.";
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving order '{orderId}': {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine($"## Order {root.GetStringOrDefault("orderId")}");
        sb.AppendLine($"Status: {root.GetStringOrDefault("status")}");
        sb.AppendLine($"Vendor: {root.GetStringOrDefault("vendorName")} (ID: {root.GetStringOrDefault("vendorId")})");
        sb.AppendLine($"Product: {root.GetStringOrDefault("productName")} (ID: {root.GetIntOrDefault("productId")})");
        sb.AppendLine($"Qty: {root.GetIntOrDefault("qty")}");
        sb.AppendLine($"Unit price: ${root.GetDecimalOrDefault("unitPrice"):N4}");
        sb.AppendLine($"Total cost: ${root.GetDecimalOrDefault("totalCost"):N2}");
        sb.AppendLine($"Placed: {root.GetStringOrDefault("placedAt")}");
        sb.AppendLine($"Expected delivery: {root.GetStringOrDefault("expectedDeliveryDate")}");

        var statusHistory = root.TryGetProperty("statusHistory", out var hist) ? hist : default;
        if (statusHistory.ValueKind == JsonValueKind.Array)
        {
            sb.AppendLine();
            sb.AppendLine("### Status History");
            foreach (var h in statusHistory.EnumerateArray())
                sb.AppendLine($"  - {h.GetStringOrDefault("timestamp")}: {h.GetStringOrDefault("status")}");
        }

        return sb.ToString();
    }

    public async Task<string> CancelOrderAsync(string orderId, string reason = "Cancelled by agent")
    {
        var body = new { reason };
        var req = new HttpRequestMessage(HttpMethod.Delete, $"api/supply/order/{Uri.EscapeDataString(orderId)}")
        {
            Content = JsonContent.Create(body, options: _json)
        };
        var resp = await _http.SendAsync(req);

        if (resp.StatusCode == System.Net.HttpStatusCode.UnprocessableEntity || resp.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            var errJson = await resp.Content.ReadAsStringAsync();
            using var errDoc = JsonDocument.Parse(errJson);
            var errMsg = errDoc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : errJson;
            return $"Cannot cancel order '{orderId}': {errMsg}";
        }
        if (!resp.IsSuccessStatusCode)
            return $"Error cancelling order '{orderId}': {resp.StatusCode}";

        return $"Order '{orderId}' cancelled. Reason: {reason}";
    }

    // ── Restock & Reset ───────────────────────────────────────────────────────

    public async Task<string> RestockVendorAsync(string vendorId, int? productId = null)
    {
        var body = productId.HasValue ? new { productId = (object)productId.Value } : new { productId = (object)0 };
        var resp = await _http.PostAsJsonAsync($"api/supply/restock/{Uri.EscapeDataString(vendorId)}", body, _json);
        if (!resp.IsSuccessStatusCode)
            return $"Error restocking vendor '{vendorId}': {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetStringOrDefault("message") ?? $"Vendor '{vendorId}' restocked.";
    }

    public async Task<string> ResetSupplyChainAsync()
    {
        var req = new HttpRequestMessage(HttpMethod.Delete, "api/supply/reset");
        var resp = await _http.SendAsync(req);
        if (!resp.IsSuccessStatusCode)
            return $"Error resetting supply chain: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetStringOrDefault("message") ?? "Supply chain simulation reset.";
    }
}
