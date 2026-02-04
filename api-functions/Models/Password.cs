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
