using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.Sql;

namespace api_functions.Functions;

/// <summary>Observes committed SQL changes, including mutations made directly through DAB.</summary>
public sealed class DatabaseChangeNotifications(WebPubSubService publisher)
{
    public sealed class Row
    {
        public int? ProductID { get; set; }
    }

    private async Task PublishAsync(IReadOnlyList<SqlChange<Row>> changes, string entity, params string[] groups)
    {
        if (changes.Count == 0) return;
        var payload = new
        {
            @event = "database-changed",
            entity,
            changeTypes = changes.Select(c => c.Operation.ToString()).Distinct().ToArray()
        };
        foreach (var group in groups)
            await publisher.SendToGroupAsync(group, payload);
    }

    [Function("CartChanges")]
    public Task Cart([SqlTrigger("[Sales].[ShoppingCartItem]", "SQL_CONNECTION_STRING", "Notifications_ShoppingCartItem")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Sales.ShoppingCartItem", "orders");

    [Function("OrderDetailChanges")]
    public Task OrderDetails([SqlTrigger("[Sales].[SalesOrderDetail]", "SQL_CONNECTION_STRING", "Notifications_SalesOrderDetail")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Sales.SalesOrderDetail", "orders");

    [Function("WorkOrderChanges")]
    public Task WorkOrders([SqlTrigger("[Production].[WorkOrder]", "SQL_CONNECTION_STRING", "Notifications_WorkOrder")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.WorkOrder", "manufacturing-ops");

    [Function("WorkOrderRoutingChanges")]
    public Task Routing([SqlTrigger("[Production].[WorkOrderRouting]", "SQL_CONNECTION_STRING", "Notifications_WorkOrderRouting")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.WorkOrderRouting", "manufacturing-ops");

    [Function("InventoryChanges")]
    public Task Inventory([SqlTrigger("[Production].[ProductInventory]", "SQL_CONNECTION_STRING", "Notifications_ProductInventory")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.ProductInventory", "manufacturing-ops", "warehouse", "supply-chain");

    [Function("LocationChanges")]
    public Task Locations([SqlTrigger("[Production].[Location]", "SQL_CONNECTION_STRING", "Notifications_Location")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.Location", "manufacturing-ops", "warehouse");

    [Function("BomChanges")]
    public Task Bom([SqlTrigger("[Production].[BillOfMaterials]", "SQL_CONNECTION_STRING", "Notifications_BillOfMaterials")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.BillOfMaterials", "manufacturing-ops");

    [Function("ProductChanges")]
    public Task Products([SqlTrigger("[Production].[Product]", "SQL_CONNECTION_STRING", "Notifications_Product")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.Product", "manufacturing-ops", "warehouse", "supply-chain");

    [Function("ProductCostChanges")]
    public Task Costs([SqlTrigger("[Production].[ProductCostHistory]", "SQL_CONNECTION_STRING", "Notifications_ProductCostHistory")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.ProductCostHistory", "manufacturing-ops", "finance");

    [Function("ProductPriceChanges")]
    public Task Prices([SqlTrigger("[Production].[ProductListPriceHistory]", "SQL_CONNECTION_STRING", "Notifications_ProductListPriceHistory")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.ProductListPriceHistory", "manufacturing-ops", "finance");

    [Function("ProductModelChanges")]
    public Task Models([SqlTrigger("[Production].[ProductModel]", "SQL_CONNECTION_STRING", "Notifications_ProductModel")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.ProductModel", "manufacturing-ops");

    [Function("TransactionChanges")]
    public Task Transactions([SqlTrigger("[Production].[TransactionHistory]", "SQL_CONNECTION_STRING", "Notifications_TransactionHistory")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.TransactionHistory", "manufacturing-ops", "warehouse", "finance");

    [Function("TransactionArchiveChanges")]
    public Task TransactionArchives([SqlTrigger("[Production].[TransactionHistoryArchive]", "SQL_CONNECTION_STRING", "Notifications_TransactionHistoryArchive")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.TransactionHistoryArchive", "manufacturing-ops", "warehouse", "finance");

    [Function("VendorChanges")]
    public Task Vendors([SqlTrigger("[Purchasing].[Vendor]", "SQL_CONNECTION_STRING", "Notifications_Vendor")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Purchasing.Vendor", "supply-chain", "warehouse");

    [Function("ProductVendorChanges")]
    public Task ProductVendors([SqlTrigger("[Purchasing].[ProductVendor]", "SQL_CONNECTION_STRING", "Notifications_ProductVendor")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Purchasing.ProductVendor", "supply-chain", "manufacturing-ops");

    [Function("PurchaseOrderChanges")]
    public Task PurchaseOrders([SqlTrigger("[Purchasing].[PurchaseOrderHeader]", "SQL_CONNECTION_STRING", "Notifications_PurchaseOrderHeader")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Purchasing.PurchaseOrderHeader", "supply-chain", "warehouse", "finance");

    [Function("PurchaseOrderDetailChanges")]
    public Task PurchaseOrderDetails([SqlTrigger("[Purchasing].[PurchaseOrderDetail]", "SQL_CONNECTION_STRING", "Notifications_PurchaseOrderDetail")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Purchasing.PurchaseOrderDetail", "supply-chain", "warehouse");

    [Function("ReviewChanges")]
    public Task Reviews([SqlTrigger("[Production].[ProductReview]", "SQL_CONNECTION_STRING", "Notifications_ProductReview")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.ProductReview", "reviews");

    [Function("ReviewReplyChanges")]
    public Task Replies([SqlTrigger("[Production].[ProductReviewReply]", "SQL_CONNECTION_STRING", "Notifications_ProductReviewReply")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Production.ProductReviewReply", "reviews");

    [Function("SpecialOfferChanges")]
    public Task Offers([SqlTrigger("[Sales].[SpecialOffer]", "SQL_CONNECTION_STRING", "Notifications_SpecialOffer")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Sales.SpecialOffer", "promotions");

    [Function("CurrencyRateChanges")]
    public Task CurrencyRates([SqlTrigger("[Sales].[CurrencyRate]", "SQL_CONNECTION_STRING", "Notifications_CurrencyRate")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Sales.CurrencyRate", "finance");

    [Function("SpecialOfferProductChanges")]
    public Task OfferProducts([SqlTrigger("[Sales].[SpecialOfferProduct]", "SQL_CONNECTION_STRING", "Notifications_SpecialOfferProduct")] IReadOnlyList<SqlChange<Row>> changes) =>
        PublishAsync(changes, "Sales.SpecialOfferProduct", "promotions");
}
