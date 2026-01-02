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
}
