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
import { CURRENCY_SYMBOLS } from "@/lib/currencies";

// GraphQL: use _by_pk for single-record lookups to avoid filter-related 400s from DAB
const GET_ORDER_BY_PK = gql`
  query GetOrderByPk($salesOrderId: Int!) {
    salesOrderHeader_by_pk(SalesOrderID: $salesOrderId) {
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
`;

// Address is exposed by Azure Functions API (api/addresses/{id}), not DAB.
// StateProvince in DAB has no relationship to CountryRegion; only CountryRegionCode scalar.
const GET_STATE_PROVINCE = gql`
  query GetStateProvince($stateProvinceId: Int!) {
    stateProvince_by_pk(StateProvinceID: $stateProvinceId) {
      StateProvinceCode
      Name
      CountryRegionCode
    }
  }
`;

const GET_COUNTRY_REGION = gql`
  query GetCountryRegion($countryRegionCode: String!) {
    countryRegion_by_pk(CountryRegionCode: $countryRegionCode) {
      Name
    }
  }
`;

const GET_COUNTRY_CURRENCY = gql`
  query GetCountryCurrency($countryCode: String!) {
    countryRegionCurrencies(
      filter: { CountryRegionCode: { eq: $countryCode } }
    ) {
      items {
        CurrencyCode
      }
    }
  }
`;

const GET_CURRENCY_RATE = gql`
  query GetCurrencyRate($toCurrencyCode: String!) {
    currencyRates(
      filter: {
        FromCurrencyCode: { eq: "USD" }
        ToCurrencyCode: { eq: $toCurrencyCode }
      }
    ) {
      items {
        AverageRate
      }
    }
  }
`;

const GET_CUSTOMER_BY_PK = gql`
  query GetCustomerByPk($customerId: Int!) {
    customer_by_pk(CustomerID: $customerId) {
      PersonID
    }
  }
`;

