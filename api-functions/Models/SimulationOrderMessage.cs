namespace api_functions.Models;

/// <summary>
/// Message posted to the <c>simulation-order-queue</c> queue.
/// Each message represents one autonomous AI-driven order-generation request.
///
/// Routing logic:
///   CustomerId == 0  → the AI picks a random persona (optionally guided by PersonaHint)
///   CustomerId  > 0  → the AI generates a realistic next-purchase for that specific customer
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
}
