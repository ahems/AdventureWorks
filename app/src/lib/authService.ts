import { graphqlClient } from "./graphql-client";
import { gql } from "graphql-request";
import { getFunctionsApiUrl, getRestApiUrl } from "./utils";

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

interface CreateBusinessEntityResponse {
  createBusinessEntity: {
    BusinessEntityID: number;
  };
}

interface CreatePersonResponse {
  createPerson: {
    BusinessEntityID: number;
    FirstName: string;
    LastName: string;
  };
}

interface CreateEmailAddressResponse {
  createEmailAddress: {
    EmailAddressID: number;
    BusinessEntityID: number;
    EmailAddress: string;
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

const CREATE_BUSINESS_ENTITY = gql`
  mutation CreateBusinessEntity {
    createBusinessEntity(item: {}) {
      BusinessEntityID
    }
  }
`;

const CREATE_PERSON = gql`
  mutation CreatePerson(
    $businessEntityId: Int!
    $firstName: String!
    $lastName: String!
  ) {
    createPerson(
      item: {
        BusinessEntityID: $businessEntityId
        FirstName: $firstName
        LastName: $lastName
        PersonType: "IN"
      }
    ) {
      BusinessEntityID
      FirstName
      LastName
    }
  }
`;

const CREATE_EMAIL_ADDRESS = gql`
  mutation CreateEmailAddress($businessEntityId: Int!, $emailAddress: String!) {
    createEmailAddress(
      item: { BusinessEntityID: $businessEntityId, EmailAddress: $emailAddress }
    ) {
      EmailAddressID
      BusinessEntityID
      EmailAddress
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
    // Check if user exists
    const response = await graphqlClient.request<CheckUserLoginResponse>(
      CHECK_USER_LOGIN,
      {
        email,
      },
    );

    const emailAddresses = response.emailAddresses?.items || [];

    if (emailAddresses.length === 0) {
      return {
        success: false,
        error: "No account found with this email address.",
      };
    }

    const emailAddress = emailAddresses[0];

    // Verify password using password functions API
    const functionsUrl = getFunctionsApiUrl();
    const verifyResponse = await fetch(`${functionsUrl}/api/password/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessEntityID: emailAddress.BusinessEntityID,
        password: password,
      }),
    });

    if (!verifyResponse.ok) {
      return {
        success: false,
        error: "An error occurred during login. Please try again.",
      };
    }

    const verifyResult = await verifyResponse.json();

    if (!verifyResult.isValid) {
      return {
        success: false,
        error: "Invalid email or password.",
      };
    }

    // Get person details
    const personResponse = await graphqlClient.request<GetPersonByIdResponse>(
      GET_PERSON_BY_ID,
      {
        businessEntityId: emailAddress.BusinessEntityID,
      },
    );

    const person = personResponse.people?.items?.[0];

    if (!person) {
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
    };
  } catch (error) {
    console.error("Login error:", error);
    return {
      success: false,
      error: "An error occurred during login. Please try again.",
    };
  }
}

/**
 * Signup new user - creates a person and email address record
 */
