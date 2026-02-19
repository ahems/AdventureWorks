import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, Package, Truck, MapPin, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { gql } from "graphql-request";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { getFunctionsApiUrl } from "@/lib/utils";
import { graphqlClient } from "@/lib/graphql-client";
import { trackError, trackEvent } from "@/lib/appInsights";

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

const GET_EMAIL_ADDRESS = gql`
  query GetEmailAddress($emailAddressId: Int!) {
    emailAddresses(filter: { EmailAddressID: { eq: $emailAddressId } }) {
      items {
        EmailAddress
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
  const [emailAddressId, setEmailAddressId] = useState<number | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<string>("");
  const [receiptRequestSent, setReceiptRequestSent] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const { t } = useTranslation("common");

  // Fetch order data from API using order ID from URL
  useEffect(() => {
    const fetchOrder = async () => {
      const orderId = searchParams.get("orderId");
      if (!orderId) {
        setLoading(false);
        return;
      }

      // Retrieve EmailAddressId from URL params or localStorage
      const emailIdParam = searchParams.get("emailId");
      const storedEmailId = localStorage.getItem("checkout_email_id");
      const selectedEmailId = emailIdParam
        ? parseInt(emailIdParam, 10)
        : storedEmailId
          ? parseInt(storedEmailId, 10)
          : null;

      if (selectedEmailId) {
        setEmailAddressId(selectedEmailId);
        // Fetch the actual email address
        try {
          const emailResponse = await graphqlClient.request<{
            emailAddresses: { items: Array<{ EmailAddress: string }> };
          }>(GET_EMAIL_ADDRESS, { emailAddressId: selectedEmailId });

          if (emailResponse.emailAddresses.items.length > 0) {
            setSelectedEmail(
              emailResponse.emailAddresses.items[0].EmailAddress,
            );
          }
        } catch (error) {
          trackError("Error fetching selected email", error, {
            page: "OrderConfirmationPage",
            emailAddressId: selectedEmailId,
          });
        }
      }

      try {
        // Parse order ID (format: "SO-12345" -> 12345)
        const salesOrderId = parseInt(orderId.replace(/^SO-/, ""), 10);
        if (isNaN(salesOrderId)) {
          trackError("Invalid order ID format", undefined, {
            page: "OrderConfirmationPage",
            orderId: orderId,
          });
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
          trackError("Order not found", undefined, {
            page: "OrderConfirmationPage",
            salesOrderId: salesOrderId,
          });
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

        // Clear the stored email ID from localStorage after order is confirmed
        localStorage.removeItem("checkout_email_id");

        // Generate PDF receipt and send confirmation email with attachment (fire-and-forget)
        if (selectedEmailId && orderData.CustomerID) {
          try {
            const functionsApiUrl = getFunctionsApiUrl();
            const receiptUrl = `${functionsApiUrl}/api/orders/generate-and-send-receipt`;
            const response = await fetch(receiptUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                salesOrderId: salesOrderId,
                customerId: orderData.CustomerID,
                emailAddressId: selectedEmailId,
              }),
            });

            if (response.ok) {
              setReceiptRequestSent(true);
              trackEvent("Order_ReceiptGenerationInitiated", {
                salesOrderId: salesOrderId,
                emailAddressId: selectedEmailId,
              });
            } else {
              const responseText = await response.text();
              const errMsg = `Receipt request failed (${response.status}). Check browser console for URL and response.`;
              setReceiptError(errMsg);
              if (typeof console !== "undefined" && console.warn) {
                console.warn("[OrderConfirmation] Receipt request failed.", {
                  url: receiptUrl,
                  status: response.status,
                  responseText: responseText.slice(0, 200),
                });
              }
              trackError("Failed to initiate receipt and email", undefined, {
                page: "OrderConfirmationPage",
                salesOrderId: salesOrderId,
                responseText: responseText,
              });
            }
          } catch (error) {
            const functionsApiUrl = getFunctionsApiUrl();
            const receiptUrl = `${functionsApiUrl}/api/orders/generate-and-send-receipt`;
            const errMsg =
              "We couldn't send your receipt email. Please contact support with your order number.";
            setReceiptError(errMsg);
            if (typeof console !== "undefined" && console.warn) {
              console.warn("[OrderConfirmation] Receipt request error.", {
                url: receiptUrl,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            trackError("Error initiating receipt generation and email", error, {
              page: "OrderConfirmationPage",
              salesOrderId: salesOrderId,
              emailAddressId: selectedEmailId,
            });
          }
        }
      } catch (error) {
        trackError("Error fetching order", error, {
          page: "OrderConfirmationPage",
          orderId: orderId,
        });
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
          <div className="max-w-2xl mx-auto text-center">
            <div className="doodle-card p-12">
              <div className="inline-flex items-center justify-center w-20 h-20 bg-doodle-green/20 rounded-full mb-6">
                <CheckCircle className="w-12 h-12 text-doodle-green" />
              </div>
              <h1 className="font-doodle text-4xl font-bold text-doodle-text mb-4">
                🎉 Order Confirmed!
              </h1>
              <p className="font-doodle text-xl text-doodle-text mb-6">
                Thank you for your order!
              </p>

              <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-6 mb-6">
                <p className="font-doodle text-lg text-yellow-800 mb-2">
                  <span className="text-2xl">🎪</span>{" "}
                  <strong>Demo Site Alert!</strong>
                </p>
                <p className="font-doodle text-sm text-yellow-700">
                  Relax! No real payment was processed, no actual products will
                  arrive at your door, and your wallet is safe. This is all
                  pretend shopping magic! ✨
                </p>
              </div>

              {receiptError && (
                <div className="bg-red-50 border-2 border-red-300 rounded-lg p-6 mb-8">
                  <p className="font-doodle text-lg font-bold text-red-900">
                    Receipt email issue
                  </p>
                  <p className="font-doodle text-sm text-red-800 mt-2">
                    {receiptError}
                  </p>
                  <p className="font-doodle text-xs text-red-700 mt-2">
                    Order number: {order.shipping.orderNumber}
                  </p>
                </div>
              )}
              {selectedEmail && receiptRequestSent && !receiptError && (
                <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-6 mb-8">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <Mail className="w-6 h-6 text-blue-600" />
                    <p className="font-doodle text-lg font-bold text-blue-900">
                      Receipt Sent!
                    </p>
                  </div>
                  <p className="font-doodle text-sm text-blue-700">
                    Your order receipt has been emailed to:
                  </p>
                  <p className="font-doodle text-base font-bold text-blue-900 mt-2">
                    {selectedEmail}
                  </p>
                  <p className="font-doodle text-xs text-blue-600 mt-2">
                    (Check your spam folder if you don't see it!)
                  </p>
                </div>
              )}

              <Link
                to="/"
                className="doodle-button doodle-button-primary inline-block px-8 py-3"
              >
                Continue Pretend Shopping 🛒
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

          {receiptError && (
            <div className="max-w-2xl mx-auto mb-8">
              <div className="bg-red-50 border-2 border-red-300 rounded-lg p-6">
                <p className="font-doodle text-lg font-bold text-red-900">
                  Receipt email issue
                </p>
                <p className="font-doodle text-sm text-red-800 mt-2">
                  {receiptError}
                </p>
                <p className="font-doodle text-xs text-red-700 mt-2">
                  Order number: {order.id}
                </p>
              </div>
            </div>
          )}
          {selectedEmail && receiptRequestSent && !receiptError && (
            <div className="max-w-2xl mx-auto mb-8">
              <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-6">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <Mail className="w-6 h-6 text-blue-600" />
                  <p className="font-doodle text-lg font-bold text-blue-900">
                    Receipt Sent!
                  </p>
                </div>
                <p className="font-doodle text-sm text-blue-700">
                  Your order receipt has been emailed to:
                </p>
                <p className="font-doodle text-base font-bold text-blue-900 mt-2">
                  {selectedEmail}
                </p>
                <p className="font-doodle text-xs text-blue-600 mt-2">
                  (Check your spam folder if you don't see it!)
                </p>
              </div>
            </div>
          )}

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
