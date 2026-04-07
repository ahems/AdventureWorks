import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { Customer } from "@/types/customer";
import { getFunctionsApiUrl } from "@/lib/utils";

// ─── Queries ──────────────────────────────────────────────────────────────────

// Full customer query via Person.Person (PersonType='IN') with phone and sales data.
// Address is fetched separately via Azure Functions (DAB cannot expose Person.Address due to geography column).
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
        phoneNumbers {
          items {
            PhoneNumber
          }
        }
        salesCustomer {
          CustomerID
          salesOrderHeaders {
            items {
              TotalDue
            }
          }
        }
      }
      hasNextPage
      endCursor
    }
  }
`;

// Per-customer order history query (uses Sales.Customer.CustomerID)
const GET_CUSTOMER_ORDERS = gql`
  query GetCustomerOrders($customerId: Int!) {
    salesOrderHeaders(
      filter: { CustomerID: { eq: $customerId } }
      orderBy: { OrderDate: DESC }
      first: 50
    ) {
      items {
        SalesOrderID
        CustomerID
        OrderDate
        DueDate
        ShipDate
        Status
        SubTotal
        TaxAmt
        Freight
        TotalDue
        salesOrderDetails {
          items {
            SalesOrderDetailID
            ProductID
            OrderQty
            UnitPrice
            LineTotal
            product {
              Name
            }
          }
        }
      }
    }
  }
`;

// ─── Types ────────────────────────────────────────────────────────────────────

// ASP.NET Core serializes to camelCase by default
interface PersonAddressResult {
  businessEntityID: number;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postalCode: string;
  stateProvinceName: string;
  countryName: string;
}

interface RawPerson {
  BusinessEntityID: number;
  FirstName?: string;
  LastName?: string;
  emailAddresses?: { items: Array<{ EmailAddress?: string }> };
  phoneNumbers?: { items: Array<{ PhoneNumber?: string }> };
  salesCustomer?: {
    CustomerID?: number;
    salesOrderHeaders?: { items: Array<{ TotalDue?: number }> };
  } | null;
}

export interface PagedCustomers {
  items: Customer[];
  hasNextPage: boolean;
  endCursor: string;
}

/** Map a DAB person record + optional Function-fetched address to the Customer shape. */
const mapPersonToCustomer = (
  person: RawPerson,
  addr?: PersonAddressResult,
): Customer => {
  const orderItems = person.salesCustomer?.salesOrderHeaders?.items ?? [];
  return {
    CustomerID: person.BusinessEntityID,
    SalesCustomerID: person.salesCustomer?.CustomerID ?? null,
    FirstName: person.FirstName ?? "",
    LastName: person.LastName ?? "",
    EmailAddress: person.emailAddresses?.items?.[0]?.EmailAddress ?? "",
    Phone: person.phoneNumbers?.items?.[0]?.PhoneNumber ?? "",
    AddressLine1: addr?.addressLine1 ?? "",
    City: addr?.city ?? "",
    StateProvince: addr?.stateProvinceName ?? "",
    PostalCode: addr?.postalCode ?? "",
    Country: addr?.countryName ?? "",
    CreatedAt: "",
    TotalOrders: orderItems.length,
    TotalSpent: orderItems.reduce((sum, o) => sum + (o.TotalDue ?? 0), 0),
  };
};

export const useAdminCustomers = (after?: string | null) =>
  useQuery<PagedCustomers>({
    queryKey: ["admin", "customers", after ?? null],
    queryFn: async () => {
      // Step 1: fetch people from DAB (no address data - Person.Address has unsupported geography column)
      const data = await graphqlClient.request<{
        people?: {
          items: RawPerson[];
          hasNextPage?: boolean;
          endCursor?: string;
        };
      }>(GET_CUSTOMERS_ADMIN, { after: after ?? null });

      const people = data.people?.items ?? [];

      // Step 2: batch-fetch addresses from Azure Functions for this page of persons
      let addressMap: Record<number, PersonAddressResult> = {};
      if (people.length > 0) {
        try {
          const ids = people.map((p) => p.BusinessEntityID).join(",");
          const res = await fetch(
            `${getFunctionsApiUrl()}/api/person-addresses?businessEntityIds=${ids}`,
          );
          if (res.ok) {
            const addresses: PersonAddressResult[] = await res.json();
            addressMap = Object.fromEntries(
              addresses.map((a) => [a.businessEntityID, a]),
            );
          }
        } catch {
          // Address enrichment is best-effort; customers still load without it
        }
      }

      return {
        items: people.map((p) =>
          mapPersonToCustomer(p, addressMap[p.BusinessEntityID]),
        ),
        hasNextPage: data.people?.hasNextPage ?? false,
        endCursor: data.people?.endCursor ?? "",
      };
    },
    staleTime: 5 * 60 * 1000,
  });

// ─── Per-customer order history ───────────────────────────────────────────────

export interface CustomerOrderItem {
  SalesOrderDetailID: number;
  ProductID: number;
  ProductName: string;
  OrderQty: number;
  UnitPrice: number;
  LineTotal: number;
}

export interface CustomerOrder {
  SalesOrderID: number;
  CustomerID: number;
  OrderDate: string;
  DueDate: string;
  ShipDate: string | null;
  Status: number;
  SubTotal: number;
  TaxAmt: number;
  Freight: number;
  TotalDue: number;
  OrderItems: CustomerOrderItem[];
}

export const useCustomerOrders = (salesCustomerId: number | null) =>
  useQuery<CustomerOrder[]>({
    queryKey: ["customer", "orders", salesCustomerId],
    enabled: salesCustomerId != null && salesCustomerId > 0,
    queryFn: async () => {
      const data = await graphqlClient.request<{
        salesOrderHeaders?: {
          items: Array<{
            SalesOrderID: number;
            CustomerID: number;
            OrderDate?: string;
            DueDate?: string;
            ShipDate?: string | null;
            Status: number;
            SubTotal?: number;
            TaxAmt?: number;
            Freight?: number;
            TotalDue?: number;
            salesOrderDetails?: {
              items: Array<{
                SalesOrderDetailID: number;
                ProductID: number;
                OrderQty: number;
                UnitPrice: number;
                LineTotal: number;
                product?: { Name?: string };
              }>;
            };
          }>;
        };
      }>(GET_CUSTOMER_ORDERS, { customerId: salesCustomerId });

      return (data.salesOrderHeaders?.items ?? []).map((o) => ({
        SalesOrderID: o.SalesOrderID,
        CustomerID: o.CustomerID,
        OrderDate: o.OrderDate ?? "",
        DueDate: o.DueDate ?? "",
        ShipDate: o.ShipDate ?? null,
        Status: o.Status ?? 1,
        SubTotal: o.SubTotal ?? 0,
        TaxAmt: o.TaxAmt ?? 0,
        Freight: o.Freight ?? 0,
        TotalDue: o.TotalDue ?? 0,
        OrderItems: (o.salesOrderDetails?.items ?? []).map((d) => ({
          SalesOrderDetailID: d.SalesOrderDetailID,
          ProductID: d.ProductID,
          ProductName: d.product?.Name ?? `Product #${d.ProductID}`,
          OrderQty: d.OrderQty,
          UnitPrice: d.UnitPrice,
          LineTotal: d.LineTotal,
        })),
      }));
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
