export interface Customer {
  CustomerID: number;
  /** Sales.Customer.CustomerID — null if no Sales.Customer record for this person */
  SalesCustomerID: number | null;
  FirstName: string;
  LastName: string;
  EmailAddress: string;
  Phone: string;
  AddressLine1: string;
  City: string;
  StateProvince: string;
  PostalCode: string;
  Country: string;
  CreatedAt: string;
  TotalOrders: number;
  TotalSpent: number;
}
