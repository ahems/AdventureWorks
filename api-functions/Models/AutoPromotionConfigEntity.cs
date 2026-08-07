using Azure;
using Azure.Data.Tables;

namespace api_functions.Models;

public class AutoPromotionConfigEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "config";
    public string RowKey { get; set; } = "auto-promotion";
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; } = ETag.All;

    public bool IsEnabled { get; set; }
    public bool TriggerOnConsumerOrders { get; set; } = true;
    public bool TriggerOnStoreOrders { get; set; } = true;
    public int ConsumerOrderThreshold { get; set; } = 50;
    public int StoreOrderThreshold { get; set; } = 50;
    public long ConsumerOrderCounter { get; set; }
    public long StoreOrderCounter { get; set; }
    public DateTimeOffset? LastConsumerTriggerAt { get; set; }
    public DateTimeOffset? LastStoreTriggerAt { get; set; }
    public long TotalAutoPromotionsCreated { get; set; }

    /// <summary>Alternates between "Promotional Discount" and "Clearance" for consumer triggers.</summary>
    public bool LastConsumerWasClearance { get; set; }
}
