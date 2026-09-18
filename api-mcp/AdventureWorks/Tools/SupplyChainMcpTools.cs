using System.ComponentModel;
using AdventureWorks.Services;
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

    public SupplyChainMcpTools(SupplyChainService supplyChain)
    {
        _supplyChain = supplyChain;
    }

    // ── Vendors ───────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("List all active supply chain vendors with their credit rating, preferred status, number of unique products supplied, and total stock available. Use this to understand the supplier base before placing orders.")]
    public async Task<string> GetSupplyChainVendors()
    {
        return await _supplyChain.GetVendorsAsync();
    }

    [McpServerTool]
    [Description("Get detailed information about a specific vendor including their catalog of components with current stock levels, unit prices, lead times, and minimum order quantities.")]
    public async Task<string> GetVendorDetails(
        [Description("The vendor ID to retrieve details for.")] string vendorId)
    {
        return await _supplyChain.GetVendorAsync(vendorId);
    }

    // ── Catalog ───────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get the full supply chain vendor catalog showing all components available to order, with vendor names, stock levels, unit prices, and lead times. Optionally filter to a specific product by providing its ProductID.")]
    public async Task<string> GetSupplyCatalog(
        [Description("Optional ProductID to filter the catalog to offerings for a single component.")] int? productId = null)
    {
        return await _supplyChain.GetSupplyCatalogAsync(productId);
    }

    // ── Quotes ────────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get a real-time quote from a specific vendor for a component including unit price, any quantity discount, total cost, available stock, and lead time. Use this before placing an order to confirm pricing and availability.")]
    public async Task<string> GetSupplyQuote(
        [Description("The vendor ID to request the quote from.")] string vendorId,
        [Description("The ProductID of the component to quote.")] int productId,
        [Description("The quantity to quote. Larger quantities may attract volume discounts. Defaults to 1.")] int qty = 1)
    {
        return await _supplyChain.GetQuoteAsync(vendorId, productId, qty);
    }

    // ── Orders ────────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Place a purchase order with a vendor for a component. The vendor must have sufficient stock. The order will flow through the simulation pipeline: pending → approved → picking → shipped → delivered, with inventory updated on delivery. Get a quote first to confirm availability and pricing.")]
    public async Task<string> PlaceSupplyOrder(
        [Description("The vendor ID to order from.")] string vendorId,
        [Description("The ProductID of the component to order.")] int productId,
        [Description("The quantity to order. Must be positive and within vendor's available stock.")] int qty)
    {
        return await _supplyChain.PlaceOrderAsync(vendorId, productId, qty);
    }

    [McpServerTool]
    [Description("List all currently active (non-completed) supply chain purchase orders showing order ID, vendor, product, quantity, cost, status, and expected delivery date. Use GetSupplyOrderHistory to see completed orders.")]
    public async Task<string> GetActiveSupplyOrders()
    {
        return await _supplyChain.GetOrdersAsync(includeHistory: false);
    }

    [McpServerTool]
    [Description("Get the full historical log of all supply chain purchase orders including delivered and cancelled orders. Useful for analysing purchasing patterns, vendor performance, and total procurement spend.")]
    public async Task<string> GetSupplyOrderHistory()
    {
        return await _supplyChain.GetOrdersAsync(includeHistory: true);
    }

    [McpServerTool]
    [Description("Get the current status and full details of a specific supply chain purchase order by its order ID, including status history showing each stage transition.")]
    public async Task<string> GetSupplyOrderDetails(
        [Description("The order ID to look up (e.g. 'ORD-ABC123').")] string orderId)
    {
        return await _supplyChain.GetOrderAsync(orderId);
    }

    [McpServerTool]
    [Description("Cancel a pending supply chain purchase order. Only orders in 'pending' status can be cancelled. The vendor's stock is returned when an order is cancelled.")]
    public async Task<string> CancelSupplyOrder(
        [Description("The order ID to cancel.")] string orderId,
        [Description("The reason for cancellation. Defaults to 'Cancelled by agent'.")] string reason = "Cancelled by agent")
    {
        return await _supplyChain.CancelOrderAsync(orderId, reason);
    }

    // ── Restock & Maintenance ─────────────────────────────────────────────────

    [McpServerTool]
    [Description("Trigger an immediate restock of a vendor's simulated inventory — useful when testing or when vendor stock has been depleted through orders. Optionally restrict the restock to a single product by providing its ProductID.")]
    public async Task<string> RestockVendorInventory(
        [Description("The vendor ID to restock.")] string vendorId,
        [Description("Optional ProductID to restock only that product for this vendor. Omit to restock all products.")] int? productId = null)
    {
        return await _supplyChain.RestockVendorAsync(vendorId, productId);
    }

    [McpServerTool]
    [Description(
        "Propose placing a supply order with a vendor, pending human approval. " +
        "Use this instead of PlaceSupplyOrder when the agent mode is ProposePending. " +
        "The proposal is saved and must be approved in the Manufacturing Agent Control page before the order is placed. " +
        "Call GetSupplyQuote first to confirm availability and pricing, then include that context in the rationale.")]
    public async Task<string> ProposeSupplyOrder(
        [Description("The vendor ID to order from.")] string vendorId,
        [Description("The ProductID of the component to order.")] int productId,
        [Description("Quantity to order.")] int qty,
        [Description("Rationale for the proposal — include stock levels, quote details, and why this vendor was chosen.")]
        string rationale,
        [Description("The SalesOrderID that triggered this analysis.")] int salesOrderId,
        [Description("The agent RunID for this invocation (from the invocation payload).")] string runId)
    {
        return await _supplyChain.ProposeSupplyOrderAsync(
            vendorId, productId, qty, rationale, salesOrderId, runId);
    }
}
