import { graphqlClient } from "./graphql-client";
import { gql } from "graphql-request";
import { getFunctionsApiUrl } from "./utils";
import {
  clearEshopOAuthSession,
  signInWithEshopCredentials,
} from "@/services/eshopOAuth";
import { trackError } from "@/lib/appInsights";
import { functionsFetch } from "@/services/functionsAuth";

export interface AuthUser {
  businessEntityId: number;
  email: string;
  firstName: string;
  lastName: string;
  emailAddressId?: number;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  user?: AuthUser;
}

// GraphQL response types
interface EmailAddressItem {
  EmailAddressID: number;
  BusinessEntityID: number;
  EmailAddress: string;
}

interface PersonItem {
  BusinessEntityID: number;
  FirstName: string;
  LastName: string;
  emailAddresses?: {
    items: EmailAddressItem[];
  };
}

interface CheckUserLoginResponse {
  emailAddresses: {
    items: EmailAddressItem[];
  };
}

interface GetPersonByIdResponse {
  people: {
    items: PersonItem[];
  };
}

interface UpdatePersonResponse {
  updateperson: {
    BusinessEntityID: number;
    FirstName: string;
    LastName: string;
  };
}

// GraphQL queries and mutations
const CHECK_USER_LOGIN = gql`
  query CheckUserLogin($email: String!) {
    emailAddresses(filter: { EmailAddress: { eq: $email } }) {
      items {
        EmailAddressID
        BusinessEntityID
        EmailAddress
      }
    }
  }
`;

const GET_PERSON_BY_ID = gql`
  query GetPersonById($businessEntityId: Int!) {
    people(filter: { BusinessEntityID: { eq: $businessEntityId } }) {
      items {
        BusinessEntityID
        FirstName
        LastName
        emailAddresses {
          items {
            EmailAddressID
            EmailAddress
          }
        }
      }
    }
  }
`;

const UPDATE_PERSON = gql`
  mutation UpdatePerson(
    $businessEntityId: Int!
    $firstName: String!
    $lastName: String!
  ) {
    updatePerson(
      BusinessEntityID: $businessEntityId
      item: { FirstName: $firstName, LastName: $lastName }
    ) {
      BusinessEntityID
      FirstName
      LastName
    }
  }
`;

const UPDATE_EMAIL_ADDRESS = gql`
  mutation UpdateEmailAddress($emailAddressId: Int!, $emailAddress: String!) {
    updateEmailAddress(
      EmailAddressID: $emailAddressId
      item: { EmailAddress: $emailAddress }
    ) {
      EmailAddressID
      EmailAddress
    }
  }
`;

/**
 * Login user - checks if user exists with given email and verifies password
 */
export async function loginUser(
  email: string,
  password: string,
): Promise<AuthResult> {
  try {
    await signInWithEshopCredentials(email, password);

    // Check if user exists
    const response = await graphqlClient.request<CheckUserLoginResponse>(
      CHECK_USER_LOGIN,
      {
        email,
      },
    );

    const emailAddresses = response.emailAddresses?.items || [];

    if (emailAddresses.length === 0) {
      clearEshopOAuthSession();
      return {
        success: false,
        error: "No account found with this email address.",
      };
    }

    const emailAddress = emailAddresses[0];

    // Get person details
    const personResponse = await graphqlClient.request<GetPersonByIdResponse>(
      GET_PERSON_BY_ID,
      {
        businessEntityId: emailAddress.BusinessEntityID,
      },
    );

    const person = personResponse.people?.items?.[0];

    if (!person) {
      clearEshopOAuthSession();
      return {
        success: false,
        error: "Account data not found.",
      };
    }

    return {
      success: true,
      user: {
        businessEntityId: person.BusinessEntityID,
        email: email,
        firstName: person.FirstName,
        lastName: person.LastName,
        emailAddressId: emailAddress.EmailAddressID,
      },
    }
  } catch (error) {
    clearEshopOAuthSession();
    trackError("Login error", error, {
      service: "authService",
      function: "loginUser",
    });
    return {
      success: false,
      error:
        error instanceof Error && error.message.startsWith("Sign-in failed.")
          ? error.message
          : "An error occurred during login. Please try again.",
    };
  }
}

const SIGNUP_TIMEOUT_MS = 80000;

/**
 * Signup new user - creates a person and email address record.
 * Wrapped in an overall timeout so a hung GraphQL or Functions call surfaces as an error.
 */
