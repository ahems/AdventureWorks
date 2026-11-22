using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

public sealed record SavedPaymentCard(int Id, string CardType, string Last4, byte ExpMonth, short ExpYear);

public sealed record NewPaymentCard(string CardType, string Last4, byte ExpMonth, short ExpYear)
{
    /// <summary>Only a masked value is ever persisted in Sales.CreditCard.CardNumber (nvarchar(25)).</summary>
    public string MaskedCardNumber => new string('*', 12) + Last4;
}

public interface IPaymentMethodService
{
    Task<IReadOnlyList<SavedPaymentCard>> GetForPersonAsync(int businessEntityId);
    Task<SavedPaymentCard> AddForPersonAsync(int businessEntityId, NewPaymentCard card);
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

    public async Task<SavedPaymentCard> AddForPersonAsync(int businessEntityId, NewPaymentCard card)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(businessEntityId);
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();
        var id = await connection.ExecuteScalarAsync<int>("""
            INSERT INTO Sales.CreditCard (CardType, CardNumber, ExpMonth, ExpYear, ModifiedDate)
            OUTPUT INSERTED.CreditCardID
            VALUES (@CardType, @CardNumber, @ExpMonth, @ExpYear, SYSUTCDATETIME());
            """, new { card.CardType, CardNumber = card.MaskedCardNumber, card.ExpMonth, card.ExpYear }, transaction);
        await connection.ExecuteAsync("""
            INSERT INTO Sales.PersonCreditCard (BusinessEntityID, CreditCardID, ModifiedDate)
            VALUES (@BusinessEntityId, @CreditCardId, SYSUTCDATETIME());
            """, new { BusinessEntityId = businessEntityId, CreditCardId = id }, transaction);
        await transaction.CommitAsync();
        return new SavedPaymentCard(id, card.CardType, card.Last4, card.ExpMonth, card.ExpYear);
    }
}
