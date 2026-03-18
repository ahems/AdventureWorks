using System.Text.Json;

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

// Language file translation models
public class TranslationOrchestrationInput
{
    public string LanguageDataJson { get; set; } = string.Empty;
    public string TargetLanguageCode { get; set; } = string.Empty;
    public string TargetLanguageName { get; set; } = string.Empty;
    public string SourceFilename { get; set; } = string.Empty;
}

public class SectionTranslationInput
{
    public string SectionName { get; set; } = string.Empty;
    public string SectionDataJson { get; set; } = string.Empty;
    public string TargetLanguageCode { get; set; } = string.Empty;
    public string TargetLanguageName { get; set; } = string.Empty;
}

public class ValueTranslationInput
{
    public string SectionName { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public string TargetLanguageCode { get; set; } = string.Empty;
    public string TargetLanguageName { get; set; } = string.Empty;
}

public class TranslatedSection
{
    public string SectionName { get; set; } = string.Empty;
    public string TranslatedDataJson { get; set; } = string.Empty;
}

public class TranslationResultInput
{
    public string InstanceId { get; set; } = string.Empty;
    public string JsonResult { get; set; } = string.Empty;
    public string TargetLanguageCode { get; set; } = string.Empty;
    public string SourceFilename { get; set; } = string.Empty;
}

// Promotion translation models

public class TextTranslation
{
    public string CultureID { get; set; } = string.Empty;
    public string TranslatedText { get; set; } = string.Empty;
}

public class PromotionTranslationRequest
{
    public int SpecialOfferID { get; set; }
    public string Description { get; set; } = string.Empty;
    public double DiscountPct { get; set; }
    public string Type { get; set; } = string.Empty;
    public string Category { get; set; } = string.Empty;
    public string StartDate { get; set; } = string.Empty;
    public string EndDate { get; set; } = string.Empty;
    public int MinQty { get; set; }
    public int? MaxQty { get; set; }
}

public class PromotionTranslationResult
{
    public bool Success { get; set; }
    public int CulturesProcessed { get; set; }
    public string Message { get; set; } = string.Empty;
}
