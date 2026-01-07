import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, Package, Truck, MapPin, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { gql } from "graphql-request";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { getFunctionsApiUrl } from "@/lib/utils";
import { graphqlClient } from "@/lib/graphql-client";

// GraphQL query to fetch order details with relationships
const GET_ORDER_DETAILS = gql`
  query GetOrderDetails($salesOrderId: Int!) {
    salesOrderHeaders(filter: { SalesOrderID: { eq: $salesOrderId } }) {
      items {
        SalesOrderID
        SalesOrderNumber
        OrderDate
        SubTotal
        TaxAmt
        Freight
        TotalDue
        ShipToAddressID
        BillToAddressID
        CustomerID
        shipMethod {
          Name
        }
        salesOrderDetails {
          items {
            ProductID
            OrderQty
            UnitPrice
            UnitPriceDiscount
            LineTotal
            product {
              ProductID
              Name
            }
          }
        }
      }
    }
  }
`;

const GET_ADDRESS = gql`
  query GetAddress($addressId: Int!) {
    addresses(filter: { AddressID: { eq: $addressId } }) {
      items {
        AddressID
        AddressLine1
        AddressLine2
        City
        StateProvince {
          StateProvinceCode
          Name
        }
        PostalCode
        CountryRegion {
          Name
        }
      }
    }
  }
`;

const GET_CUSTOMER = gql`
  query GetCustomer($customerId: Int!) {
    customers(filter: { CustomerID: { eq: $customerId } }) {
      items {
        PersonID
      }
    }
  }
`;

const GET_PERSON = gql`
  query GetPerson($personId: Int!) {
    people(filter: { BusinessEntityID: { eq: $personId } }) {
      items {
        FirstName
        LastName
        emailAddresses {
          items {
            EmailAddress
          }
        }
      }
    }
  }
`;

interface OrderItem {
  ProductID: number;
  Name: string;
  ListPrice: number;
  quantity: number;
  discount: number;
}

interface Order {
  id: string;
  salesOrderNumber: string;
  items: OrderItem[];
  shipping: {
    firstName: string;
    lastName: string;
    email: string;
    address: string;
    address2?: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  shippingMethodName: string;
  subtotal: number;
  shippingCost: number;
  tax: number;
  total: number;
  date: string;
}

const OrderConfirmationPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation("common");

