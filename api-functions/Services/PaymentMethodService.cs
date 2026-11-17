using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

public sealed record SavedPaymentCard(int Id, string CardType, string Last4, byte ExpMonth, short ExpYear);

public interface IPaymentMethodService
{
    Task<IReadOnlyList<SavedPaymentCard>> GetForPersonAsync(int businessEntityId);
}

public sealed class PaymentMethodService(string connectionString) : IPaymentMethodService
{
    public async Task<IReadOnlyList<SavedPaymentCard>> GetForPersonAsync(int businessEntityId)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(businessEntityId);
        await using var connection = new SqlConnection(connectionString);
        var cards = await connection.QueryAsync<SavedPaymentCard>("""
            SELECT cc.CreditCardID AS Id, cc.CardType, RIGHT(cc.CardNumber, 4) AS Last4,
                   cc.ExpMonth, cc.ExpYear
            FROM Sales.PersonCreditCard AS pc
            INNER JOIN Sales.CreditCard AS cc ON cc.CreditCardID = pc.CreditCardID
            WHERE pc.BusinessEntityID = @BusinessEntityId
            ORDER BY cc.CreditCardID
            """, new { BusinessEntityId = businessEntityId });
        return cards.AsList();
    }
}
