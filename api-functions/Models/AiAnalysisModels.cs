namespace api_functions.Models;

// ─── Review Analysis ──────────────────────────────────────────────────────────

public class ReviewInput
{
    public int ProductReviewId { get; set; }
    public int Rating { get; set; }
    public string? Comments { get; set; }
    public string? ReviewerName { get; set; }
    public string? ProductName { get; set; }
}

public class ReviewAnalysisResult
{
    public int ProductReviewId { get; set; }
    /// <summary>"positive", "neutral", or "negative"</summary>
    public string Sentiment { get; set; } = "neutral";
    public List<string> Flags { get; set; } = new();
    public string? SuggestedResponse { get; set; }
    /// <summary>Non-null when the model call failed for this item.</summary>
    public string? Error { get; set; }
}

// ─── Email Content Generation ─────────────────────────────────────────────────

public class EmailContentRequest
{
    public string FirstName { get; set; } = "";
    /// <summary>
    /// One of: stale_cart | recent_order_thanks | re_engagement |
    /// vip_appreciation | product_recommendation | feedback_request
    /// </summary>
    public string TemplateType { get; set; } = "";
    public List<string>? ProductNames { get; set; }
    public decimal? CartValue { get; set; }
    public int? LastOrderId { get; set; }
    public decimal? TotalSpent { get; set; }
    public int? TotalOrders { get; set; }
}

public class EmailContent
{
    public string? Subject { get; set; }
    public string? Body { get; set; }
    /// <summary>Non-null when the model call failed.</summary>
    public string? Error { get; set; }
}

// ─── Cart Recovery Analysis ───────────────────────────────────────────────────

public class CartRecoveryInput
{
    public string CartId { get; set; } = "";
    public string CustomerName { get; set; } = "";
    public decimal TotalValue { get; set; }
    public int DaysStale { get; set; }
    public int TotalItems { get; set; }
    public List<string>? ProductNames { get; set; }
}

public class CartRecoveryResult
{
    public string CartId { get; set; } = "";
    /// <summary>0–100 likelihood score for recovery.</summary>
    public int RecoveryScore { get; set; }
    /// <summary>"high", "medium", or "low"</summary>
    public string Urgency { get; set; } = "low";
    public string? EmailSubject { get; set; }
    public string? EmailBody { get; set; }
    public int RecommendedDiscount { get; set; }
    public string? Strategy { get; set; }
    /// <summary>Non-null when the model call failed for this item.</summary>
    public string? Error { get; set; }
}
