namespace AddressFunctions.Models;

/// <summary>
/// Represents an address in the Person.Address table
/// </summary>
public class Address
{
    public int AddressID { get; set; }
    public string AddressLine1 { get; set; } = string.Empty;
    public string? AddressLine2 { get; set; }
    public string City { get; set; } = string.Empty;
    public int StateProvinceID { get; set; }
    public string PostalCode { get; set; } = string.Empty;
    public Guid rowguid { get; set; }
    public DateTime ModifiedDate { get; set; }
}

/// <summary>
/// DTO for creating a new address (excludes auto-generated fields)
/// </summary>
public class CreateAddressRequest
{
    public string AddressLine1 { get; set; } = string.Empty;
    public string? AddressLine2 { get; set; }
    public string City { get; set; } = string.Empty;
    public int StateProvinceID { get; set; }
    public string PostalCode { get; set; } = string.Empty;

    // Optional: For creating BusinessEntityAddress link
    public int? BusinessEntityID { get; set; }
    public int? AddressTypeID { get; set; }
}

/// <summary>
/// DTO for updating an existing address
/// </summary>
public class UpdateAddressRequest
{
    public string? AddressLine1 { get; set; }
    public string? AddressLine2 { get; set; }
    public string? City { get; set; }
    public int? StateProvinceID { get; set; }
    public string? PostalCode { get; set; }
}
