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
}

public class ProductDescriptionEmbedding
{
    public int ProductDescriptionID { get; set; }
    public byte[] Embedding { get; set; } = Array.Empty<byte>();
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
