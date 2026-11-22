---
title: Customer passwords and password reset
summary: How AdventureWorks stores customer passwords with PBKDF2-SHA256, how customers change or verify a password, and how the emailed password-reset flow works in the storefront and admin portal.
audience: [developer, security-reviewer, demo-presenter]
components: [app, app-admin, api-functions, api-mcp]
related:
  - accounts-and-sign-in.md
  - ../email/email-notifications.md
  - ../functions-oauth/ROUTE_SCOPE_MATRIX.md
  - ../../architecture/identity-and-auth.md
---

# Customer passwords and password reset

Passwords for AdventureWorks people are hashed with PBKDF2-SHA256 and stored in `Person.Password`. Azure Functions sets and verifies passwords and runs the emailed reset flow. The api-mcp OAuth server checks the same hash at sign-in.

## What it does

- **Set or change a password** for the signed-in customer (or, for internal staff, for a customer).
- **Verify a password** for the signed-in customer, for example before a sensitive change.
- **Forgot password:** a storefront customer requests a reset, receives an email with a one-time link, and chooses a new password on the storefront `/reset-password` page. The current password keeps working until the reset is completed.
- **Admin reset:** on the admin **Customers** page, staff can send a reset email or set a new password for a customer. Reset emails go only to individual storefront customers (`PersonType = 'IN'`) that already have a login. The admin portal uses a staff-only route that reports the outcome, so staff see when a customer is not eligible (for example a store contact or a person without a storefront login) or when the email was not delivered.

## Try it

- **UI (customer):** on the storefront sign-in page choose **Forgot password**, enter your email, then follow the emailed link.
- **UI (admin):** open **Customers**, select a customer and use **Reset password**.
- **API:** the reset routes are public. Setting or verifying a password needs a consumer token for that customer; [`tests/scripts/test-password-functions.sh`](../../../tests/scripts/test-password-functions.sh) and [`tests/scripts/test-password-reset-flow.sh`](../../../tests/scripts/test-password-reset-flow.sh) show the calls with a disposable consumer. Completing a reset needs the token from the emailed link.

## How it works

```mermaid
sequenceDiagram
  autonumber
  participant U as Customer
  participant B as Storefront
  participant F as Azure Functions
  participant S as Azure SQL
  participant ACS as Azure Communication Services
  U->>B: Forgot password (email)
  B->>F: POST /api/password/reset/request
  F->>S: Look up consumer login; replace any unused token with a new token hash (1 hour)
  F->>ACS: Email link {APP_URL}/reset-password?token=...&id=...
  F-->>B: 202 (same message whether or not the email exists; no token in the response)
  U->>B: Open link
  B->>F: POST /api/password/reset/validate
  F-->>B: Token valid?
  U->>B: New password
  B->>F: POST /api/password/reset/complete
  F->>S: Mark token used and store new PBKDF2 hash (one transaction)
  F-->>B: 200 (401 if the token is invalid, used or expired)
```

### Hashing

| Property | Value |
|---|---|
| Algorithm | PBKDF2 with HMAC-SHA256 |
| Iterations | 100,000 |
| Salt | 6 random bytes (8 Base64 characters) |
| Hash | 96 bytes, Base64-encoded |
| Storage | `Person.Password` (`PasswordHash`, `PasswordSalt`) |
| Minimum length | 8 characters |

### Routes

| Route | Purpose |
|---|---|
| `POST /api/password` | Set a password |
| `POST /api/password/verify` | Check a password |
| `POST /api/password/reset/request` | `{ email }`: send a reset email; always `202` with a generic message |
| `POST /api/password/reset/admin-request` | `{ businessEntityID, email }` (staff): send a reset email to that customer's login. Returns `200 sent`, `409 not-eligible`, `502 email-not-sent` or `503 not-configured` in `{ result, message }` |
| `POST /api/password/reset/validate` | `{ businessEntityID, token }`: check a reset token |
| `POST /api/password/reset/complete` | `{ businessEntityID, token, newPassword }`: set the new password with a valid token |

Reset tokens are 32 random bytes (Base64url), bound to one person, single use and valid for 1 hour. A new request replaces the person's previous unused token. The token is only ever sent by email; the link is built from the trusted `APP_URL` setting, never from request `Origin` or `Referer` headers.

## Data & storage

`Person.Password` holds the hash and salt and is only changed when a reset completes. `Person.PasswordResetToken` holds reset tokens: `BusinessEntityID`, the SHA-256 `TokenHash` (never the token itself), `CreatedUtc`, `ExpiresUtc` and `UsedUtc`. A filtered unique index allows one unused token per person. The seed job creates the table ([`seed-job/sql/password-reset-tokens.sql`](../../../seed-job/sql/password-reset-tokens.sql)). No passwords or tokens are logged or returned.

## Events (Web PubSub)

None.

## Security

| Route | Access |
|---|---|
| `POST /api/password` | `customers.write`; the signed-in customer for themselves, or internal staff for customer accounts only |
| `POST /api/password/verify` | `customers.read`; the signed-in customer only |
| Reset routes (`request`, `validate`, `complete`) | Public |
| `POST /api/password/reset/admin-request` | Internal staff with `customers.write` |

The public reset request responds identically whether or not the email exists. Only the internal staff route reports eligibility. See [Functions route scopes](../functions-oauth/ROUTE_SCOPE_MATRIX.md) and [identity and auth](../../architecture/identity-and-auth.md).

## Configuration

| Setting | Purpose |
|---|---|
| `APP_URL` | Storefront base URL for reset links. `api-functions-postdeploy.sh` sets it to the Static Web App URL; when missing or invalid, no reset email is sent and an error is logged |
| `COMMUNICATION_SERVICE_ENDPOINT`, `EMAIL_SENDER_DOMAIN` | Sending the reset email |

## Limits

- AdventureWorks sample people do not share a known password. The seeded demo employees Ken (`ken0@adventure-works.com`) and Peter (`peter0@adventure-works.com`) are the identities with a documented demo password; see [authenticated scripts](../../testing/AZURE_AUTHENTICATED_SCRIPTS.md).
- Sample email addresses on reserved domains are suppressed, so reset emails only reach real addresses you add.

## Related code & docs

- `api-functions/Functions/PasswordFunctions.cs`, `PasswordResetFunctions.cs`
- `api-functions/Services/PasswordService.cs`, `PasswordResetService.cs`, `EmailPasswordResetNotifier.cs`
- `seed-job/sql/password-reset-tokens.sql`
- `app/src/pages/ResetPasswordPage.tsx`, `app/src/pages/AuthPage.tsx`
- `app-admin/src/components/AdminPasswordReset.tsx`
- [Accounts and sign-in](accounts-and-sign-in.md) · [Email notifications](../email/email-notifications.md)
