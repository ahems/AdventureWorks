using System.ComponentModel;
using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using ModelContextProtocol.Server;

namespace AdventureWorks.Tools;

/// <summary>
/// MCP tools exposing the supply chain procurement simulation APIs.
/// Intended for use by supply chain and procurement agents.
/// </summary>
[McpServerToolType]
public class SupplyChainMcpTools
{
    private readonly SupplyChainService _supplyChain;
    private readonly TelemetryClient _telemetryClient;

    public SupplyChainMcpTools(SupplyChainService supplyChain, TelemetryClient telemetryClient)
    {
        _supplyChain = supplyChain;
        _telemetryClient = telemetryClient;
    }

    // ── Vendors ───────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("List all active supply chain vendors with their credit rating, preferred status, number of unique products supplied, and total stock available. Use this to understand the supplier base before placing orders.")]
    public async Task<string> GetSupplyChainVendors()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetSupplyChainVendors");
        try
        {
            var result = await _supplyChain.GetVendorsAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetSupplyChainVendors" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetSupplyChainVendors" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get detailed information about a specific vendor including their catalog of components with current stock levels, unit prices, lead times, and minimum order quantities.")]
    public async Task<string> GetVendorDetails(
        [Description("The vendor ID to retrieve details for.")] string vendorId)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetVendorDetails");
        operation.Telemetry.Properties["vendorId"] = vendorId;
        try
        {
            var result = await _supplyChain.GetVendorAsync(vendorId);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetVendorDetails" },
                { "vendorId", vendorId }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetVendorDetails" }, { "vendorId", vendorId } });
            throw;
        }
    }

    // ── Catalog ───────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get the full supply chain vendor catalog showing all components available to order, with vendor names, stock levels, unit prices, and lead times. Optionally filter to a specific product by providing its ProductID.")]
    public async Task<string> GetSupplyCatalog(
        [Description("Optional ProductID to filter the catalog to offerings for a single component.")] int? productId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetSupplyCatalog");
        operation.Telemetry.Properties["productId"] = productId?.ToString() ?? "all";
        try
        {
            var result = await _supplyChain.GetSupplyCatalogAsync(productId);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetSupplyCatalog" },
                { "productId", productId?.ToString() ?? "all" }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetSupplyCatalog" } });
            throw;
        }
    }

    // ── Quotes ────────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get a real-time quote from a specific vendor for a component including unit price, any quantity discount, total cost, available stock, and lead time. Use this before placing an order to confirm pricing and availability.")]
    public async Task<string> GetSupplyQuote(
        [Description("The vendor ID to request the quote from.")] string vendorId,
        [Description("The ProductID of the component to quote.")] int productId,
        [Description("The quantity to quote. Larger quantities may attract volume discounts. Defaults to 1.")] int qty = 1)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetSupplyQuote");
        operation.Telemetry.Properties["vendorId"] = vendorId;
        operation.Telemetry.Properties["productId"] = productId.ToString();
        try
        {
            var result = await _supplyChain.GetQuoteAsync(vendorId, productId, qty);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetSupplyQuote" },
                { "vendorId", vendorId },
                { "productId", productId.ToString() },
                { "qty", qty.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetSupplyQuote" }, { "vendorId", vendorId } });
            throw;
        }
    }