const GET_PERSON_BY_PK = gql`
  query GetPersonByPk($personId: Int!) {
    person_by_pk(BusinessEntityID: $personId) {
      FirstName
      LastName
      emailAddresses {
        items {
          EmailAddress
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
    countryRegionCode?: string;
  };
  shippingMethodName: string;
  subtotal: number;
  shippingCost: number;
  tax: number;
  total: number;
  date: string;
  /** Currency for display (e.g. GBP for UK address). Order amounts are stored in USD. */
  currencyCode: string;
  /** Exchange rate from USD to currencyCode (e.g. ~0.79 for GBP). */
  exchangeRate: number;
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
      const emailIdParam = searchParams.get("emailId");
      if (!orderId) {
        setLoading(false);
        return;
      }

      // Retrieve EmailAddressId from URL params or localStorage
      const storedEmailId = localStorage.getItem("checkout_email_id");
      const selectedEmailId = emailIdParam
        ? parseInt(emailIdParam, 10)
        : storedEmailId
          ? parseInt(storedEmailId, 10)
          : null;

      if (selectedEmailId != null && !isNaN(selectedEmailId)) {
        setEmailAddressId(selectedEmailId);
        // Fetch the actual email address (filter query; variable must be Int)
        try {
          const emailAddressIdInt = Number(selectedEmailId);
          const emailResponse = await graphqlClient.request<{
            emailAddresses: { items: Array<{ EmailAddress: string }> };
          }>(GET_EMAIL_ADDRESS, { emailAddressId: emailAddressIdInt });

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
        // Parse order ID (format: "SO-12345" -> 12345) and ensure integer for GraphQL
        const salesOrderId = parseInt(orderId.replace(/^SO-/, ""), 10);
        if (isNaN(salesOrderId)) {
          trackError("Invalid order ID format", undefined, {
            page: "OrderConfirmationPage",
            orderId: orderId,
          });
          setLoading(false);
          return;
        }

        // Fetch order by primary key (avoids filter-related 400 from DAB)
        const orderResponse = await graphqlClient.request<{
          salesOrderHeader_by_pk: {
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
          } | null;
        }>(GET_ORDER_BY_PK, { salesOrderId });

        const orderData = orderResponse.salesOrderHeader_by_pk;
        if (!orderData) {
          trackError("Order not found", undefined, {
            page: "OrderConfirmationPage",
            salesOrderId: salesOrderId,
          });
          setLoading(false);
          return;
        }

        // Fetch shipping address from Azure Functions API (Address is not in DAB)
        const shipToAddressId = Number(orderData.ShipToAddressID);
        let address: {
          AddressLine1: string;
          AddressLine2: string | null;
          City: string;
          StateProvince: { StateProvinceCode: string; Name: string } | null;
          PostalCode: string;
          CountryRegion: { Name: string } | null;
        } | null = null;
        let countryRegionCode: string | null = null;
        if (Number.isInteger(shipToAddressId) && shipToAddressId > 0) {
          const functionsApiUrl = getFunctionsApiUrl();
          const addressApiUrl = `${functionsApiUrl}/api/addresses/${shipToAddressId}`;
          const addressRes = await fetch(addressApiUrl);
          if (addressRes.ok) {
            // Functions API uses camelCase (JsonNamingPolicy.CamelCase)
            const raw = (await addressRes.json()) as Record<string, unknown>;
            const addressLine1 = (raw.addressLine1 ?? raw.AddressLine1) as string ?? "";
            const addressLine2 = (raw.addressLine2 ?? raw.AddressLine2) as string | null | undefined;
            const city = (raw.city ?? raw.City) as string ?? "";
            const stateProvinceId = Number(raw.stateProvinceID ?? raw.StateProvinceID ?? 0);
            const postalCode = (raw.postalCode ?? raw.PostalCode) as string ?? "";
            let stateProvince: { StateProvinceCode: string; Name: string } | null = null;
            let countryRegion: { Name: string } | null = null;
            if (Number.isInteger(stateProvinceId) && stateProvinceId > 0) {
              try {
                const stateResponse = await graphqlClient.request<{
                  stateProvince_by_pk: {
                    StateProvinceCode: string;
                    Name: string;
                    CountryRegionCode: string;
                  } | null;
                }>(GET_STATE_PROVINCE, { stateProvinceId });
                const sp = stateResponse.stateProvince_by_pk;
                if (sp) {
                  stateProvince = { StateProvinceCode: sp.StateProvinceCode, Name: sp.Name };
                  if (sp.CountryRegionCode) {
                    countryRegionCode = sp.CountryRegionCode;
                    const countryResponse = await graphqlClient.request<{
                      countryRegion_by_pk: { Name: string } | null;
                    }>(GET_COUNTRY_REGION, { countryRegionCode: sp.CountryRegionCode });
                    if (countryResponse.countryRegion_by_pk?.Name) {
                      countryRegion = { Name: countryResponse.countryRegion_by_pk.Name };
                    }
                  }
                }
              } catch {
                // State/country optional; address still displays
              }
            }
            address = {
              AddressLine1: addressLine1,
              AddressLine2: addressLine2 ?? null,
              City: city,
              StateProvince: stateProvince,
              PostalCode: postalCode,
              CountryRegion: countryRegion,
            };
          }
        }

        // Fetch customer by primary key, then person
        const customerIdInt = Number(orderData.CustomerID);
        const customerResponse = await graphqlClient.request<{
          customer_by_pk: { PersonID: number | null } | null;
        }>(GET_CUSTOMER_BY_PK, { customerId: customerIdInt });

        const personId = customerResponse.customer_by_pk?.PersonID ?? null;
        let firstName = "Customer";
        let lastName = "";
        let email = "";

        if (personId != null && Number.isInteger(Number(personId))) {
          const personResponse = await graphqlClient.request<{
            person_by_pk: {
              FirstName: string;
              LastName: string;
              emailAddresses: { items: Array<{ EmailAddress: string }> };
            } | null;
          }>(GET_PERSON_BY_PK, { personId: Number(personId) });

          const person = personResponse.person_by_pk;
          if (person) {
            firstName = person.FirstName;
            lastName = person.LastName;
            email = person.emailAddresses.items[0]?.EmailAddress || "";
          }
        }

        // Resolve currency from shipping address country (order amounts are in USD)
        let currencyCode = "USD";
        let exchangeRate = 1;
        if (countryRegionCode) {
          try {
            const currencyResponse = await graphqlClient.request<{
              countryRegionCurrencies: { items: Array<{ CurrencyCode: string }> };
            }>(GET_COUNTRY_CURRENCY, { countryCode: countryRegionCode });
            if (currencyResponse.countryRegionCurrencies.items.length > 0) {
              const targetCurrency = currencyResponse.countryRegionCurrencies.items[0].CurrencyCode;
              if (targetCurrency !== "USD") {
                const rateResponse = await graphqlClient.request<{
                  currencyRates: { items: Array<{ AverageRate: number }> };
                }>(GET_CURRENCY_RATE, { toCurrencyCode: targetCurrency });
                if (rateResponse.currencyRates.items.length > 0) {
                  currencyCode = targetCurrency;
                  exchangeRate = rateResponse.currencyRates.items[0].AverageRate;
                }
              }
            }
          } catch (err) {
            trackError("Error fetching order currency", err, {
              page: "OrderConfirmationPage",
              countryRegionCode,
            });
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
            countryRegionCode: countryRegionCode ?? undefined,
          },
          shippingMethodName: orderData.shipMethod?.Name || "Standard Shipping",
          subtotal: orderData.SubTotal,
          shippingCost: orderData.Freight,
          tax: orderData.TaxAmt,
          total: orderData.TotalDue,
          date: orderData.OrderDate,
          currencyCode,
          exchangeRate,
        };

        setOrder(order);

        // Clear the stored email ID from localStorage after order is confirmed
        localStorage.removeItem("checkout_email_id");

        // Generate PDF receipt and send confirmation email with attachment (fire-and-forget)
        const willSendReceipt = !!(selectedEmailId && orderData.CustomerID);
        if (willSendReceipt) {
          try {
            const functionsApiUrl = getFunctionsApiUrl();
            const receiptUrl = `${functionsApiUrl}/api/orders/generate-and-send-receipt`;
            const receiptBody = {
              salesOrderId: Number(salesOrderId),
              customerId: Number(orderData.CustomerID),
              emailAddressId: Number(selectedEmailId),
            };
            const response = await fetch(receiptUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(receiptBody),
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
              trackError("Failed to initiate receipt and email", undefined, {
                page: "OrderConfirmationPage",
                salesOrderId: salesOrderId,
                responseText: responseText,
              });
            }
          } catch (error) {
            const errMsg =
              "We couldn't send your receipt email. Please contact support with your order number.";
            setReceiptError(errMsg);
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
                {selectedEmail || order.shipping.email}
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
                  {order.items.map((item, index) => {
                    const formatPrice = (amount: number) =>
                      `${CURRENCY_SYMBOLS[order.currencyCode] ?? order.currencyCode}${(amount * order.exchangeRate).toFixed(2)}`;
                    return (
                      <div
                        key={`${item.ProductID}-${index}`}
                        className="flex justify-between font-doodle text-sm"
                      >
                        <span className="text-doodle-text/70">
                          {item.Name} × {item.quantity}
                        </span>
                        <span>{formatPrice(item.ListPrice * item.quantity)}</span>
                      </div>
                    );
                  })}
                </div>

                <hr className="border-dashed border-doodle-text/30" />

                <div className="space-y-2 font-doodle text-sm">
                  {(() => {
                    const formatPrice = (amount: number) =>
                      `${CURRENCY_SYMBOLS[order.currencyCode] ?? order.currencyCode}${(amount * order.exchangeRate).toFixed(2)}`;
                    return (
                      <>
                        <div className="flex justify-between">
                          <span className="text-doodle-text/70">
                            {t("orderTracking.subtotal")}
                          </span>
                          <span>{formatPrice(order.subtotal)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-doodle-text/70">
                            {t("orderTracking.shipping")} ({order.shippingMethodName})
                          </span>
                          <span>
                            {order.shippingCost === 0
                              ? t("orderConfirmation.free")
                              : formatPrice(order.shippingCost)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-doodle-text/70">
                            {t("orderTracking.tax")}
                          </span>
                          <span>{formatPrice(order.tax)}</span>
                        </div>
                        <hr className="border-dashed border-doodle-text/30" />
                        <div className="flex justify-between text-lg font-bold">
                          <span>{t("orderTracking.total")}</span>
                          <span className="text-doodle-green">
                            {formatPrice(order.total)}
                          </span>
                        </div>
                      </>
                    );
                  })()}
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
                  {order.shipping.address2 && <p>{order.shipping.address2}</p>}
                  <p>
                    {order.shipping.city}, {order.shipping.state}{" "}
                    {order.shipping.zipCode}
                    {order.shipping.country && (
                      <>, {order.shipping.country}</>
                    )}
                  </p>
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
