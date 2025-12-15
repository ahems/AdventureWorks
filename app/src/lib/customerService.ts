import { graphqlClient } from "./graphql-client";
import { gql } from "graphql-request";

const GET_CUSTOMER_BY_PERSON_ID = gql`
  query GetCustomerByPersonId($businessEntityId: Int!) {
    customers(filter: { PersonID: { eq: $businessEntityId } }) {
      items {
        CustomerID
        PersonID
      }
    }
  }
`;

export interface Customer {
  CustomerID: number;
  PersonID: number;
}

export async function getCustomerByPersonId(
  businessEntityId: number
): Promise<Customer | null> {
  try {
    const response: any = await graphqlClient.request(
      GET_CUSTOMER_BY_PERSON_ID,
      {
        businessEntityId,
      }
    );

    const customers = response.customers?.items || [];
    return customers.length > 0 ? customers[0] : null;
  } catch (error) {
    console.error("Error fetching customer:", error);
    return null;
  }
}
