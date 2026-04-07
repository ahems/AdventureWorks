namespace api_functions.Models;

/// <summary>
/// Represents a unit of AI work placed onto one of the model-specific AI job queues.
/// All AI-generating operations use this queue so they are processed one at a time,
/// preventing Azure OpenAI rate-limit collisions regardless of how quickly the admin
/// user triggers jobs.
/// </summary>
public class AiJobMessage
{
    /// <summary>
    /// Discriminator for the dispatcher. Values:
    /// "image"              – generate product photo(s) for one product
    /// "translation"        – translate descriptions + names for one product model
    /// "review"             – generate reviews for a batch of products
    /// "product-embeddings" – (re)generate embeddings for all product descriptions
    /// "review-embeddings"  – (re)generate embeddings for all product reviews
    /// "generate-order"     – generate a single AI order for a persona (bulk order generation)
    /// </summary>
    public string JobType { get; set; } = string.Empty;

    /// <summary>ProductID for "image" jobs.</summary>
    public int? ProductId { get; set; }

    /// <summary>ProductModelID for "translation" jobs.</summary>
    public int? ProductModelId { get; set; }

    /// <summary>Batch of product IDs for "review" jobs.</summary>
    public List<int>? ProductIds { get; set; }

    /// <summary>Optional override for reviews-per-product count on "review" jobs.</summary>
    public int? ReviewsPerProduct { get; set; }

    /// <summary>Persona type for "generate-order" jobs.</summary>
    public string? PersonaType { get; set; }

    /// <summary>Optional seed customer ID for "generate-order" jobs with persona "existing-customer".</summary>
    public int? SeedCustomerId { get; set; }
}
