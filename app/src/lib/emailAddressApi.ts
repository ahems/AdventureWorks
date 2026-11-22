export interface SavedEmailAddress {
  EmailAddressID: number;
  BusinessEntityID: number;
  EmailAddress: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const DUPLICATE_EMAIL_MESSAGE =
  "This email address is already used by another account. Please use a different email address.";

/**
 * Email writes go through DAB REST rather than GraphQL because REST maps the
 * UQ_EmailAddress_EmailAddress unique-constraint violation to HTTP 409, which
 * lets the storefront show a precise duplicate-email message.
 */
async function readSaved(
  response: Response,
  action: string,
): Promise<SavedEmailAddress> {
  if (response.status === 409) {
    throw new Error(DUPLICATE_EMAIL_MESSAGE);
  }
  if (!response.ok) {
    throw new Error(`Failed to ${action} email address (${response.status}).`);
  }
  const body = (await response.json()) as { value?: SavedEmailAddress[] };
  const saved = body.value?.[0];
  if (!saved) {
    throw new Error(`Failed to ${action} email address.`);
  }
  return saved;
}

export async function createEmailAddress(
  fetcher: Fetcher,
  restApiUrl: string,
  businessEntityId: number,
  emailAddress: string,
): Promise<SavedEmailAddress> {
  const response = await fetcher(
    `${restApiUrl.replace(/\/$/, "")}/EmailAddress`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessEntityID: businessEntityId,
        EmailAddress: emailAddress.trim(),
      }),
    },
  );
  return readSaved(response, "add");
}

export async function updateEmailAddress(
  fetcher: Fetcher,
  restApiUrl: string,
  businessEntityId: number,
  emailAddressId: number,
  emailAddress: string,
): Promise<SavedEmailAddress> {
  const response = await fetcher(
    `${restApiUrl.replace(/\/$/, "")}/EmailAddress/BusinessEntityID/${businessEntityId}/EmailAddressID/${emailAddressId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ EmailAddress: emailAddress.trim() }),
    },
  );
  return readSaved(response, "update");
}