  // Fetch order data from API using order ID from URL
  useEffect(() => {
    const fetchOrder = async () => {
      const orderId = searchParams.get("orderId");
      if (!orderId) {
        setLoading(false);
        return;
      }

      try {
        // Parse order ID (format: "SO-12345" -> 12345)
        const salesOrderId = parseInt(orderId.replace(/^SO-/, ""), 10);
        if (isNaN(salesOrderId)) {
          console.error("Invalid order ID format");
          setLoading(false);
          return;
        }

        // Fetch order header with details
        const orderResponse = await graphqlClient.request<{
          salesOrderHeaders: {
            items: Array<{
              SalesOrderID: number;
              SalesOrderNumber: string;
              OrderDate: string;
              SubTotal: number;
              TaxAmt: number;
              Freight: number;
              TotalDue: number;
              ShipToAddressID: number;
              CustomerID: number;
              shipMethod: { Name: string } | null;
              salesOrderDetails: {
                items: Array<{
                  ProductID: number;
                  OrderQty: number;
                  UnitPrice: number;
                  UnitPriceDiscount: number;
                  LineTotal: number;
                  product: { ProductID: number; Name: string } | null;
                }>;
              };
            }>;
          };
        }>(GET_ORDER_DETAILS, { salesOrderId });

        const orderData = orderResponse.salesOrderHeaders.items[0];
        if (!orderData) {
          console.error("Order not found");
          setLoading(false);
          return;
        }

        // Fetch shipping address
        const addressResponse = await graphqlClient.request<{
          addresses: {
            items: Array<{
              AddressLine1: string;
              AddressLine2: string | null;
              City: string;
              StateProvince: { StateProvinceCode: string; Name: string } | null;
              PostalCode: string;
              CountryRegion: { Name: string } | null;
            }>;
          };
        }>(GET_ADDRESS, { addressId: orderData.ShipToAddressID });

        const address = addressResponse.addresses.items[0];

        // Fetch customer and person info
        const customerResponse = await graphqlClient.request<{
          customers: { items: Array<{ PersonID: number | null }> };
        }>(GET_CUSTOMER, { customerId: orderData.CustomerID });

        const personId = customerResponse.customers.items[0]?.PersonID;
        let firstName = "Customer";
        let lastName = "";
        let email = "";

        if (personId) {
          const personResponse = await graphqlClient.request<{
            people: {
              items: Array<{
                FirstName: string;
                LastName: string;
                emailAddresses: { items: Array<{ EmailAddress: string }> };
              }>;
            };
          }>(GET_PERSON, { personId });

          const person = personResponse.people.items[0];
          if (person) {
            firstName = person.FirstName;
            lastName = person.LastName;
            email = person.emailAddresses.items[0]?.EmailAddress || "";
          }
        }

        // Build order object
        const order: Order = {
          id: orderId,
          salesOrderNumber: orderData.SalesOrderNumber,
          items: orderData.salesOrderDetails.items.map((detail) => ({
            ProductID: detail.ProductID,
            Name: detail.product?.Name || "Unknown Product",
            ListPrice: detail.UnitPrice,
            quantity: detail.OrderQty,
            discount: detail.UnitPriceDiscount,
          })),
          shipping: {
            firstName,
            lastName,
            email,
            address: address?.AddressLine1 || "",
            address2: address?.AddressLine2 || undefined,
            city: address?.City || "",
            state: address?.StateProvince?.StateProvinceCode || "",
            zipCode: address?.PostalCode || "",
            country: address?.CountryRegion?.Name || "",
          },
          shippingMethodName: orderData.shipMethod?.Name || "Standard Shipping",
          subtotal: orderData.SubTotal,
          shippingCost: orderData.Freight,
          tax: orderData.TaxAmt,
          total: orderData.TotalDue,
          date: orderData.OrderDate,
        };

        setOrder(order);

        // Generate PDF receipt
        try {
          const functionsApiUrl = getFunctionsApiUrl();
          const response = await fetch(
            `${functionsApiUrl}/api/GenerateOrderReceipts_HttpStart`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                salesOrderNumbers: [orderData.SalesOrderNumber],
              }),
            }
          );

          if (!response.ok) {
            console.error("Failed to generate receipt:", await response.text());
          } else {
            const result = await response.json();
            console.log("Receipt generation queued:", result);
          }
        } catch (error) {
          console.error("Error generating receipt:", error);
        }
      } catch (error) {
        console.error("Error fetching order:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchOrder();
  }, [searchParams]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <div className="doodle-card p-12">
              <Package className="w-20 h-20 mx-auto mb-6 text-doodle-accent animate-pulse" />
              <p className="font-doodle text-doodle-text/70">
                {t("orderTracking.loading")}
              </p>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <div className="doodle-card p-12">
              <Package className="w-20 h-20 mx-auto mb-6 text-doodle-text/40" />
              <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
                {t("orderConfirmation.noOrderFound")}
              </h1>
              <p className="font-doodle text-doodle-text/70 mb-8">
                {t("orderConfirmation.noOrderMessage")}
              </p>
              <Link
                to="/"
                className="doodle-button doodle-button-primary inline-block"
              >
                {t("orderTracking.startShopping")}
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const estimatedDelivery = new Date();
  estimatedDelivery.setDate(estimatedDelivery.getDate() + 5);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <section className="container mx-auto px-4 py-12">
          {/* Success Header */}
          <div className="max-w-2xl mx-auto text-center mb-12">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-doodle-green/20 rounded-full mb-6">
              <CheckCircle className="w-12 h-12 text-doodle-green" />
            </div>
            <h1 className="font-doodle text-4xl md:text-5xl font-bold text-doodle-text mb-4">
              {t("orderConfirmation.title")}
            </h1>
            <p className="font-doodle text-lg text-doodle-text/70">
              {t("orderConfirmation.thankYou")}{" "}
              <span className="font-bold text-doodle-text">
                {order.shipping.email}
              </span>
            </p>
          </div>

          <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Order Details Card */}
            <div className="doodle-card p-6">
              <div className="flex items-center gap-3 mb-6">
                <Package className="w-6 h-6 text-doodle-accent" />
                <h2 className="font-doodle text-xl font-bold text-doodle-text">
                  {t("orderConfirmation.orderDetails")}
                </h2>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between font-doodle">
                  <span className="text-doodle-text/70">
                    {t("orderTracking.orderNumber")}
                  </span>
                  <span className="font-bold text-doodle-accent">
                    {order.id}
                  </span>
                </div>
                <div className="flex justify-between font-doodle">
                  <span className="text-doodle-text/70">
                    {t("orderConfirmation.orderDate")}
                  </span>
                  <span>{new Date(order.date).toLocaleDateString()}</span>
                </div>
                <div className="flex justify-between font-doodle">
                  <span className="text-doodle-text/70">
                    {t("orderConfirmation.paymentMethod")}
                  </span>
                  <span className="capitalize">{order.paymentMethod}</span>
                </div>

