using Bogus;

namespace AdventureWorks.Services;

/// <summary>
/// Generates complete random customer profiles using Bogus, including address,
/// phone, email, password, and credit card data. Only generates for countries
/// that map to cultures supported by the AdventureWorks site.
/// </summary>
public class CustomerGeneratorService
{
    /// <summary>
    /// Mapping of supported culture codes to Bogus locale strings and country metadata.
    /// Only countries whose cultures are supported by the AdventureWorks site are included.
    /// </summary>
    private static readonly CountryLocaleInfo[] SupportedCountries =
    [
        new("US", "en",     "United States",   "+1",  "en"),
        new("GB", "en_GB",  "United Kingdom",  "+44", "en-gb"),
        new("CA", "en",     "Canada",          "+1",  "en-ca"),
        new("AU", "en_AU",  "Australia",       "+61", "en-au"),
        new("NZ", "en",     "New Zealand",     "+64", "en-nz"),
        new("IE", "en_IE",  "Ireland",         "+353","en-ie"),
        new("ES", "es",     "Spain",           "+34", "es"),
        new("FR", "fr",     "France",          "+33", "fr"),
        new("DE", "de",     "Germany",         "+49", "de"),
        new("PT", "pt_PT",  "Portugal",        "+351","pt"),
        new("IT", "it",     "Italy",           "+39", "it"),
        new("NL", "nl",     "Netherlands",     "+31", "nl"),
        new("RU", "ru",     "Russia",          "+7",  "ru"),
        new("CN", "zh_CN",  "China",           "+86", "zh"),
        new("TW", "zh_TW",  "Taiwan",          "+886","zh-cht"),
        new("JP", "ja",     "Japan",           "+81", "ja"),
        new("KR", "ko",     "South Korea",     "+82", "ko"),
        new("SA", "ar",     "Saudi Arabia",    "+966","ar"),
        new("IL", "he",     "Israel",          "+972","he"),
        new("TR", "tr",     "Turkey",          "+90", "tr"),
        new("VN", "vi",     "Vietnam",         "+84", "vi"),
        new("TH", "th",     "Thailand",        "+66", "th"),
        new("ID", "id_ID",  "Indonesia",       "+62", "id"),
    ];

    /// <summary>
    /// Card types used in AdventureWorks database (matching existing data conventions).
    /// </summary>
    private static readonly string[] CardTypes = ["Vista", "SuperiorCard", "Distinguish", "ColonialVoice"];

    public RandomCustomerProfile GenerateRandomCustomer()
    {
        // Pick a random country from supported cultures
        var country = SupportedCountries[Random.Shared.Next(SupportedCountries.Length)];
        return GenerateForCountry(country);
    }

    public RandomCustomerProfile GenerateRandomCustomerForLocale(string locale)
    {
        var country = SupportedCountries.FirstOrDefault(c =>
            c.CultureCode.Equals(locale, StringComparison.OrdinalIgnoreCase))
            ?? SupportedCountries[0]; // fallback to US

        return GenerateForCountry(country);
    }

