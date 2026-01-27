# Password Reset Flow - Testing Guide

## Overview

The AdventureWorks application implements a secure password reset flow with token-based authentication and email notifications. This document describes the complete flow, security considerations, and testing procedures.

## Password Reset Flow

### Flow Diagram

```
User                Frontend            API Functions           Database           Email Service
 |                     |                      |                      |                    |
 |  Forgot Password    |                      |                      |                    |
 |-------------------->|                      |                      |                    |
 |                     |  POST /reset/request |                      |                    |
 |                     |--------------------->|                      |                    |
 |                     |                      | Lookup User          |                    |
 |                     |                      |--------------------->|                    |
 |                     |                      |<---------------------|                    |
 |                     |                      | Generate Token       |                    |
 |                     |                      | Store Token          |                    |
 |                     |                      |--------------------->|                    |
 |                     |                      |<---------------------|                    |
 |                     |                      | Send Email           |                    |
 |                     |                      |-------------------------------------->|
 |                     |<---------------------|                      |                    |
 |  Check Email        |                      |                      |                    |
 |<--------------------|                      |                      |                    |
 |                     |                      |                      |                    |
 |  Click Reset Link   |                      |                      |                    |
 |<-----------------------------------------------------------------------|
 |-------------------->|                      |                      |                    |
 |                     |  POST /reset/validate|                      |                    |
 |                     |--------------------->|                      |                    |
 |                     |                      | Validate Token       |                    |
 |                     |                      |--------------------->|                    |
 |                     |                      |<---------------------|                    |
 |                     |<---------------------|                      |                    |
 |                     |                      |                      |                    |
 |  Enter New Password |                      |                      |                    |
 |-------------------->|                      |                      |                    |
 |                     |  POST /reset/complete|                      |                    |
 |                     |--------------------->|                      |                    |
 |                     |                      | Validate Token       |                    |
 |                     |                      |--------------------->|                    |
 |                     |                      |<---------------------|                    |
 |                     |                      | Update Password      |                    |
 |                     |                      |--------------------->|                    |
 |                     |                      |<---------------------|                    |
 |                     |<---------------------|                      |                    |
 |  Password Reset     |                      |                      |                    |
 |<--------------------|                      |                      |                    |
```

## API Endpoints

### 1. Request Password Reset

**Endpoint:** `POST /api/password/reset/request`

**Request Body:**

```json
{
  "email": "user@example.com"
}
```

**Response (200 OK):**

```json
{
  "message": "If this email exists, a password reset link has been sent.",
  "debug": {
    "token": "ZBFCKJPG",
    "resetUrl": "http://localhost:5173/reset-password?token=ZBFCKJPG&id=1"
  }
}
```

**Behavior:**

- Looks up user by email address
- Generates 8-character alphanumeric token
- Stores token in database (in `PasswordSalt` field) with 1-hour expiry
- Sends email with reset link
- Returns success even if email doesn't exist (security best practice)
- Debug info included in response (remove in production)

### 2. Validate Reset Token

**Endpoint:** `POST /api/password/reset/validate`

**Request Body:**

```json
{
  "businessEntityID": 1,
  "token": "ZBFCKJPG"
}
```

**Response (200 OK):**

```json
{
  "isValid": true
}
```

**Validation Checks:**

- Token matches stored token
- Token has not expired (1 hour from creation)
- User exists in database

### 3. Complete Password Reset

**Endpoint:** `POST /api/password/reset/complete`

**Request Body:**

```json
{
  "businessEntityID": 1,
  "token": "ZBFCKJPG",
  "newPassword": "NewSecurePassword123!"
}
```

**Response (200 OK):**

```json
{
  "message": "Password successfully reset"
}
```

**Response (401 Unauthorized):**

```json
{
  "error": "Invalid or expired reset token"
}
```

**Response (400 Bad Request):**

```json
{
  "error": "Password must be at least 8 characters long"
}
```

**Behavior:**

- Validates token (same as validate endpoint)
- Validates password length (minimum 8 characters)
- Updates password with PBKDF2 hash
- Automatically clears token (token is overwritten by new password salt)

## Security Features

### Token Generation

- **8-character alphanumeric tokens** using cryptographically secure random generation
- Characters exclude ambiguous characters (0, O, I, 1, etc.)
- Stored in `Person.Password.PasswordSalt` field (varchar(10))

