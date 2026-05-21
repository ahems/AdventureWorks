namespace api_functions.Models;

using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Converts a JSON array that may contain numbers or strings into List&lt;string&gt;.
/// Handles AI responses where numeric sizes are serialised as JSON numbers instead of strings.
/// </summary>
internal sealed class StringOrNumberListConverter : JsonConverter<List<string>>
{
    public override List<string> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var result = new List<string>();
        if (reader.TokenType != JsonTokenType.StartArray)
            return result;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            result.Add(reader.TokenType switch
            {
                JsonTokenType.String => reader.GetString() ?? string.Empty,
                JsonTokenType.Number => reader.TryGetInt64(out var l) ? l.ToString() : reader.GetDouble().ToString(),
                _ => string.Empty
            });
        }
        return result;
    }

    public override void Write(Utf8JsonWriter writer, List<string> value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        foreach (var s in value) writer.WriteStringValue(s);
        writer.WriteEndArray();
    }
}

public class ProductData
{
    public int ProductID { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? ProductNumber { get; set; }
    public string? Color { get; set; }
    public decimal? StandardCost { get; set; }
    public decimal? ListPrice { get; set; }
    public string? Size { get; set; }
    public string? SizeUnitMeasureCode { get; set; }
    public decimal? Weight { get; set; }
    public string? WeightUnitMeasureCode { get; set; }
    public string? Class { get; set; }
    public string? Style { get; set; }
    public int? ProductSubcategoryID { get; set; }
    public string? ProductSubcategoryName { get; set; }
    public int? ProductCategoryID { get; set; }
    public string? ProductCategoryName { get; set; }
    public int? ProductModelID { get; set; }
    public string? ProductModelName { get; set; }
    public string? CatalogDescription { get; set; }
    public int? ProductDescriptionID { get; set; }
    public string? Description { get; set; }
    public DateTime ModifiedDate { get; set; }
}

public class ProductDescriptionData
{
    public int ProductDescriptionID { get; set; }
    public string Description { get; set; } = string.Empty;
    public string CultureID { get; set; } = string.Empty;
    public int? ProductModelID { get; set; }
    // Product variant information for richer embeddings
    public string? ProductNames { get; set; }  // All product names for this model
    public string? Colors { get; set; }  // All available colors
    public string? Sizes { get; set; }  // All available sizes
    public string? Styles { get; set; }  // All styles (e.g., Women's, Men's, Unisex)
    public string? Classes { get; set; }  // All classes (e.g., High, Medium, Low)
    public string? ProductCategoryName { get; set; }
    public string? ProductSubcategoryName { get; set; }
}

public class ProductDescriptionEmbedding
{
    public int ProductDescriptionID { get; set; }
    public float[] Embedding { get; set; } = Array.Empty<float>();
    public int? ProductModelID { get; set; }
}

public class ProductNameEmbeddingData
{
    public int ProductID { get; set; }
    public string CultureID { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
}

public class ProductNameEmbedding
{
    public int ProductID { get; set; }
    public string CultureID { get; set; } = string.Empty;
    public float[] Embedding { get; set; } = Array.Empty<float>();
}

public class ProductImageData
{
    public int ProductID { get; set; }
    public string Name { get; set; } = string.Empty;
    public int? ProductModelID { get; set; }
    public string? ProductCategoryName { get; set; }
    public string? ProductSubcategoryName { get; set; }
    public string? Description { get; set; }
    public string? Color { get; set; }
    public string? ProductLine { get; set; }
    public string? Style { get; set; }
    public int ExistingPhotoCount { get; set; }
}

public class ProductPhotoData
{
    public int ProductID { get; set; }
    public byte[] ImageData { get; set; } = Array.Empty<byte>();
    public string FileName { get; set; } = string.Empty;
    public bool IsPrimary { get; set; }
}

public class GenerateProductContentRequest
{
    public string Category { get; set; } = string.Empty;
    public string Subcategory { get; set; } = string.Empty;
    public string? ProductLine { get; set; }
    public string? Class { get; set; }
    public string? Style { get; set; }
    /// <summary>Full list of available sizes to evaluate; AI returns which subset make sense.</summary>
    public List<string>? AvailableSizes { get; set; }
    /// <summary>Full list of available colors to evaluate; AI returns which subset make sense.</summary>
    public List<string>? AvailableColors { get; set; }
    /// <summary>Full list of available styles (value+label pairs) to evaluate; AI returns which subset make sense.</summary>
    public List<string>? AvailableStyles { get; set; }
    /// <summary>
    /// Optional Foundry response ID from the previous product in the same wizard run.
    /// Enables within-session chaining so the agent avoids repeating product names.
    /// </summary>
    public string? PreviousResponseId { get; set; }
}

public class GenerateProductContentResponse
{
    public string ProductName { get; set; } = string.Empty;
    public string ProductDescription { get; set; } = string.Empty;
    /// <summary>AI-estimated product weight in pounds.</summary>
    public decimal EstimatedWeightLb { get; set; }
    /// <summary>AI-estimated manufacturing / bulk purchase cost in USD.</summary>
    public decimal SuggestedStandardCost { get; set; }
    /// <summary>AI-estimated retail list price in USD (always >= SuggestedStandardCost).</summary>
    public decimal SuggestedListPrice { get; set; }
    /// <summary>Subset of AvailableSizes that make sense for this product type.</summary>
    [JsonConverter(typeof(StringOrNumberListConverter))]
    public List<string> SuggestedSizes { get; set; } = new();
    /// <summary>Subset of AvailableColors that make sense for this product type.</summary>
    [JsonConverter(typeof(StringOrNumberListConverter))]
    public List<string> SuggestedColors { get; set; } = new();
    /// <summary>Subset of AvailableStyles (values) that make sense for this product type.</summary>
    [JsonConverter(typeof(StringOrNumberListConverter))]
    public List<string> SuggestedStyles { get; set; } = new();
    /// <summary>
    /// Foundry response ID from this generation. Pass back as PreviousResponseId
    /// on the next product in the same wizard run to chain the conversation.
    /// </summary>
    public string? ThreadId { get; set; }
}

public class ProductPhotoThumbnailData
{
    public int ProductPhotoID { get; set; }
    public byte[] LargePhoto { get; set; } = Array.Empty<byte>();
    public string LargePhotoFileName { get; set; } = string.Empty;
    public byte[]? ThumbNailPhoto { get; set; }
}

public class SemanticSearchResult
{
    public int ProductID { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public decimal? ListPrice { get; set; }
    public string? Color { get; set; }
    public byte[]? ThumbNailPhoto { get; set; }
    public double SimilarityScore { get; set; }
    public string MatchSource { get; set; } = string.Empty; // "Description" or "Review"
    public string? MatchText { get; set; }
}