    private static RandomCustomerProfile GenerateForCountry(CountryLocaleInfo country)
    {
        Faker faker;
        try
        {
            faker = new Faker(country.BogusLocale);
        }
        catch (BogusException)
        {
            // Locale not supported by Bogus — pick a random fallback from known-good locales
            var fallback = SupportedCountries
                .Where(c => c.BogusLocale != country.BogusLocale)
                .OrderBy(_ => Random.Shared.Next())
                .First();
            faker = new Faker(fallback.BogusLocale);
        }

        var firstName = faker.Name.FirstName();
        var lastName = faker.Name.LastName();

        // Generate a realistic personal email
        var emailDomains = new[] { "gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "protonmail.com", "icloud.com" };
        var emailDomain = emailDomains[Random.Shared.Next(emailDomains.Length)];
        var emailVariant = Random.Shared.Next(4);
        var email = emailVariant switch
        {
            0 => $"{firstName.ToLowerInvariant()}.{lastName.ToLowerInvariant()}@{emailDomain}",
            1 => $"{firstName.ToLowerInvariant()}{lastName.ToLowerInvariant()}{Random.Shared.Next(1, 99)}@{emailDomain}",
            2 => $"{firstName[..1].ToLowerInvariant()}{lastName.ToLowerInvariant()}@{emailDomain}",
            _ => $"{firstName.ToLowerInvariant()}.{lastName[..1].ToLowerInvariant()}{Random.Shared.Next(10, 999)}@{emailDomain}",
        };

        // Generate realistic international phone number
        var localNumber = faker.Phone.PhoneNumber();
        // Strip any existing country code formatting and rebuild
        var digitsOnly = new string(localNumber.Where(char.IsDigit).ToArray());
        // Take last 9-10 digits as local number
        var localDigits = digitsOnly.Length > 10 ? digitsOnly[^10..] : digitsOnly;
        var phone = $"{country.PhonePrefix} {localDigits[..3]} {localDigits[3..6]} {localDigits[6..]}";

        // Generate address
        var addressLine1 = faker.Address.StreetAddress();
        var city = faker.Address.City();
        var stateCode = faker.Address.StateAbbr();
        var postalCode = faker.Address.ZipCode();

        // Generate a secure-looking password (12-16 chars, mixed case, digits, special)
        var password = GeneratePassword();

        // Generate credit card
        var cardType = CardTypes[Random.Shared.Next(CardTypes.Length)];
        var cardNumber = GenerateCreditCardNumber();
        var now = DateTime.UtcNow;
        var expMonth = (byte)Random.Shared.Next(1, 13);
        var expYear = (short)(now.Year + Random.Shared.Next(1, 6)); // 1-5 years from now

        return new RandomCustomerProfile
        {
            FirstName = firstName,
            LastName = lastName,
            Email = email,
            Phone = phone,
            AddressLine1 = addressLine1,
            City = city,
            StateCode = stateCode,
            PostalCode = postalCode,
            CountryCode = country.CountryCode,
            CountryName = country.CountryName,
            CultureCode = country.CultureCode,
            Password = password,
            CreditCardType = cardType,
            CreditCardNumber = cardNumber,
            CreditCardExpMonth = expMonth,
            CreditCardExpYear = expYear,
        };
    }

    private static string GeneratePassword()
    {
        const string upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const string lower = "abcdefghijklmnopqrstuvwxyz";
        const string digits = "0123456789";
        const string special = "!@#$%^&*";
        const string all = upper + lower + digits + special;

        var length = Random.Shared.Next(12, 17);
        var password = new char[length];

        // Guarantee at least one of each type
        password[0] = upper[Random.Shared.Next(upper.Length)];
        password[1] = lower[Random.Shared.Next(lower.Length)];
        password[2] = digits[Random.Shared.Next(digits.Length)];
        password[3] = special[Random.Shared.Next(special.Length)];

        for (int i = 4; i < length; i++)
            password[i] = all[Random.Shared.Next(all.Length)];

        // Shuffle to avoid predictable pattern
        Random.Shared.Shuffle(password);
        return new string(password);
    }

    private static string GenerateCreditCardNumber()
    {
        // Generate a valid-looking 16-digit card number using Luhn algorithm
        var digits = new int[16];

        // Random first 15 digits (starting with common prefixes)
        var prefixes = new[] { "4", "51", "52", "53", "54", "55", "37", "6011" };
        var prefix = prefixes[Random.Shared.Next(prefixes.Length)];

        for (int i = 0; i < prefix.Length; i++)
            digits[i] = prefix[i] - '0';

        for (int i = prefix.Length; i < 15; i++)
            digits[i] = Random.Shared.Next(10);

        // Calculate Luhn check digit
        var sum = 0;
        for (int i = 14; i >= 0; i--)
        {
            var d = digits[i];
            if ((15 - i) % 2 == 1)
            {
                d *= 2;
                if (d > 9) d -= 9;
            }
            sum += d;
        }
        digits[15] = (10 - (sum % 10)) % 10;

        return string.Join("", digits);
    }

    private record CountryLocaleInfo(
        string CountryCode,
        string BogusLocale,
        string CountryName,
        string PhonePrefix,
        string CultureCode);
}

public class RandomCustomerProfile
{
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string Phone { get; set; } = string.Empty;
    public string AddressLine1 { get; set; } = string.Empty;
    public string City { get; set; } = string.Empty;
    public string StateCode { get; set; } = string.Empty;
    public string PostalCode { get; set; } = string.Empty;
    public string CountryCode { get; set; } = string.Empty;
    public string CountryName { get; set; } = string.Empty;
    public string CultureCode { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public string CreditCardType { get; set; } = string.Empty;
    public string CreditCardNumber { get; set; } = string.Empty;
    public byte CreditCardExpMonth { get; set; }
    public short CreditCardExpYear { get; set; }
}