    // ── Orders ────────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Place a purchase order with a vendor for a component. The vendor must have sufficient stock. The order will flow through the simulation pipeline: pending → approved → picking → shipped → delivered, with inventory updated on delivery. Get a quote first to confirm availability and pricing.")]
    public async Task<string> PlaceSupplyOrder(
        [Description("The vendor ID to order from.")] string vendorId,
        [Description("The ProductID of the component to order.")] int productId,
        [Description("The quantity to order. Must be positive and within vendor's available stock.")] int qty)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_PlaceSupplyOrder");
        operation.Telemetry.Properties["vendorId"] = vendorId;
        operation.Telemetry.Properties["productId"] = productId.ToString();
        operation.Telemetry.Properties["qty"] = qty.ToString();
        try
        {
            var result = await _supplyChain.PlaceOrderAsync(vendorId, productId, qty);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "PlaceSupplyOrder" },
                { "vendorId", vendorId },
                { "productId", productId.ToString() },
                { "qty", qty.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "PlaceSupplyOrder" }, { "vendorId", vendorId } });
            throw;
        }
    }

    [McpServerTool]
    [Description("List all currently active (non-completed) supply chain purchase orders showing order ID, vendor, product, quantity, cost, status, and expected delivery date. Use GetSupplyOrderHistory to see completed orders.")]
    public async Task<string> GetActiveSupplyOrders()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetActiveSupplyOrders");
        try
        {
            var result = await _supplyChain.GetOrdersAsync(includeHistory: false);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetActiveSupplyOrders" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetActiveSupplyOrders" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get the full historical log of all supply chain purchase orders including delivered and cancelled orders. Useful for analysing purchasing patterns, vendor performance, and total procurement spend.")]
    public async Task<string> GetSupplyOrderHistory()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetSupplyOrderHistory");
        try
        {
            var result = await _supplyChain.GetOrdersAsync(includeHistory: true);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetSupplyOrderHistory" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetSupplyOrderHistory" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get the current status and full details of a specific supply chain purchase order by its order ID, including status history showing each stage transition.")]
    public async Task<string> GetSupplyOrderDetails(
        [Description("The order ID to look up (e.g. 'ORD-ABC123').")] string orderId)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetSupplyOrderDetails");
        operation.Telemetry.Properties["orderId"] = orderId;
        try
        {
            var result = await _supplyChain.GetOrderAsync(orderId);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetSupplyOrderDetails" },
                { "orderId", orderId }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetSupplyOrderDetails" }, { "orderId", orderId } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Cancel a pending supply chain purchase order. Only orders in 'pending' status can be cancelled. The vendor's stock is returned when an order is cancelled.")]
    public async Task<string> CancelSupplyOrder(
        [Description("The order ID to cancel.")] string orderId,
        [Description("The reason for cancellation. Defaults to 'Cancelled by agent'.")] string reason = "Cancelled by agent")
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_CancelSupplyOrder");
        operation.Telemetry.Properties["orderId"] = orderId;
        try
        {
            var result = await _supplyChain.CancelOrderAsync(orderId, reason);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "CancelSupplyOrder" },
                { "orderId", orderId }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "CancelSupplyOrder" }, { "orderId", orderId } });
            throw;
        }
    }

    // ── Restock & Maintenance ─────────────────────────────────────────────────

    [McpServerTool]
    [Description("Trigger an immediate restock of a vendor's simulated inventory — useful when testing or when vendor stock has been depleted through orders. Optionally restrict the restock to a single product by providing its ProductID.")]
    public async Task<string> RestockVendorInventory(
        [Description("The vendor ID to restock.")] string vendorId,
        [Description("Optional ProductID to restock only that product for this vendor. Omit to restock all products.")] int? productId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_RestockVendorInventory");
        operation.Telemetry.Properties["vendorId"] = vendorId;
        try
        {
            var result = await _supplyChain.RestockVendorAsync(vendorId, productId);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "RestockVendorInventory" },
                { "vendorId", vendorId },
                { "productId", productId?.ToString() ?? "all" }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "RestockVendorInventory" }, { "vendorId", vendorId } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Reset the entire supply chain simulation: clears all purchase orders, cancels in-flight transitions, and re-seeds vendor stock to initial levels. Use this to start a clean simulation scenario.")]
    public async Task<string> ResetSupplyChainSimulation()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_ResetSupplyChainSimulation");
        try
        {
            var result = await _supplyChain.ResetSupplyChainAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "ResetSupplyChainSimulation" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "ResetSupplyChainSimulation" } });
            throw;
        }
    }
}
