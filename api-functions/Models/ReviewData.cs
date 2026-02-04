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
