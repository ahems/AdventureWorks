using ApiFunctions.Auth;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

public sealed class ChatIdentityService(
    FunctionsAccessTokenValidator validator,
    IConfiguration configuration,
    ILogger<ChatIdentityService> logger)
{
    public async Task<FunctionUser?> ResolveAsync(string token, CancellationToken cancellationToken)
    {
        var validation = await validator.ValidateMcpAsync(token, cancellationToken);
        if (!validation.Succeeded)
        {
            logger.LogWarning("Chat authentication rejected: {Reason}", validation.Error);
            return null;
        }

        var caller = FunctionUser.FromPrincipal(validation.Principal!);
        if (!caller.HasScope("mcp.access") || string.IsNullOrEmpty(caller.SubjectId)
            || string.IsNullOrEmpty(caller.Category))
        {
            logger.LogWarning("Chat authentication rejected: missing identity or mcp.access scope");
            return null;
        }
        if (!caller.IsConsumer) return caller;

        // MCP tokens deliberately omit owner claims. Resolve the signed subject, never a body ID.
        await using var connection = new SqlConnection(configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured"));
        var customer = await connection.QuerySingleOrDefaultAsync<CustomerIdentity>(new CommandDefinition("""
            SELECT p.BusinessEntityID, p.FirstName,
                (SELECT MIN(c.CustomerID) FROM Sales.Customer c WHERE c.PersonID = p.BusinessEntityID) AS CustomerID
            FROM Person.Person p
            WHERE LOWER(CONVERT(varchar(36), p.rowguid)) = @Subject
            """, new { Subject = caller.SubjectId }, cancellationToken: cancellationToken));
        if (customer is null)
        {
            logger.LogWarning("Chat authentication rejected: customer identity no longer exists");
            return null;
        }
        return new FunctionUser
        {
            SubjectId = caller.SubjectId,
            Category = caller.Category,
            DisplayName = customer.FirstName,
            CustomerId = customer.CustomerID,
            BusinessEntityId = customer.BusinessEntityID,
            Scopes = caller.Scopes,
            Roles = caller.Roles,
            IsAuthenticated = true
        };
    }

    private sealed class CustomerIdentity
    {
        public int BusinessEntityID { get; set; }
        public int? CustomerID { get; set; }
        public string? FirstName { get; set; }
    }
}
