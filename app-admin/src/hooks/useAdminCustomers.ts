import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { Customer } from "@/types/customer";

// ─── Queries ──────────────────────────────────────────────────────────────────

// Query individual customers via Person.Person (PersonType='IN' = individual/customer)
// DAB has Person -> emailAddresses relationship defined.
// Note: address data requires cross-entity join via BusinessEntityAddress not in DAB relationships.
const GET_CUSTOMERS_ADMIN = gql`
  query GetCustomersAdmin($after: String) {
    people(
      first: 100
      after: $after
      filter: { PersonType: { eq: "IN" } }
      orderBy: { LastName: ASC }
    ) {
      items {
        BusinessEntityID
        FirstName
        LastName
        emailAddresses {
          items {
            EmailAddress
          }
        }
      }
      hasNextPage
      endCursor
    }
  }
`;

// ─── Hooks ────────────────────────────────────────────────────────────────────

interface RawPerson {
  BusinessEntityID: number;
  FirstName?: string;
  LastName?: string;
  emailAddresses?: { items: Array<{ EmailAddress?: string }> };
}

export interface PagedCustomers {
  items: Customer[];
  hasNextPage: boolean;
  endCursor: string;
}

/** Map DAB people records to the Customer shape used by the admin UI. */
const mapPersonToCustomer = (person: RawPerson): Customer => ({
  CustomerID: person.BusinessEntityID,
  FirstName: person.FirstName ?? "",
  LastName: person.LastName ?? "",
  EmailAddress: person.emailAddresses?.items?.[0]?.EmailAddress ?? "",
  Phone: "",
  AddressLine1: "",
  City: "",
  StateProvince: "",
  PostalCode: "",
  Country: "",
  CreatedAt: "",
  TotalOrders: 0,
  TotalSpent: 0,
});

export const useAdminCustomers = (after?: string | null) =>
  useQuery<PagedCustomers>({
    queryKey: ["admin", "customers", after ?? null],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        people?: {
          items: RawPerson[];
          hasNextPage?: boolean;
          endCursor?: string;
        };
      }>(GET_CUSTOMERS_ADMIN, { after: after ?? null });
      return {
        items: (data.people?.items ?? []).map(mapPersonToCustomer),
        hasNextPage: data.people?.hasNextPage ?? false,
        endCursor: data.people?.endCursor ?? "",
      };
    },
    staleTime: 5 * 60 * 1000,
  });

// ─── Email lookup for a SalesOrderHeader CustomerID ──────────────────────────

const GET_CUSTOMER_PERSON_ID = gql`
  query GetCustomerPersonId($customerId: Int!) {
    customers(filter: { CustomerID: { eq: $customerId } }) {
      items {
        CustomerID
        PersonID
      }
    }
  }
`;

const GET_PERSON_EMAIL_ADDRESSES = gql`
  query GetPersonEmailAddresses($personId: Int!) {
    emailAddresses(filter: { BusinessEntityID: { eq: $personId } }) {
      items {
        EmailAddressID
        EmailAddress
      }
    }
  }
`;

export interface CustomerEmailAddress {
  EmailAddressID: number;
  EmailAddress: string;
}

/** Resolve the primary email address record for a Sales.Customer (by CustomerID). */
export const useCustomerEmailAddresses = (salesCustomerId: number) => {
  // Step 1: resolve PersonID from Sales.Customer
  const personQuery = useQuery<number | null>({
    queryKey: ["customer", "personId", salesCustomerId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        customers?: { items: Array<{ PersonID: number | null }> };
      }>(GET_CUSTOMER_PERSON_ID, { customerId: salesCustomerId });
      return data.customers?.items?.[0]?.PersonID ?? null;
    },
    enabled: !!salesCustomerId,
    staleTime: 10 * 60 * 1000,
  });

  const personId = personQuery.data ?? null;

  // Step 2: get email addresses for that Person
  const emailQuery = useQuery<CustomerEmailAddress[]>({
    queryKey: ["customer", "emails", personId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        emailAddresses?: { items: CustomerEmailAddress[] };
      }>(GET_PERSON_EMAIL_ADDRESSES, { personId });
      return data.emailAddresses?.items ?? [];
    },
    enabled: !!personId,
    staleTime: 10 * 60 * 1000,
  });

  return {
    emails: emailQuery.data ?? [],
    isLoading: personQuery.isLoading || emailQuery.isLoading,
  };
};
