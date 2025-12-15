import { graphqlClient } from "./graphql-client";
import { gql } from "graphql-request";

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
 * Login user - checks if user exists with given email
 * Note: This is a simplified auth - in production, you'd use proper password hashing
 */
export async function loginUser(
  email: string,
  password: string
): Promise<AuthResult> {
  try {
    // For demo purposes, we're just checking if the user exists
    // In production, you'd verify password hash
    const response = await graphqlClient.request<CheckUserLoginResponse>(
      CHECK_USER_LOGIN,
      {
        email,
      }
    );

    const emailAddresses = response.emailAddresses?.items || [];

    if (emailAddresses.length === 0) {
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
      }
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
  lastName: string
): Promise<AuthResult> {
  try {
    // Check if user already exists
    const checkResponse = await graphqlClient.request<CheckUserLoginResponse>(
      CHECK_USER_LOGIN,
      {
        email,
      }
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
        CREATE_BUSINESS_ENTITY
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
      }
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
        }
      );

    const newEmailAddress = emailResponse.createEmailAddress;

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
  oldEmail: string
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
