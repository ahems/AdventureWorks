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
  people: {
    items: PersonItem[];
  };
}

interface CreatePersonResponse {
  createperson: {
    BusinessEntityID: number;
    FirstName: string;
    LastName: string;
  };
}

interface CreateEmailAddressResponse {
  createemailAddress: {
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
    people(filter: { emailAddresses: { emailAddress: { eq: $email } } }) {
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

const CREATE_PERSON = gql`
  mutation CreatePerson($firstName: String!, $lastName: String!) {
    createperson(
      item: { FirstName: $firstName, LastName: $lastName, PersonType: "IN" }
    ) {
      BusinessEntityID
      FirstName
      LastName
    }
  }
`;

const CREATE_EMAIL_ADDRESS = gql`
  mutation CreateEmailAddress($businessEntityId: Int!, $emailAddress: String!) {
    createemailAddress(
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
    updateperson(
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
    updateemailAddress(
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

    const people = response.people?.items || [];

    if (people.length === 0) {
      return {
        success: false,
        error: "No account found with this email address.",
      };
    }

    const person = people[0];
    const emailAddresses = person.emailAddresses?.items || [];
    const emailAddress = emailAddresses.find((ea) => ea.EmailAddress === email);

    return {
      success: true,
      user: {
        businessEntityId: person.BusinessEntityID,
        email: email,
        firstName: person.FirstName,
        lastName: person.LastName,
        emailAddressId: emailAddress?.EmailAddressID,
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
    const existingPeople = checkResponse.people?.items || [];

    if (existingPeople.length > 0) {
      return {
        success: false,
        error: "An account with this email already exists.",
      };
    }

    // Create person record
    const personResponse = await graphqlClient.request<CreatePersonResponse>(
      CREATE_PERSON,
      {
        firstName,
        lastName,
      }
    );

    const newPerson = personResponse.createperson;

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

    const newEmailAddress = emailResponse.createemailAddress;

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
