using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.Sql;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class DatabaseChangeNotifications(WebPubSubService publisher)
{
    public sealed class Row
    {
        public long NotificationID { get; set; }
        public string Entity { get; set; } = "";
        public string ChangeType { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    private static readonly Dictionary<string, string[]> Groups = new(StringComparer.Ordinal)
    {
        ["Sales.ShoppingCartItem"] = ["orders"],
        ["Sales.SalesOrderDetail"] = ["orders"],
        ["Production.WorkOrder"] = ["manufacturing-ops"],
        ["Production.WorkOrderRouting"] = ["manufacturing-ops"],
        ["Production.ProductInventory"] = ["manufacturing-ops", "warehouse", "supply-chain"],
        ["Production.Location"] = ["manufacturing-ops", "warehouse"],
        ["Production.BillOfMaterials"] = ["manufacturing-ops"],
        ["Production.Product"] = ["manufacturing-ops", "warehouse", "supply-chain"],
        ["Production.ProductCostHistory"] = ["manufacturing-ops", "finance"],
        ["Production.ProductListPriceHistory"] = ["manufacturing-ops", "finance"],
        ["Production.ProductModel"] = ["manufacturing-ops"],
        ["Production.TransactionHistory"] = ["manufacturing-ops", "warehouse", "finance"],
        ["Production.TransactionHistoryArchive"] = ["manufacturing-ops", "warehouse", "finance"],
        ["Purchasing.Vendor"] = ["supply-chain", "warehouse"],
        ["Purchasing.ProductVendor"] = ["supply-chain", "manufacturing-ops"],
        ["Purchasing.PurchaseOrderHeader"] = ["supply-chain", "warehouse", "finance"],
        ["Purchasing.PurchaseOrderDetail"] = ["supply-chain", "warehouse"],
        ["Production.ProductReview"] = ["reviews"],
        ["Production.ProductReviewReply"] = ["reviews"],
        ["Sales.SpecialOffer"] = ["promotions"],
        ["Sales.CurrencyRate"] = ["finance"],
        ["Sales.SpecialOfferProduct"] = ["promotions"]
    };

    [Function("DatabaseChanges")]
    public async Task Run(
        [SqlTrigger("[dbo].[RealtimeNotificationOutbox]", "SQL_CONNECTION_STRING", "Notifications_RealtimeNotificationOutbox")]
        IReadOnlyList<SqlChange<Row>> changes)
    {
        var notifications = changes.Where(c => c.Operation == SqlChangeOperation.Insert).Select(c => c.Item).ToArray();
        foreach (var row in notifications)
        {
            if (!Groups.ContainsKey(row.Entity) || row.ChangeType is not ("Insert" or "Update" or "Delete"))
                throw new InvalidOperationException("Invalid realtime notification entity or change type.");
        }
        foreach (var entity in notifications.GroupBy(row => row.Entity))
        {
            var payload = new
            {
                @event = "database-changed",
                entity = entity.Key,
                changeTypes = entity.Select(row => row.ChangeType).Distinct().ToArray()
            };
            foreach (var group in Groups[entity.Key])
                await publisher.SendToGroupAsync(group, payload);
        }
    }

}

public sealed class DatabaseNotificationCleanup(IConfiguration configuration, ILogger<DatabaseNotificationCleanup> logger)
{
    [Function("CleanupDatabaseNotifications")]
    public async Task Cleanup([TimerTrigger("0 0 3 * * *")] TimerInfo timer)
    {
        await using var connection = new SqlConnection(configuration["SQL_CONNECTION_STRING"]);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE TOP (10000) FROM dbo.RealtimeNotificationOutbox WHERE CreatedAt < DATEADD(day, -7, SYSUTCDATETIME());";
        var removed = await command.ExecuteNonQueryAsync();
        logger.LogInformation("Removed {Count} expired realtime notifications.", removed);
    }
}