### Token Storage

- Token is stored temporarily in the `PasswordSalt` field
- `ModifiedDate` is used to track token creation time for expiry
- When password is reset, the token is automatically cleared

### Token Expiry

- **1 hour validity** from token creation
- Checked on both validation and completion endpoints
- Expired tokens are rejected with 401 status

### Token Reuse Prevention

- Token is automatically cleared when used to reset password
- Subsequent attempts with same token are rejected
- Provides protection against replay attacks

### Email Security

- Generic success message prevents email enumeration
- Always returns 200 OK even if email doesn't exist
- Prevents attackers from discovering valid email addresses

### Password Requirements

- Minimum 8 characters
- Validated on both set and reset operations
- Uses PBKDF2 with 100,000 iterations

## Testing

### Automated Test Script

A comprehensive test script is provided: `test-password-reset-flow.sh`

**Run the test:**

```bash
# Test against deployed Azure Functions (uses azd env values)
./test-password-reset-flow.sh

# Test against a specific URL
./test-password-reset-flow.sh https://your-function-app.azurecontainerapps.io
```

### Test Coverage

The test script validates the following scenarios:

1. **Request Password Reset**
   - Valid email generates token and sends email
   - Non-existent email returns success (security check)

2. **Validate Reset Token**
   - Valid token returns `isValid: true`
   - Invalid token returns `isValid: false`
   - Expired tokens are rejected

3. **Complete Password Reset**
   - Valid token allows password change
   - Invalid token is rejected (401)
   - Short passwords are rejected (400)
   - Token cannot be reused after password change

4. **Password Verification**
   - Old password no longer works after reset
   - New password works correctly
   - Password verification uses secure comparison

5. **Security Checks**
   - Token reuse prevention
   - Email enumeration protection
   - Password length validation

### Test Output

```bash
=========================================
Testing Password Reset Flow
=========================================
Function URL: https://your-function-app.azurecontainerapps.io

Test Configuration:
  Email: ken0@adventure-works.com
  Business Entity ID: 1

Step 0: Setting up initial password...
✓ Initial password set

Step 1: Requesting password reset...
✓ Password reset requested successfully
  Token: ZBFCKJPG

Step 2: Validating reset token...
✓ Token validated successfully

Step 2a: Testing invalid token validation...
✓ Invalid token correctly rejected

Step 3: Completing password reset with new password...
✓ Password reset completed successfully

Step 4: Verifying old password no longer works...
✓ Old password correctly rejected

Step 5: Verifying new password works...
✓ New password verified successfully

Step 6: Testing token reuse protection...
✓ Token reuse correctly prevented

Step 7: Testing password validation rules...
✓ Short password correctly rejected

Step 8: Testing with non-existent email...
✓ Non-existent email handled securely

Cleanup: Restoring original password...
✓ Original password restored

=========================================
✓ ALL PASSWORD RESET FLOW TESTS PASSED!
=========================================
```

## Database Schema

The password reset flow reuses the existing `Person.Password` table:

```sql
CREATE TABLE [Person].[Password](
    [BusinessEntityID] [int] NOT NULL,
    [PasswordHash] [varchar](128) NOT NULL,     -- Stores password hash
    [PasswordSalt] [varchar](10) NOT NULL,      -- Temporarily stores reset token
    [rowguid] uniqueidentifier NOT NULL,
    [ModifiedDate] [datetime] NOT NULL          -- Used for token expiry
)
```

**Token Storage Strategy:**

- During normal operation: `PasswordSalt` contains the salt for PBKDF2 hashing
- During reset flow: `PasswordSalt` temporarily stores the 8-character reset token
- After reset: `PasswordSalt` is overwritten with new salt

## Email Template

The password reset email includes:

- Personalized greeting with user's first name
- Reset link button with token
- Plain text URL as fallback
- 1-hour expiry notice
- AdventureWorks branding
- Security notice about ignoring unwanted requests

**Sample Email:**

```
Subject: Password Reset Request - AdventureWorks

Hey Ken! 👋

We received a request to reset your password. If you didn't make this
request, you can safely ignore this email.

To reset your password, click the button below. This link will expire
in 1 hour.

[Reset My Password 🔑]

If the button doesn't work, copy and paste this link into your browser:
http://localhost:5173/reset-password?token=ZBFCKJPG&id=1

Stay secure on your adventures! 🚴
```

