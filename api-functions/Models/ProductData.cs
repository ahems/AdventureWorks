namespace api_functions.Models;

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

public class EnhancedProductData
{
    public int ProductID { get; set; }
    public int? ProductDescriptionID { get; set; }
    public string EnhancedDescription { get; set; } = string.Empty;
    public string? Color { get; set; }
    public string? Size { get; set; }
    public string? SizeUnitMeasureCode { get; set; }
    public decimal? Weight { get; set; }
    public string? WeightUnitMeasureCode { get; set; }
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

public class ProductImageData
{
    public int ProductID { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? ProductCategoryName { get; set; }
    public string? Description { get; set; }
    public int ExistingPhotoCount { get; set; }
}

public class ProductPhotoData
{
    public int ProductID { get; set; }
    public byte[] ImageData { get; set; } = Array.Empty<byte>();
    public string FileName { get; set; } = string.Empty;
    public bool IsPrimary { get; set; }
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
