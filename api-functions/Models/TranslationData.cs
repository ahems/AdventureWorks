namespace api_functions.Models;

public class TranslationRequest
{
    public int ProductModelID { get; set; }
    public int EnglishDescriptionID { get; set; }
    public string EnglishDescription { get; set; } = string.Empty;
    public string ProductName { get; set; } = string.Empty;
}

public class TranslatedDescription
{
    public int ProductModelID { get; set; }
    public int? ExistingDescriptionID { get; set; }
    public string CultureID { get; set; } = string.Empty;
    public string CultureName { get; set; } = string.Empty;
    public string TranslatedText { get; set; } = string.Empty;
}

public class CultureInfo
{
    public string CultureID { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
}

public class TranslationActivityInput
{
    public List<TranslationRequest> Products { get; set; } = new();
    public List<CultureInfo> Cultures { get; set; } = new();
}
