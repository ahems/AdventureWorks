export interface Customer {
  CustomerID: number;
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

export interface Order {
  SalesOrderID: number;
  CustomerID: number;
  OrderDate: string;
  DueDate: string;
  ShipDate: string | null;
  Status: OrderStatus;
  SubTotal: number;
  TaxAmt: number;
  Freight: number;
  TotalDue: number;
  OrderItems: OrderItem[];
}

export type OrderStatus = 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled';

export interface OrderItem {
  SalesOrderDetailID: number;
  ProductID: number;
  ProductName: string;
  OrderQty: number;
  UnitPrice: number;
  LineTotal: number;
}

// Status workflow transitions - defines valid next statuses for each status
export const ORDER_STATUS_WORKFLOW: Record<OrderStatus, OrderStatus[]> = {
  'Pending': ['Processing', 'Cancelled'],
  'Processing': ['Shipped', 'Cancelled'],
  'Shipped': ['Delivered'],
  'Delivered': [], // Terminal state
  'Cancelled': [], // Terminal state
};

export const ORDER_STATUS_CONFIG: Record<OrderStatus, { label: string; color: string; bgColor: string; icon: string }> = {
  'Pending': { label: 'Pending', color: 'text-amber-700', bgColor: 'bg-amber-100', icon: '⏳' },
  'Processing': { label: 'Processing', color: 'text-blue-700', bgColor: 'bg-blue-100', icon: '⚙️' },
  'Shipped': { label: 'Shipped', color: 'text-purple-700', bgColor: 'bg-purple-100', icon: '📦' },
  'Delivered': { label: 'Delivered', color: 'text-green-700', bgColor: 'bg-green-100', icon: '✅' },
  'Cancelled': { label: 'Cancelled', color: 'text-red-700', bgColor: 'bg-red-100', icon: '❌' },
};

export const mockCustomers: Customer[] = [
  {
    CustomerID: 1001,
    FirstName: 'Michael',
    LastName: 'Thompson',
    EmailAddress: 'michael.thompson@email.com',
    Phone: '(555) 123-4567',
    AddressLine1: '123 Oak Street',
    City: 'Seattle',
    StateProvince: 'WA',
    PostalCode: '98101',
    Country: 'United States',
    CreatedAt: '2023-01-15T10:30:00Z',
    TotalOrders: 5,
    TotalSpent: 4523.45,
  },
  {
    CustomerID: 1002,
    FirstName: 'Jennifer',
    LastName: 'Davis',
    EmailAddress: 'jennifer.davis@email.com',
    Phone: '(555) 234-5678',
    AddressLine1: '456 Pine Avenue',
    City: 'Portland',
    StateProvince: 'OR',
    PostalCode: '97201',
    Country: 'United States',
    CreatedAt: '2023-02-20T14:45:00Z',
    TotalOrders: 3,
    TotalSpent: 2156.78,
  },
  {
    CustomerID: 1003,
    FirstName: 'Robert',
    LastName: 'Wilson',
    EmailAddress: 'robert.wilson@email.com',
    Phone: '(555) 345-6789',
    AddressLine1: '789 Maple Drive',
    City: 'San Francisco',
    StateProvince: 'CA',
    PostalCode: '94102',
    Country: 'United States',
    CreatedAt: '2023-03-10T09:15:00Z',
    TotalOrders: 8,
    TotalSpent: 12450.00,
  },
  {
    CustomerID: 1004,
    FirstName: 'Emily',
    LastName: 'Martinez',
    EmailAddress: 'emily.martinez@email.com',
    Phone: '(555) 456-7890',
    AddressLine1: '321 Cedar Lane',
    City: 'Denver',
    StateProvince: 'CO',
    PostalCode: '80201',
    Country: 'United States',
    CreatedAt: '2023-04-05T16:20:00Z',
    TotalOrders: 2,
    TotalSpent: 899.99,
  },
  {
    CustomerID: 1005,
    FirstName: 'David',
    LastName: 'Brown',
    EmailAddress: 'david.brown@email.com',
    Phone: '(555) 567-8901',
    AddressLine1: '654 Birch Road',
    City: 'Austin',
    StateProvince: 'TX',
    PostalCode: '78701',
    Country: 'United States',
    CreatedAt: '2023-05-12T11:00:00Z',
    TotalOrders: 6,
    TotalSpent: 7834.56,
  },
  {
    CustomerID: 1006,
    FirstName: 'Sarah',
    LastName: 'Anderson',
    EmailAddress: 'sarah.anderson@email.com',
    Phone: '(555) 678-9012',
    AddressLine1: '987 Elm Street',
    City: 'Chicago',
    StateProvince: 'IL',
    PostalCode: '60601',
    Country: 'United States',
    CreatedAt: '2023-06-18T13:30:00Z',
    TotalOrders: 4,
    TotalSpent: 3245.67,
  },
  {
    CustomerID: 1007,
    FirstName: 'James',
    LastName: 'Taylor',
    EmailAddress: 'james.taylor@email.com',
    Phone: '(555) 789-0123',
    AddressLine1: '159 Walnut Ave',
    City: 'Boston',
    StateProvince: 'MA',
    PostalCode: '02101',
    Country: 'United States',
    CreatedAt: '2023-07-22T08:45:00Z',
    TotalOrders: 1,
    TotalSpent: 564.99,
  },
  {
    CustomerID: 1008,
    FirstName: 'Amanda',
    LastName: 'Johnson',
    EmailAddress: 'amanda.johnson@email.com',
    Phone: '(555) 890-1234',
    AddressLine1: '753 Spruce Blvd',
    City: 'Miami',
    StateProvince: 'FL',
    PostalCode: '33101',
    Country: 'United States',
    CreatedAt: '2023-08-30T15:15:00Z',
    TotalOrders: 7,
    TotalSpent: 9876.54,
  },
  {
    CustomerID: 1009,
    FirstName: 'Hans',
    LastName: 'Müller',
    EmailAddress: 'hans.mueller@email.de',
    Phone: '+49 30 12345678',
    AddressLine1: 'Hauptstraße 42',
    City: 'Berlin',
    StateProvince: 'Berlin',
    PostalCode: '10115',
    Country: 'Germany',
    CreatedAt: '2023-09-05T10:00:00Z',
    TotalOrders: 4,
    TotalSpent: 5234.00,
  },
  {
    CustomerID: 1010,
    FirstName: 'Sophie',
    LastName: 'Dubois',
    EmailAddress: 'sophie.dubois@email.fr',
    Phone: '+33 1 23 45 67 89',
    AddressLine1: '15 Rue de la Paix',
    City: 'Paris',
    StateProvince: 'Île-de-France',
    PostalCode: '75001',
    Country: 'France',
    CreatedAt: '2023-09-12T14:30:00Z',
    TotalOrders: 2,
    TotalSpent: 1890.50,
  },
  {
    CustomerID: 1011,
    FirstName: 'Yuki',
    LastName: 'Tanaka',
    EmailAddress: 'yuki.tanaka@email.jp',
    Phone: '+81 3-1234-5678',
    AddressLine1: '1-2-3 Shibuya',
    City: 'Tokyo',
    StateProvince: 'Tokyo',
    PostalCode: '150-0002',
    Country: 'Japan',
    CreatedAt: '2023-10-01T09:15:00Z',
    TotalOrders: 6,
    TotalSpent: 8920.00,
  },
  {
    CustomerID: 1012,
    FirstName: 'Carlos',
    LastName: 'García',
    EmailAddress: 'carlos.garcia@email.mx',
    Phone: '+52 55 1234 5678',
    AddressLine1: 'Av. Reforma 222',
    City: 'Mexico City',
    StateProvince: 'CDMX',
    PostalCode: '06600',
    Country: 'Mexico',
    CreatedAt: '2023-10-15T11:45:00Z',
    TotalOrders: 3,
    TotalSpent: 2456.75,
  },
  {
    CustomerID: 1013,
    FirstName: 'Emma',
    LastName: 'Williams',
    EmailAddress: 'emma.williams@email.co.uk',
    Phone: '+44 20 7123 4567',
    AddressLine1: '45 Oxford Street',
    City: 'London',
    StateProvince: 'Greater London',
    PostalCode: 'W1D 1BS',
    Country: 'United Kingdom',
    CreatedAt: '2023-11-02T16:20:00Z',
    TotalOrders: 5,
    TotalSpent: 6780.25,
  },
  {
    CustomerID: 1014,
    FirstName: 'Liam',
    LastName: 'O\'Brien',
    EmailAddress: 'liam.obrien@email.ca',
    Phone: '+1 416-123-4567',
    AddressLine1: '789 Queen Street W',
    City: 'Toronto',
    StateProvince: 'ON',
    PostalCode: 'M6J 1E9',
    Country: 'Canada',
    CreatedAt: '2023-11-18T08:30:00Z',
    TotalOrders: 4,
    TotalSpent: 4125.00,
  },
  {
    CustomerID: 1015,
    FirstName: 'Isabella',
    LastName: 'Rossi',
    EmailAddress: 'isabella.rossi@email.it',
    Phone: '+39 02 1234 5678',
    AddressLine1: 'Via Roma 100',
    City: 'Milan',
    StateProvince: 'Lombardy',
    PostalCode: '20121',
    Country: 'Italy',
    CreatedAt: '2023-12-05T13:00:00Z',
    TotalOrders: 2,
    TotalSpent: 3450.80,
  },
  {
    CustomerID: 1016,
    FirstName: 'Lucas',
    LastName: 'Santos',
    EmailAddress: 'lucas.santos@email.com.br',
    Phone: '+55 11 98765-4321',
    AddressLine1: 'Av. Paulista 1000',
    City: 'São Paulo',
    StateProvince: 'SP',
    PostalCode: '01310-100',
    Country: 'Brazil',
    CreatedAt: '2023-12-20T10:15:00Z',
    TotalOrders: 3,
    TotalSpent: 2890.00,
  },
];

export const mockOrders: Order[] = [
  {
    SalesOrderID: 70001,
    CustomerID: 1001,
    OrderDate: '2024-11-15T10:30:00Z',
    DueDate: '2024-11-22T10:30:00Z',
    ShipDate: '2024-11-17T14:00:00Z',
    Status: 'Delivered',
    SubTotal: 3578.27,
    TaxAmt: 286.26,
    Freight: 25.00,
    TotalDue: 3889.53,
    OrderItems: [
      { SalesOrderDetailID: 1, ProductID: 749, ProductName: 'Road-150', OrderQty: 1, UnitPrice: 3578.27, LineTotal: 3578.27 },
    ],
  },
  {
    SalesOrderID: 70002,
    CustomerID: 1002,
    OrderDate: '2024-11-18T14:45:00Z',
    DueDate: '2024-11-25T14:45:00Z',
    ShipDate: '2024-11-20T09:00:00Z',
    Status: 'Shipped',
    SubTotal: 2443.35,
    TaxAmt: 195.47,
    Freight: 35.00,
    TotalDue: 2673.82,
    OrderItems: [
      { SalesOrderDetailID: 2, ProductID: 750, ProductName: 'Road-250', OrderQty: 1, UnitPrice: 2443.35, LineTotal: 2443.35 },
    ],
  },
  {
    SalesOrderID: 70003,
    CustomerID: 1003,
    OrderDate: '2024-11-20T09:15:00Z',
    DueDate: '2024-11-27T09:15:00Z',
    ShipDate: null,
    Status: 'Processing',
    SubTotal: 5699.98,
    TaxAmt: 456.00,
    Freight: 0,
    TotalDue: 6155.98,
    OrderItems: [
      { SalesOrderDetailID: 3, ProductID: 751, ProductName: 'Mountain-100', OrderQty: 1, UnitPrice: 3399.99, LineTotal: 3399.99 },
      { SalesOrderDetailID: 4, ProductID: 752, ProductName: 'Mountain-200', OrderQty: 1, UnitPrice: 2319.99, LineTotal: 2319.99 },
    ],
  },
  {
    SalesOrderID: 70004,
    CustomerID: 1004,
    OrderDate: '2024-11-21T16:20:00Z',
    DueDate: '2024-11-28T16:20:00Z',
    ShipDate: null,
    Status: 'Pending',
    SubTotal: 899.99,
    TaxAmt: 72.00,
    Freight: 15.00,
    TotalDue: 986.99,
    OrderItems: [
      { SalesOrderDetailID: 5, ProductID: 757, ProductName: 'Mountain-300', OrderQty: 1, UnitPrice: 1079.99, LineTotal: 1079.99 },
    ],
  },
  {
    SalesOrderID: 70005,
    CustomerID: 1005,
    OrderDate: '2024-11-10T11:00:00Z',
    DueDate: '2024-11-17T11:00:00Z',
    ShipDate: '2024-11-12T10:00:00Z',
    Status: 'Delivered',
    SubTotal: 7834.56,
    TaxAmt: 626.76,
    Freight: 50.00,
    TotalDue: 8511.32,
    OrderItems: [
      { SalesOrderDetailID: 6, ProductID: 753, ProductName: 'Touring-1000', OrderQty: 2, UnitPrice: 2384.07, LineTotal: 4768.14 },
      { SalesOrderDetailID: 7, ProductID: 850, ProductName: 'Short-Sleeve Classic Jersey', OrderQty: 4, UnitPrice: 53.99, LineTotal: 215.96 },
    ],
  },
  {
    SalesOrderID: 70006,
    CustomerID: 1006,
    OrderDate: '2024-11-05T13:30:00Z',
    DueDate: '2024-11-12T13:30:00Z',
    ShipDate: null,
    Status: 'Cancelled',
    SubTotal: 1700.99,
    TaxAmt: 136.08,
    Freight: 25.00,
    TotalDue: 1862.07,
    OrderItems: [
      { SalesOrderDetailID: 8, ProductID: 755, ProductName: 'Road-350-W', OrderQty: 1, UnitPrice: 1700.99, LineTotal: 1700.99 },
    ],
  },
  {
    SalesOrderID: 70007,
    CustomerID: 1007,
    OrderDate: '2024-11-22T08:45:00Z',
    DueDate: '2024-11-29T08:45:00Z',
    ShipDate: null,
    Status: 'Pending',
    SubTotal: 564.99,
    TaxAmt: 45.20,
    Freight: 10.00,
    TotalDue: 620.19,
    OrderItems: [
      { SalesOrderDetailID: 9, ProductID: 759, ProductName: 'Mountain-500', OrderQty: 1, UnitPrice: 564.99, LineTotal: 564.99 },
    ],
  },
  {
    SalesOrderID: 70008,
    CustomerID: 1008,
    OrderDate: '2024-11-19T15:15:00Z',
    DueDate: '2024-11-26T15:15:00Z',
    ShipDate: '2024-11-21T11:30:00Z',
    Status: 'Shipped',
    SubTotal: 4143.34,
    TaxAmt: 331.47,
    Freight: 40.00,
    TotalDue: 4514.81,
    OrderItems: [
      { SalesOrderDetailID: 10, ProductID: 802, ProductName: 'ML Road Frame', OrderQty: 2, UnitPrice: 594.83, LineTotal: 1189.66 },
      { SalesOrderDetailID: 11, ProductID: 813, ProductName: 'HL Road Frame - Black', OrderQty: 2, UnitPrice: 1431.50, LineTotal: 2863.00 },
    ],
  },
];

export const getCustomerById = (customerId: number): Customer | undefined => {
  return mockCustomers.find(c => c.CustomerID === customerId);
};

export const getOrdersByCustomerId = (customerId: number): Order[] => {
  return mockOrders.filter(o => o.CustomerID === customerId);
};

export const getOrderById = (orderId: number): Order | undefined => {
  return mockOrders.find(o => o.SalesOrderID === orderId);
};