                <hr className="border-dashed border-doodle-text/30" />

                {/* Items */}
                <div className="space-y-3">
                  {order.items.map((item, index) => (
                    <div
                      key={`${item.ProductID}-${index}`}
                      className="flex justify-between font-doodle text-sm"
                    >
                      <span className="text-doodle-text/70">
                        {item.Name} × {item.quantity}
                      </span>
                      <span>
                        ${(item.ListPrice * item.quantity).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>

                <hr className="border-dashed border-doodle-text/30" />

                <div className="space-y-2 font-doodle text-sm">
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">
                      {t("orderTracking.subtotal")}
                    </span>
                    <span>${order.subtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">
                      {t("orderTracking.shipping")} ({order.shippingMethodName})
                    </span>
                    <span>
                      {order.shippingCost === 0
                        ? t("orderConfirmation.free")
                        : `$${order.shippingCost.toFixed(2)}`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">
                      {t("orderTracking.tax")}
                    </span>
                    <span>${order.tax.toFixed(2)}</span>
                  </div>
                  <hr className="border-dashed border-doodle-text/30" />
                  <div className="flex justify-between text-lg font-bold">
                    <span>{t("orderTracking.total")}</span>
                    <span className="text-doodle-green">
                      ${order.total.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Shipping & Delivery Card */}
            <div className="space-y-6">
              {/* Shipping Address */}
              <div className="doodle-card p-6">
                <div className="flex items-center gap-3 mb-4">
                  <MapPin className="w-6 h-6 text-doodle-accent" />
                  <h2 className="font-doodle text-xl font-bold text-doodle-text">
                    {t("orderConfirmation.shippingAddress")}
                  </h2>
                </div>
                <div className="font-doodle text-doodle-text/70 space-y-1">
                  <p className="font-bold text-doodle-text">
                    {order.shipping.firstName} {order.shipping.lastName}
                  </p>
                  <p>{order.shipping.address}</p>
                  <p>
                    {order.shipping.city}, {order.shipping.state}{" "}
                    {order.shipping.zipCode}
                  </p>
                  <p>{order.shipping.country}</p>
                </div>
              </div>

              {/* Estimated Delivery */}
              <div className="doodle-card p-6">
                <div className="flex items-center gap-3 mb-4">
                  <Truck className="w-6 h-6 text-doodle-accent" />
                  <h2 className="font-doodle text-xl font-bold text-doodle-text">
                    {t("orderConfirmation.estimatedDelivery")}
                  </h2>
                </div>
                <p className="font-doodle text-2xl font-bold text-doodle-green">
                  {estimatedDelivery.toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
                <p className="font-doodle text-sm text-doodle-text/70 mt-2">
                  {t("orderConfirmation.trackingEmail")}
                </p>
              </div>

              {/* Email Confirmation */}
              <div className="doodle-card p-6 bg-doodle-accent/5">
                <div className="flex items-center gap-3">
                  <Mail className="w-6 h-6 text-doodle-accent" />
                  <div>
                    <p className="font-doodle font-bold text-doodle-text">
                      {t("orderConfirmation.confirmationSent")}
                    </p>
                    <p className="font-doodle text-sm text-doodle-text/70">
                      {t("orderConfirmation.checkEmail")}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Continue Shopping */}
          <div className="max-w-4xl mx-auto mt-12 text-center">
            <Link
              to="/"
              className="doodle-button doodle-button-primary inline-block px-8 py-3 text-lg"
            >
              {t("orderConfirmation.continueShopping")}
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default OrderConfirmationPage;
