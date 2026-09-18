namespace api_functions.Models;

/// <summary>
/// The type of warehouse operation being performed.
/// </summary>
public enum WarehouseOperationType
{
    /// <summary>Store a finished good produced by manufacturing into Finished Goods Storage (LocationID 7).</summary>
    Store = 1,

    /// <summary>Retrieve a product from Finished Goods Storage to fulfil a customer order.</summary>
    Retrieve = 2,

    /// <summary>Receive purchased components/goods delivered by a supplier and put them away.</summary>
    ReceiveSupplier = 3,
}

/// <summary>
/// Message placed on the warehouse-ops-queue to drive the warehouse simulation.
/// Each message represents one warehouse operation (store / retrieve / receive) in two phases.
///
/// Two-phase lifecycle:
///   Phase 1 (IsCompletionPhase=false): Assign worker, calculate duration, set visibility timeout for Phase 2.
///   Phase 2 (IsCompletionPhase=true):  Apply damage roll, update inventory, release worker, record metrics.
///
/// The warehouse is always-on and event-driven — no explicit start/stop.
/// Operations are enqueued by upstream simulators (manufacturing, order pipeline, supply chain).
/// KEDA scales the processor to zero when the queue is empty.
/// </summary>
public record WarehouseOperationMessage
{
    /// <summary>Unique identifier for this warehouse operation.</summary>
    public string OperationId { get; set; } = string.Empty;

    /// <summary>The type of operation: Store, Retrieve, or ReceiveSupplier.</summary>
    public WarehouseOperationType OperationType { get; set; }

    /// <summary>Production.Product.ProductID being handled.</summary>
    public int ProductId { get; set; }

    /// <summary>Cached product name to avoid extra DB round-trip during processing.</summary>
    public string ProductName { get; set; } = string.Empty;

    /// <summary>Production.ProductSubcategory.ProductSubcategoryID — used to look up handling time config.</summary>
    public int? SubcategoryId { get; set; }

    /// <summary>Cached subcategory name for display purposes.</summary>
    public string? SubcategoryName { get; set; }

    /// <summary>Number of units being stored/retrieved/received.</summary>
    public int Quantity { get; set; }

    /// <summary>Weight in kg of a single unit (from Product-ai.csv). Used as time multiplier.</summary>
    public double? WeightKg { get; set; }

    /// <summary>
    /// Source context identifier:
    ///   Store      → WorkOrderID (from manufacturing sim)
    ///   Retrieve   → SalesOrderID (from order pipeline)
    ///   Receive    → PurchaseOrderID (from supply chain)
    /// </summary>
    public int? SourceReferenceId { get; set; }

    /// <summary>
    /// false = start phase: assign worker, calculate duration, set DB start timestamp.
    /// true  = completion phase: apply damage roll, update inventory, release worker.
    /// </summary>
    public bool IsCompletionPhase { get; set; }

    /// <summary>UTC time this operation is scheduled to begin (set after worker is assigned).</summary>
    public DateTime ScheduledStartUtc { get; set; }

    /// <summary>UTC time this operation is scheduled to complete (set after duration is calculated).</summary>
    public DateTime ScheduledCompletionUtc { get; set; }

    /// <summary>BusinessEntityID of the warehouse worker assigned to this operation.</summary>
    public int? AssignedEmployeeId { get; set; }

    /// <summary>Full name of the assigned worker. Cached for display without extra DB round-trip.</summary>
    public string? AssignedWorkerName { get; set; }

    /// <summary>Hourly rate of the assigned worker in USD. Used for payroll bank transactions.</summary>
    public double AssignedHourlyRate { get; set; }

    /// <summary>Cached StandardCost of the product. Used to value damage write-offs.</summary>
    public double ProductStandardCost { get; set; }
}