export async function signupUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
): Promise<AuthResult> {
  try {
    // Check if user already exists
    const checkResponse = await graphqlClient.request<CheckUserLoginResponse>(
      CHECK_USER_LOGIN,
      {
        email,
      },
    );
    const existingEmails = checkResponse.emailAddresses?.items || [];

    if (existingEmails.length > 0) {
      return {
        success: false,
        error: "An account with this email already exists.",
      };
    }

    // Create business entity first (required by Person table)
    const businessEntityResponse =
      await graphqlClient.request<CreateBusinessEntityResponse>(
        CREATE_BUSINESS_ENTITY,
      );

    const businessEntityId =
      businessEntityResponse.createBusinessEntity.BusinessEntityID;

    // Create person record
    const personResponse = await graphqlClient.request<CreatePersonResponse>(
      CREATE_PERSON,
      {
        businessEntityId,
        firstName,
        lastName,
      },
    );

    const newPerson = personResponse.createPerson;

    if (!newPerson) {
      return {
        success: false,
        error: "Failed to create account. Please try again.",
      };
    }

    // Create email address record
    const emailResponse =
      await graphqlClient.request<CreateEmailAddressResponse>(
        CREATE_EMAIL_ADDRESS,
        {
          businessEntityId: newPerson.BusinessEntityID,
          emailAddress: email,
        },
      );

    const newEmailAddress = emailResponse.createEmailAddress;

    // Create password using password functions API
    const functionsUrl = getFunctionsApiUrl();
    const passwordResponse = await fetch(`${functionsUrl}/api/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessEntityID: newPerson.BusinessEntityID,
        password: password,
      }),
    });

    if (!passwordResponse.ok) {
      return {
        success: false,
        error: "Failed to create account password. Please try again.",
      };
    }

    return {
      success: true,
      user: {
        businessEntityId: newPerson.BusinessEntityID,
        email: email,
        firstName: newPerson.FirstName,
        lastName: newPerson.LastName,
        emailAddressId: newEmailAddress?.EmailAddressID,
      },
    };
  } catch (error) {
    console.error("Signup error:", error);
    return {
      success: false,
      error: "An error occurred during signup. Please try again.",
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
    console.error("Update profile error:", error);
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
    const verifyResponse = await fetch(`${functionsUrl}/api/password/verify`, {
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
    const updateResponse = await fetch(`${functionsUrl}/api/password`, {
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
    console.error("Change password error:", error);
    return {
      success: false,
      error:
        "An error occurred while changing your password. Please try again.",
    };
  }
}

/**
 * Delete user account and all associated data
 * This includes: Person, EmailAddresses, Addresses, Orders, Shopping Cart, Password
 */
export async function deleteAccount(
  businessEntityId: number,
): Promise<AuthResult> {
  try {
    const functionsUrl = getFunctionsApiUrl();
    const restApiUrl = getRestApiUrl();

    console.log(
      "[deleteAccount] Starting deletion for businessEntityId:",
      businessEntityId,
    );

    // Delete in order to handle foreign key constraints

    // 1. Delete shopping cart items
    try {
      const cartResponse = await fetch(
        `${restApiUrl}/ShoppingCartItem?$filter=ShoppingCartID eq '${businessEntityId}'`,
      );
      if (cartResponse.ok) {
        const cartData = await cartResponse.json();
        const cartItems = cartData.value || [];
        console.log(
          "[deleteAccount] Deleting",
          cartItems.length,
          "shopping cart items",
        );
        for (const item of cartItems) {
          await fetch(
            `${restApiUrl}/ShoppingCartItem/ShoppingCartItemID/${item.ShoppingCartItemID}`,
            { method: "DELETE" },
          );
        }
      }
    } catch (error) {
      console.error("[deleteAccount] Error deleting cart items:", error);
    }

    // 2. Delete sales order details, then orders (if customer exists)
    try {
      // First get Customer ID
      const customerResponse = await fetch(
        `${restApiUrl}/Customer?$filter=PersonID eq ${businessEntityId}`,
      );
      if (customerResponse.ok) {
        const customerData = await customerResponse.json();
        const customer = customerData.value?.[0];
        if (customer) {
          console.log("[deleteAccount] Found customer:", customer.CustomerID);

          // Get all orders for this customer
          const ordersResponse = await fetch(
            `${restApiUrl}/SalesOrderHeader?$filter=CustomerID eq ${customer.CustomerID}`,
          );
          if (ordersResponse.ok) {
            const ordersData = await ordersResponse.json();
            const orders = ordersData.value || [];
            console.log("[deleteAccount] Deleting", orders.length, "orders");

            for (const order of orders) {
              // Delete order details first
              const detailsResponse = await fetch(
                `${restApiUrl}/SalesOrderDetail?$filter=SalesOrderID eq ${order.SalesOrderID}`,
              );
              if (detailsResponse.ok) {
                const detailsData = await detailsResponse.json();
                const details = detailsData.value || [];
                for (const detail of details) {
                  await fetch(
                    `${restApiUrl}/SalesOrderDetail/SalesOrderID/${detail.SalesOrderID}/SalesOrderDetailID/${detail.SalesOrderDetailID}`,
                    { method: "DELETE" },
                  );
                }
              }

              // Delete order header
              await fetch(
                `${restApiUrl}/SalesOrderHeader/SalesOrderID/${order.SalesOrderID}`,
                { method: "DELETE" },
              );
            }
          }

          // Delete customer
          await fetch(
            `${restApiUrl}/Customer/CustomerID/${customer.CustomerID}`,
            { method: "DELETE" },
          );
        }
      }
    } catch (error) {
      console.error("[deleteAccount] Error deleting orders/customer:", error);
    }

    // 3. Delete addresses
    try {
      // Get BusinessEntityAddress links
      const beaResponse = await fetch(
        `${restApiUrl}/BusinessEntityAddress?$filter=BusinessEntityID eq ${businessEntityId}`,
      );
      if (beaResponse.ok) {
        const beaData = await beaResponse.json();
        const beaLinks = beaData.value || [];
        console.log("[deleteAccount] Deleting", beaLinks.length, "addresses");

        for (const link of beaLinks) {
          // Delete BusinessEntityAddress link
          await fetch(
            `${restApiUrl}/BusinessEntityAddress/BusinessEntityID/${link.BusinessEntityID}/AddressID/${link.AddressID}/AddressTypeID/${link.AddressTypeID}`,
            { method: "DELETE" },
          );

          // Delete the address itself from Functions API
          try {
            await fetch(`${functionsUrl}/api/addresses/${link.AddressID}`, {
              method: "DELETE",
            });
          } catch (error) {
            console.error("[deleteAccount] Error deleting address:", error);
          }
        }
      }
    } catch (error) {
      console.error("[deleteAccount] Error deleting addresses:", error);
    }

    // 4. Delete phone numbers
    try {
      const phoneResponse = await fetch(
        `${restApiUrl}/PersonPhone?$filter=BusinessEntityID eq ${businessEntityId}`,
      );
      if (phoneResponse.ok) {
        const phoneData = await phoneResponse.json();
        const phones = phoneData.value || [];
        console.log("[deleteAccount] Deleting", phones.length, "phone numbers");
        for (const phone of phones) {
          await fetch(
            `${restApiUrl}/PersonPhone/BusinessEntityID/${phone.BusinessEntityID}/PhoneNumber/${encodeURIComponent(phone.PhoneNumber)}/PhoneNumberTypeID/${phone.PhoneNumberTypeID}`,
            { method: "DELETE" },
          );
        }
      }
    } catch (error) {
      console.error("[deleteAccount] Error deleting phone numbers:", error);
    }

    // 5. Delete email addresses
    try {
      const emailResponse = await fetch(
        `${restApiUrl}/EmailAddress?$filter=BusinessEntityID eq ${businessEntityId}`,
      );
      if (emailResponse.ok) {
        const emailData = await emailResponse.json();
        const emails = emailData.value || [];
        console.log(
          "[deleteAccount] Deleting",
          emails.length,
          "email addresses",
        );
        for (const email of emails) {
          // Use GraphQL mutation for delete to handle composite keys properly
          const DELETE_EMAIL = gql`
            mutation DeleteEmail(
              $businessEntityId: Int!
              $emailAddressId: Int!
            ) {
              deleteEmailAddress(
                BusinessEntityID: $businessEntityId
                EmailAddressID: $emailAddressId
              ) {
                EmailAddressID
              }
            }
          `;
          await graphqlClient.request(DELETE_EMAIL, {
            businessEntityId: businessEntityId,
            emailAddressId: email.EmailAddressID,
          });
        }
      }
    } catch (error) {
      console.error("[deleteAccount] Error deleting email addresses:", error);
    }

    // 6. Delete password
    try {
      await fetch(
        `${restApiUrl}/Password/BusinessEntityID/${businessEntityId}`,
        { method: "DELETE" },
      );
    } catch (error) {
      console.error("[deleteAccount] Error deleting password:", error);
    }

    // 7. Delete Person record (use GraphQL to ensure proper key handling)
    try {
      const DELETE_PERSON = gql`
        mutation DeletePerson($businessEntityId: Int!) {
          deletePerson(BusinessEntityID: $businessEntityId) {
            BusinessEntityID
          }
        }
      `;
      await graphqlClient.request(DELETE_PERSON, {
        businessEntityId: businessEntityId,
      });
    } catch (error) {
      console.error("[deleteAccount] Error deleting person:", error);
    }

    // 8. Delete BusinessEntity (use GraphQL to ensure proper key handling)
    try {
      const DELETE_BUSINESS_ENTITY = gql`
        mutation DeleteBusinessEntity($businessEntityId: Int!) {
          deleteBusinessEntity(BusinessEntityID: $businessEntityId) {
            BusinessEntityID
          }
        }
      `;
      await graphqlClient.request(DELETE_BUSINESS_ENTITY, {
        businessEntityId: businessEntityId,
      });
    } catch (error) {
      console.error("[deleteAccount] Error deleting business entity:", error);
    }

    console.log("[deleteAccount] Account deletion completed");
    return {
      success: true,
    };
  } catch (error) {
    console.error("Delete account error:", error);
    return {
      success: false,
      error: "An error occurred while deleting your account. Please try again.",
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
    console.error("Request password reset error:", error);
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
    console.error("Validate reset token error:", error);
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
    console.error("Reset password error:", error);
    return {
      success: false,
      error: "An error occurred resetting your password. Please try again.",
    };
  }
}
