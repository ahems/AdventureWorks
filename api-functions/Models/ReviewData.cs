namespace api_functions.Models;

public class ProductReviewData
{
    public int ProductReviewID { get; set; }
    public int ProductID { get; set; }
    public string ReviewerName { get; set; } = string.Empty;
    public DateTime ReviewDate { get; set; }
    public int Rating { get; set; }
    public string? Comments { get; set; }
    public DateTime ModifiedDate { get; set; }
}

public class ProductReviewEmbedding
{
    public int ProductReviewID { get; set; }
    public float[] Embedding { get; set; } = Array.Empty<float>();
    public int ProductID { get; set; }
}

public class ProductForReviewGeneration
{
    public int ProductID { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public int ExistingReviewCount { get; set; }
    public DateTime SellStartDate { get; set; }
}

public class GeneratedReview
{
    public int ProductID { get; set; }
    public string ReviewerName { get; set; } = string.Empty;
    public string EmailAddress { get; set; } = string.Empty;
    public int Rating { get; set; }
    public string Comments { get; set; } = string.Empty;
    public DateTime ReviewDate { get; set; }
}

/// <summary>Represents a customer who has at least one Delivered order containing a specific product.</summary>
public class CustomerWithDeliveredOrder
{
    public int CustomerID { get; set; }
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string EmailAddress { get; set; } = string.Empty;
    public DateTime DeliveryDate { get; set; }
}

/// <summary>Request body for POST /api/generate-verified-reviews/start (batch).</summary>
public class BatchStartVerifiedReviewsRequest
{
    /// <summary>Number of qualifying products to generate reviews for. Defaults to all qualifying products. Ignored when SpecificProductId is set.</summary>
    public int ProductCount { get; set; } = 0;  // 0 = all

    /// <summary>Reviews to generate per product (1 to max eligible customers for that product, default 1).</summary>
    public int ReviewsPerProduct { get; set; } = 1;

    /// <summary>
    /// When set, restricts generation to a single specific product (e.g. from the product page).
    /// ProductCount is ignored when this is provided.
    /// </summary>
    public int? SpecificProductId { get; set; }
}

/// <summary>Summary of products and customers eligible for verified-review generation.</summary>
public class VerifiedReviewsSummary
{
    public int QualifyingProductCount { get; set; }
    public int MaxEligibleCustomersPerProduct { get; set; }
    /// <summary>ProductID of the product with the most unreviewed eligible customers.</summary>
    public int TopProductId { get; set; }
    /// <summary>Name of the product with the most unreviewed eligible customers.</summary>
    public string TopProductName { get; set; } = string.Empty;
}

/// <summary>Internal Dapper projection used when selecting qualifying products for a batch run.</summary>
public class QualifyingProductInfo
{
    public int ProductID { get; set; }
    public int EligibleCount { get; set; }
}

/// <summary>Persisted state for the verified-reviews background job (Table Storage entity).</summary>
public class VerifiedReviewsJobState
{
    public bool IsRunning { get; set; }
    public int ProductId { get; set; }         // 0 for batch jobs
    public string ProductName { get; set; } = string.Empty;  // current product name or job description
    public int ProcessedCount { get; set; }    // reviews generated so far
    public int TotalCount { get; set; }        // total reviews to generate
    public int ProductsProcessed { get; set; } // products completed (for batch)
    public int ProductsTotal { get; set; }     // total products in batch
    public DateTimeOffset? StartedAt { get; set; }
    /// <summary>Updated every time the job saves progress. Used to detect stuck/orphaned jobs.</summary>
    public DateTimeOffset? LastProgressAt { get; set; }
    public string? LastError { get; set; }
}

/// <summary>Snapshot review record used for queue-based auto-moderation.</summary>
public class PendingReviewModerationItem
{
    public int ProductReviewId { get; set; }
    public int ProductId { get; set; }
    public int Rating { get; set; }
    public string ReviewerName { get; set; } = string.Empty;
    public string Comments { get; set; } = string.Empty;
    public string ProductName { get; set; } = string.Empty;
}

/// <summary>Queue payload for one review auto-moderation operation.</summary>
public class ReviewModerationQueueMessage
{
    public string JobId { get; set; } = string.Empty;
    public int ProductReviewId { get; set; }
    public int Rating { get; set; }
    public string ReviewerName { get; set; } = string.Empty;
    public string Comments { get; set; } = string.Empty;
    public string ProductName { get; set; } = string.Empty;
    public DateTimeOffset EnqueuedAt { get; set; }
}

/// <summary>Persisted state for review auto-moderation background processing.</summary>
public class ReviewModerationJobState
{
    public bool IsRunning { get; set; }
    public string JobId { get; set; } = string.Empty;
    public int QueuedCount { get; set; }
    public int ProcessedCount { get; set; }
    public int SuccessCount { get; set; }
    public int FailedCount { get; set; }
    public int SkippedCount { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? LastProgressAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public string? LastError { get; set; }
}

public enum ReviewModerationApplyOutcome
{
    Applied,
    SkippedAlreadyModerated,
    SkippedAlreadyReplied,
    SkippedNotFound
}
