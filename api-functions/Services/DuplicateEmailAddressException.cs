using Microsoft.Data.SqlClient;

namespace api_functions.Services;

/// <summary>
/// Raised when an email address is already registered to another person. The seed job enforces
/// this with the <c>UQ_EmailAddress_EmailAddress</c> constraint because sign-in resolves users by email.
/// </summary>
public sealed class DuplicateEmailAddressException(Exception? innerException = null)
    : InvalidOperationException("This email address is already registered to another account.", innerException)
{
    /// <summary>SQL Server duplicate key errors: 2601 (unique index) and 2627 (unique/primary key constraint).</summary>
    public static bool IsDuplicateKeyError(int sqlErrorNumber) => sqlErrorNumber is 2601 or 2627;

    public static bool IsDuplicateKeyError(Exception exception) =>
        exception is SqlException sql && IsDuplicateKeyError(sql.Number);
}
