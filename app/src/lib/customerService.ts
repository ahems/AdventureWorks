import { graphqlClient } from "./graphql-client";
import { gql } from "graphql-request";
import { trackError } from "@/lib/appInsights";

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
  businessEntityId: number,
): Promise<Customer | null> {
  try {
    const response: any = await graphqlClient.request(
      GET_CUSTOMER_BY_PERSON_ID,
      {
        businessEntityId,
      },
    );

    const customers = response.customers?.items || [];
    return customers.length > 0 ? customers[0] : null;
  } catch (error) {
    trackError("Error fetching customer by person ID", error as Error, {
      service: "customerService",
      businessEntityId: businessEntityId.toString(),
    });
    return null;
  }
}