## Manual Testing

### Using curl

```bash
# Get the Azure Functions URL
FUNCTION_URL=$(azd env get-values | grep "^API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"')

# 1. Request password reset
curl -X POST "$FUNCTION_URL/api/password/reset/request" \
  -H "Content-Type: application/json" \
  -d '{"email": "ken0@adventure-works.com"}'

# Extract token from response
TOKEN="ZBFCKJPG"

# 2. Validate token
curl -X POST "$FUNCTION_URL/api/password/reset/validate" \
  -H "Content-Type: application/json" \
  -d '{"businessEntityID": 1, "token": "'$TOKEN'"}'

# 3. Complete password reset
curl -X POST "$FUNCTION_URL/api/password/reset/complete" \
  -H "Content-Type: application/json" \
  -d '{
    "businessEntityID": 1,
    "token": "'$TOKEN'",
    "newPassword": "NewPassword123!"
  }'

# 4. Verify new password works
curl -X POST "$FUNCTION_URL/api/password/verify" \
  -H "Content-Type: application/json" \
  -d '{"businessEntityID": 1, "password": "NewPassword123!"}'
```

### Using Frontend

The frontend reset password flow would typically:

1. User clicks "Forgot Password" link
2. User enters email address
3. Frontend calls `/api/password/reset/request`
4. User receives email with reset link
5. User clicks link, redirected to `/reset-password?token=XXX&id=1`
6. Frontend validates token with `/api/password/reset/validate`
7. User enters new password
8. Frontend calls `/api/password/reset/complete`
9. User is redirected to login page

## Troubleshooting

### Token Expired

**Symptoms:** Token validation returns `isValid: false` or complete returns 401

**Solutions:**

- Tokens expire after 1 hour
- Request a new password reset
- Check system time is synchronized

### Email Not Received

**Symptoms:** User doesn't receive reset email

**Solutions:**

- Check email service configuration
- Verify `EMAIL_SENDER_DOMAIN` environment variable
- Check spam/junk folder
- Review Function App logs for email sending errors

### Token Not Found

**Symptoms:** Token validation fails immediately

**Solutions:**

- Verify user exists in database
- Check `Person.Password` table has record for user
- Ensure token request completed successfully

### Password Requirements Not Met

**Symptoms:** 400 error when completing reset

**Solutions:**

- Ensure password is at least 8 characters
- Update password requirements in frontend validation
- Check error message for specific requirement

## Production Considerations

### Remove Debug Information

Remove the `debug` object from the password reset request response:

```csharp
// Development
await successResponse.WriteAsJsonAsync(new
{
    message = "If this email exists, a password reset link has been sent.",
    debug = new { token, resetUrl }  // REMOVE THIS IN PRODUCTION
});

// Production
await successResponse.WriteAsJsonAsync(new
{
    message = "If this email exists, a password reset link has been sent."
});
```

### Email Service Configuration

Ensure the following environment variables are set:

- `COMMUNICATION_SERVICE_ENDPOINT`
- `COMMUNICATION_SERVICE_NAME`
- `EMAIL_SENDER_DOMAIN`

### Rate Limiting

Consider implementing rate limiting on the reset request endpoint to prevent:

- Email flooding attacks
- Password reset spam
- Resource exhaustion

### Logging

The functions log important events:

- Password reset requests (including email addresses)
- Successful password resets
- Failed validation attempts
- Email sending errors

Monitor these logs in Application Insights for security monitoring.

### Token Length

The current implementation uses 8-character tokens to fit in the `varchar(10)` `PasswordSalt` field. Consider:

- Increasing database field size for longer tokens
- Using a dedicated password reset token table
- Implementing cryptographic hashing of tokens

## Related Documentation

- [PASSWORD_IMPLEMENTATION.md](PASSWORD_IMPLEMENTATION.md) - Password hashing implementation details
- [SEND_EMAIL_FUNCTION.md](SEND_EMAIL_FUNCTION.md) - Email service implementation
- [PASSWORD_RESET_FLOW.md](PASSWORD_RESET_FLOW.md) - This document
