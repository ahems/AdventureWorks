namespace api_functions.Models;

/// <summary>
/// Message posted to the <c>simulation-order-queue</c> queue.
/// Each message represents one autonomous AI-driven order-generation request.
///
/// Routing logic:
///   OrderMode determines the generation strategy:
///   - "new-persona"        → AI picks a random persona (default when CustomerId == 0 and no mode specified)
///   - "no-order-customer"  → existing registered customer with no orders, drawn to sale items
///   - "cart-recovery"      → customer with abandoned cart items, completes their purchase
///   - "existing-repeat"    → existing top-spender, AI generates next purchase
///   - "b2b-store"          → B2B store order based on store history and stock
/// </summary>
public class SimulationOrderMessage
{
    /// <summary>
    /// Target customer for the simulated order.
    /// Use <c>0</c> to let the agent pick a random new-customer persona.
    /// Use a positive BusinessEntityID to simulate the next purchase for an existing customer.
    /// </summary>
    public int CustomerId { get; set; }

    /// <summary>
    /// Optional hint about the persona or purchase context when <see cref="CustomerId"/> is 0.
    /// Examples: "mountain-enthusiast", "family-shopper", "commuter".
    /// When null or empty the agent randomly selects a persona.
    /// </summary>
    public string? PersonaHint { get; set; }

    /// <summary>
    /// Determines the order generation strategy. When null, legacy routing applies
    /// (CustomerId == 0 → new-persona, CustomerId > 0 → existing-repeat).
    /// </summary>
    public string? OrderMode { get; set; }

    /// <summary>
    /// Target store BusinessEntityID for B2B orders (when OrderMode == "b2b-store").
    /// </summary>
    public int? StoreId { get; set; }
}
