namespace AddressFunctions.Models;

/// <summary>
/// Represents a password entry in the Person.Password table
/// </summary>
public class Password
{
    public int BusinessEntityID { get; set; }
    public string PasswordHash { get; set; } = string.Empty;
    public string PasswordSalt { get; set; } = string.Empty;
    public Guid rowguid { get; set; }
    public DateTime ModifiedDate { get; set; }
}

/// <summary>
/// DTO for setting a new password
/// </summary>
public class SetPasswordRequest
{
    public int BusinessEntityID { get; set; }
    public string Password { get; set; } = string.Empty;
}

/// <summary>
/// DTO for server-side e-shop customer registration
/// </summary>
public class SignupRequest
{
    public string? Email { get; set; }
    public string Password { get; set; } = string.Empty;
    public string? FirstName { get; set; }
    public string? LastName { get; set; }
}

/// <summary>
/// Identifiers of a newly registered customer
/// </summary>
public sealed record CreatedCustomerAccount(int BusinessEntityId, int EmailAddressId);

/// <summary>
/// DTO for verifying a password
/// </summary>
public class VerifyPasswordRequest
{
    public int BusinessEntityID { get; set; }
    public string Password { get; set; } = string.Empty;
}

/// <summary>
/// Response for password verification
/// </summary>
public class VerifyPasswordResponse
{
    public bool IsValid { get; set; }
    public string Message { get; set; } = string.Empty;
}