export async function signupUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
): Promise<AuthResult> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new DOMException("Signup timed out", "AbortError")),
      SIGNUP_TIMEOUT_MS,
    );
  });

  async function doSignup(): Promise<AuthResult> {
    try {
      // One server-side transaction creates BusinessEntity, Person, EmailAddress and the
      // hashed password, so the identity tables need no anonymous DAB access.
      const functionsUrl = getFunctionsApiUrl();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 75000);
      let signupResponse: Response;
      try {
        signupResponse = await fetch(`${functionsUrl}/api/signup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, firstName, lastName }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (signupResponse.status === 409) {
        return {
          success: false,
          error: "An account with this email already exists.",
        };
      }
      if (!signupResponse.ok) {
        const body = await signupResponse.json().catch(() => null);
        return {
          success: false,
          error:
            signupResponse.status === 400 && body?.error
              ? body.error
              : "Failed to create account. Please try again.",
        };
      }

      const created = (await signupResponse.json()) as {
        businessEntityId: number;
        emailAddressId: number;
        firstName: string;
        lastName: string;
      };

      await signInWithEshopCredentials(email, password);

      return {
        success: true,
        user: {
          businessEntityId: created.businessEntityId,
          email,
          firstName: created.firstName,
          lastName: created.lastName,
          emailAddressId: created.emailAddressId,
        },
      };
    } catch (error) {
      clearEshopOAuthSession();
      trackError("Signup error", error, {
        service: "authService",
        function: "signupUser",
      });
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "Signup request timed out. The server may be starting up; please try again."
          : "An error occurred during signup. Please try again.";
      return {
        success: false,
        error: message,
      };
    }
  }

  try {
    return await Promise.race([doSignup(), timeoutPromise]);
  } catch (error) {
    trackError("Signup error", error, {
      service: "authService",
      function: "signupUser",
    });
    return {
      success: false,
      error:
        "Signup request timed out. The server may be starting up; please try again.",
    };
  }
}

/**
 * Update user profile
 */
export async function updateUserProfile(
  businessEntityId: number,
  emailAddressId: number,
  firstName: string,
  lastName: string,
  newEmail: string,
  oldEmail: string,
): Promise<AuthResult> {
  try {
    // Update person record
    await graphqlClient.request<UpdatePersonResponse>(UPDATE_PERSON, {
      businessEntityId,
      firstName,
      lastName,
    });

    // Update email if changed
    if (newEmail !== oldEmail && emailAddressId) {
      await graphqlClient.request(UPDATE_EMAIL_ADDRESS, {
        emailAddressId,
        emailAddress: newEmail,
      });
    }

    return {
      success: true,
      user: {
        businessEntityId,
        email: newEmail,
        firstName,
        lastName,
        emailAddressId,
      },
    };
  } catch (error) {
    trackError("Update profile error", error, {
      service: "authService",
      function: "updateUserProfile",
      businessEntityId: businessEntityId,
    });
    return {
      success: false,
      error: "An error occurred while updating your profile. Please try again.",
    };
  }
}

/**
 * Change user password
 */
export async function changePassword(
  businessEntityId: number,
  currentPassword: string,
  newPassword: string,
): Promise<AuthResult> {
  try {
    const functionsUrl = getFunctionsApiUrl();

    // First verify the current password
    // Both calls carry the consumer's Functions token; the API only lets a consumer
    // verify or change their own password.
    const verifyResponse = await functionsFetch(`${functionsUrl}/api/password/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessEntityID: businessEntityId,
        password: currentPassword,
      }),
    });

    if (!verifyResponse.ok) {
      return {
        success: false,
        error: "An error occurred while verifying your password.",
      };
    }

    const verifyResult = await verifyResponse.json();

    if (!verifyResult.isValid) {
      return {
        success: false,
        error: "Current password is incorrect.",
      };
    }

    // Update to new password
    const updateResponse = await functionsFetch(`${functionsUrl}/api/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessEntityID: businessEntityId,
        password: newPassword,
      }),
    });

    if (!updateResponse.ok) {
      return {
        success: false,
        error: "Failed to update password. Please try again.",
      };
    }

    return {
      success: true,
    };
  } catch (error) {
    trackError("Change password error", error, {
      service: "authService",
      function: "changePassword",
      businessEntityId: businessEntityId,
    });
    return {
      success: false,
      error:
        "An error occurred while changing your password. Please try again.",
    };
  }
}

/**
 * Request password reset - sends email with reset link
 */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  try {
    const functionsUrl = getFunctionsApiUrl();
    const response = await fetch(`${functionsUrl}/api/password/reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: "An error occurred processing your request.",
      };
    }

    return {
      success: true,
    };
  } catch (error) {
    trackError("Password reset request failed", error as Error, {
      service: "authService",
      operation: "requestPasswordReset",
    });
    return {
      success: false,
      error: "An error occurred processing your request. Please try again.",
    };
  }
}

/**
 * Validate password reset token
 */
export async function validateResetToken(
  businessEntityId: number,
  token: string,
): Promise<{ isValid: boolean }> {
  try {
    const functionsUrl = getFunctionsApiUrl();
    const response = await fetch(
      `${functionsUrl}/api/password/reset/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessEntityID: businessEntityId, token }),
      },
    );

    if (!response.ok) {
      return { isValid: false };
    }

    const result = await response.json();
    return { isValid: result.isValid };
  } catch (error) {
    trackError("Password reset token validation failed", error as Error, {
      service: "authService",
      operation: "validateResetToken",
      businessEntityId: businessEntityId.toString(),
    });
    return { isValid: false };
  }
}

/**
 * Reset password using token
 */
export async function resetPassword(
  businessEntityId: number,
  token: string,
  newPassword: string,
): Promise<AuthResult> {
  try {
    const functionsUrl = getFunctionsApiUrl();
    const response = await fetch(
      `${functionsUrl}/api/password/reset/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessEntityID: businessEntityId,
          token,
          newPassword,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      return {
        success: false,
        error: error.error || "Failed to reset password.",
      };
    }

    return {
      success: true,
    };
  } catch (error) {
    trackError("Password reset completion failed", error as Error, {
      service: "authService",
      operation: "resetPassword",
      businessEntityId: businessEntityId.toString(),
    });
    return {
      success: false,
      error: "An error occurred resetting your password. Please try again.",
    };
  }
}
