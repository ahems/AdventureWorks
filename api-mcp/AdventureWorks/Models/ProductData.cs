namespace AdventureWorks.Models;

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

public class SemanticSearchResult
{
    public int ProductID { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public decimal? ListPrice { get; set; }
    public string? Color { get; set; }
    public double SimilarityScore { get; set; }
    public string MatchSource { get; set; } = string.Empty; // "Description" or "Review"
    public string? MatchText { get; set; }
}
