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
- **Forgot password:** the customer requests a reset, receives an email with a short code link, and chooses a new password on the storefront `/reset-password` page.
- **Admin reset:** on the admin **Customers** page, staff can send a reset email or set a new password for a customer.

## Try it

- **UI (customer):** on the storefront sign-in page choose **Forgot password**, enter your email, then follow the emailed link.
- **UI (admin):** open **Customers**, select a customer and use **Reset password**.
- **API:** the reset routes are public. Setting or verifying a password needs a consumer token for that customer; [`tests/scripts/test-password-functions.sh`](../../../tests/scripts/test-password-functions.sh) and [`tests/scripts/test-password-reset-flow.sh`](../../../tests/scripts/test-password-reset-flow.sh) show the full calls with a disposable consumer.

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
  F->>S: Look up person; store 1-hour reset code
  F->>ACS: Email link /reset-password?token=...&id=...
  F-->>B: 200 (same message whether or not the email exists)
  U->>B: Open link
  B->>F: POST /api/password/reset/validate
  F-->>B: Code valid?
  U->>B: New password
  B->>F: POST /api/password/reset/complete
  F->>S: Store new PBKDF2 hash
  F-->>B: 200 (401 if the code is invalid or expired)
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
| `POST /api/password/reset/request` | `{ email }`: send a reset email |
| `POST /api/password/reset/validate` | Check a reset code |
| `POST /api/password/reset/complete` | Set the new password with a valid code |

Reset codes are 8 characters from an alphabet without look-alike characters (no `0`, `O`, `1`, `I`) and expire after 1 hour.

## Data & storage

`Person.Password` holds the hash and salt. Reset codes are stored with the person and expire after 1 hour. No passwords are logged or returned.

## Events (Web PubSub)

None.

## Security

| Route | Access |
|---|---|
| `POST /api/password` | `customers.write`; the signed-in customer for themselves, or internal staff for customer accounts only |
| `POST /api/password/verify` | `customers.read`; the signed-in customer only |
| Reset routes | Public |

The reset request responds identically whether or not the email exists. See [Functions route scopes](../functions-oauth/ROUTE_SCOPE_MATRIX.md) and [identity and auth](../../architecture/identity-and-auth.md).

## Configuration

| Setting | Purpose |
|---|---|
| `FRONTEND_URL` | Storefront base URL for reset links |
| `COMMUNICATION_SERVICE_ENDPOINT`, `EMAIL_SENDER_DOMAIN` | Sending the reset email |

## Limits

- AdventureWorks sample people do not share a known password. The seeded demo employees Ken (`ken0@adventure-works.com`) and Peter (`peter0@adventure-works.com`) are the identities with a documented demo password; see [authenticated scripts](../../testing/AZURE_AUTHENTICATED_SCRIPTS.md).
- Sample email addresses on reserved domains are suppressed, so reset emails only reach real addresses you add.

## Related code & docs

- `api-functions/Functions/PasswordFunctions.cs`, `PasswordResetFunctions.cs`, `api-functions/Services/PasswordService.cs`
- `app/src/pages/ResetPasswordPage.tsx`, `app/src/pages/AuthPage.tsx`
- `app-admin/src/components/AdminPasswordReset.tsx`
- [Accounts and sign-in](accounts-and-sign-in.md) · [Email notifications](../email/email-notifications.md)
