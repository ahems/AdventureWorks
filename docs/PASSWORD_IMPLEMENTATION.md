# Password Hashing Implementation

## Overview

This implementation adds secure password hashing functionality to the AdventureWorks demo site using the existing `Person.Password` table in the SQL database. The implementation uses **PBKDF2** (Password-Based Key Derivation Function 2) with SHA-256, which is a well-established standard for password hashing.

> **⚠️ Deployment Required**: After creating these new functions, deploy them to Azure with `azd deploy api-functions` to make them available.

## Quick Start

```bash
# Deploy the new password functions to Azure
azd deploy api-functions

# Test the deployed functions
./test-password-functions.sh
```

## Architecture

### Components

1. **Password.cs** - Data models for password operations
   - `Password`: Represents a password record in the database
   - `SetPasswordRequest`: DTO for setting/updating passwords
   - `VerifyPasswordRequest`: DTO for password verification
   - `VerifyPasswordResponse`: Response model for verification results

2. **PasswordService.cs** - Core password hashing service
   - `StorePasswordAsync()`: Creates or updates a password with secure hash and salt
   - `VerifyPasswordAsync()`: Verifies a password against stored credentials
   - `GetPasswordAsync()`: Retrieves password record for a business entity

3. **PasswordFunctions.cs** - Azure Functions HTTP endpoints
   - `SetPassword`: POST `/api/password` - Set or update a password
   - `VerifyPassword`: POST `/api/password/verify` - Verify a password

## Security Features

### PBKDF2 Configuration

```csharp
- Salt Size: 10 bytes (stored as base64 in varchar(10))
- Hash Size: 96 bytes (stored as base64 in varchar(128))
- Iterations: 100,000 (meets OWASP recommendations)
- Algorithm: SHA-256
```

### Security Measures

1. **Cryptographically Secure Random Salt**: Uses `RandomNumberGenerator.Create()` for salt generation
2. **Timing-Safe Comparison**: Uses `CryptographicOperations.FixedTimeEquals()` to prevent timing attacks
3. **No Plain Text Storage**: Passwords are never stored in plain text
4. **Automatic Hashing**: All password storage automatically generates new hash and salt

## Database Schema

The implementation uses the existing `Person.Password` table:

```sql
CREATE TABLE [Person].[Password](
    [BusinessEntityID] [int] NOT NULL,
    [PasswordHash] [varchar](128) NOT NULL,
    [PasswordSalt] [varchar](10) NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL,
    [ModifiedDate] [datetime] NOT NULL
)
```

## API Endpoints

### 1. Set Password

**Endpoint**: `POST /api/password`

**Request Body**:

```json
{
  "businessEntityID": 1,
  "password": "SecurePassword123!"
}
```

**Response** (200 OK):

```json
{
  "message": "Password successfully set",
  "businessEntityID": 1
}
```

**Validation**:

- Password must be at least 8 characters
- BusinessEntityID must be positive
- Password cannot be empty

### 2. Verify Password

**Endpoint**: `POST /api/password/verify`

**Request Body**:

```json
{
  "businessEntityID": 1,
  "password": "SecurePassword123!"
}
```

**Response** (200 OK):

```json
{
  "isValid": true,
  "message": "Password is valid"
}
```

If password is incorrect:

```json
{
  "isValid": false,
  "message": "Invalid password or user not found"
}
```

## Usage Examples

### Using curl

```bash
# Get the Azure Functions URL
FUNCTION_URL=$(azd env get-values | grep "^API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"')

# Set a password
curl -X POST "$FUNCTION_URL/api/password" \
  -H "Content-Type: application/json" \
  -d '{"businessEntityID": 1, "password": "SecurePassword123!"}'

# Verify a password
curl -X POST "$FUNCTION_URL/api/password/verify" \
  -H "Content-Type: application/json" \
  -d '{"businessEntityID": 1, "password": "SecurePassword123!"}'
```

### Using JavaScript/TypeScript (Frontend)

```typescript
// Get the Functions URL from environment config
const FUNCTIONS_URL =
  window.config?.API_FUNCTIONS_URL || import.meta.env.VITE_API_FUNCTIONS_URL;

// Set password
async function setPassword(businessEntityId: number, password: string) {
  const response = await fetch(`${FUNCTIONS_URL}/api/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessEntityID: businessEntityId, password }),
  });
  return await response.json();
}

// Verify password
async function verifyPassword(businessEntityId: number, password: string) {
  const response = await fetch(`${FUNCTIONS_URL}/api/password/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessEntityID: businessEntityId, password }),
  });
  const result = await response.json();
  return result.isValid;
}
```

## Testing

A comprehensive test script is provided: `test-password-functions.sh`

```bash
# Test against deployed Azure functions (uses azd env values)
./test-password-functions.sh

# Test against a specific URL
./test-password-functions.sh https://your-function-app.azurewebsites.net
```

The test script validates:

1. Password creation
2. Correct password verification
3. Wrong password rejection
4. Password update functionality
5. Input validation

## Local Development

For local development and testing:

1. Ensure the local database connection is configured:

   ```bash
   ./setup-local-dev.sh
   ```

2. Start the Functions:

   ```bash
   cd api-functions
   func start
   ```

3. Test the endpoints against local Functions:
   ```bash
   ./test-password-functions.sh http://localhost:7071
   ```

## Azure Deployment

The password functions are automatically deployed with the api-functions container:

```bash
azd deploy api-functions
```

**Note**: After adding new functions, you must redeploy for them to be available in Azure.

The functions will be available at:

- `https://<function-app-url>/api/password`
- `https://<function-app-url>/api/password/verify`

You can get your deployed Functions URL with:

```bash
azd env get-values | grep API_FUNCTIONS_URL
```

## Integration with Frontend

To integrate with the React frontend:

1. Add password fields to the registration/login forms
2. Call the appropriate endpoints during:
   - User registration → `POST /api/password`
   - User login → `POST /api/password/verify`
3. Store only the BusinessEntityID in session/token (never store passwords)

## Important Notes

1. **Legacy Data**: Existing imported password data is ignored as the original hashing algorithm is unknown
2. **Demo Purpose**: This implementation uses PBKDF2 which is suitable for a demo. Production systems should consider:
   - Additional password complexity requirements
   - Account lockout after failed attempts
   - Password history to prevent reuse
   - Rate limiting on verification endpoint
   - Multi-factor authentication
3. **Authentication**: The current implementation uses `AuthorizationLevel.Anonymous` for demo purposes. In production, consider adding proper authentication to the Function endpoints.

## Password Hashing Process

1. **Setting a Password**:

   ```
   User Password → Generate Random Salt → PBKDF2 Hash → Store (Hash + Salt)
   ```

2. **Verifying a Password**:
   ```
   User Password → Retrieve Stored Salt → PBKDF2 Hash → Compare with Stored Hash
   ```

## Dependencies

No additional NuGet packages required. Uses built-in .NET libraries:

- `System.Security.Cryptography` for PBKDF2 and cryptographic operations
- `Microsoft.Data.SqlClient` for database access (already in project)
- `Dapper` for SQL operations (already in project)

## Error Handling

All functions include comprehensive error handling:

- Input validation errors return 400 Bad Request
- Database errors return 500 Internal Server Error
- All errors are logged with Application Insights integration

## Performance

PBKDF2 with 100,000 iterations is intentionally slow to prevent brute-force attacks:

- Password hashing: ~100-200ms
- Password verification: ~100-200ms

This is a security feature, not a performance issue.
