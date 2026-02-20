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

        // Start order status processing pipeline (fire-and-forget)
        try {
          const functionsApiUrl = getFunctionsApiUrl();
          const beginProcessingUrl = `${functionsApiUrl}/api/orders/begin-processing-order`;
          const beginResponse = await fetch(beginProcessingUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ salesOrderId: Number(salesOrderId) }),
          });
          if (beginResponse.ok) {
            trackEvent("Order_StatusProcessingInitiated", { salesOrderId: salesOrderId });
          } else {
            trackError("Failed to initiate order status processing", undefined, {
              page: "OrderConfirmationPage",
              salesOrderId: salesOrderId,
              status: beginResponse.status,
            });
          }
        } catch (error) {
          trackError("Error initiating order status processing", error, {
            page: "OrderConfirmationPage",
            salesOrderId: salesOrderId,
          });
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
          <div className="max-w-md mx-auto text-center">
            <div className="doodle-card p-12">
              <p className="font-doodle text-doodle-text/70">
                {t("orderTracking.notFound")}
              </p>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 container mx-auto px-4 py-12">
        <div className="max-w-md mx-auto">
          {receiptError && (
            <div className="mb-4 p-4 rounded-lg bg-doodle-warning/20 text-doodle-warning border border-doodle-warning/40">
              {receiptError}
            </div>
          )}
          <div className="doodle-card p-8">
            <div className="flex items-center gap-3 mb-6">
              <CheckCircle className="w-12 h-12 text-doodle-accent flex-shrink-0" />
              <div>
                <h1 className="font-doodle text-2xl text-doodle-text">
                  {t("orderTracking.thankYou")}
                </h1>
                <p className="font-doodle text-doodle-text/70">
                  {t("orderTracking.confirmation")}
                </p>
              </div>
            </div>

            <div className="space-y-4 mb-8">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-doodle-accent" />
                <span className="font-doodle text-doodle-text">
                  {t("orderTracking.orderNumber")}: <strong>{order.salesOrderNumber}</strong>
                </span>
              </div>
              {receiptRequestSent && (
                <div className="flex items-center gap-2">
                  <Mail className="w-5 h-5 text-doodle-accent" />
                  <span className="font-doodle text-doodle-text/70 text-sm">
                    {t("orderTracking.receiptSent")}
                  </span>
                </div>
              )}
            </div>

            <div className="border border-doodle-border rounded-lg p-4 mb-8">
              <h2 className="font-doodle text-lg text-doodle-text mb-3">
                {t("orderTracking.shippingDetails")}
              </h2>
              <div className="font-doodle text-doodle-text/80 space-y-1">
                <p>
                  {order.shipping.firstName} {order.shipping.lastName}
                </p>
                <p>{order.shipping.address}</p>
                {order.shipping.address2 && <p>{order.shipping.address2}</p>}
                <p>
                  {order.shipping.city}, {order.shipping.state} {order.shipping.zipCode}
                </p>
                <p>{order.shipping.country}</p>
              </div>
            </div>

            <div className="space-y-2 mb-8">
              <h2 className="font-doodle text-lg text-doodle-text">
                {t("orderTracking.orderSummary")}
              </h2>
              <div className="flex justify-between font-doodle text-doodle-text/80">
                <span>{t("orderTracking.subtotal")}</span>
                <span>
                  {CURRENCY_SYMBOLS[order.currencyCode] ?? order.currencyCode}{" "}
                  {(order.subtotal * order.exchangeRate).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between font-doodle text-doodle-text/80">
                <span>{t("orderTracking.shipping")}</span>
                <span>
                  {CURRENCY_SYMBOLS[order.currencyCode] ?? order.currencyCode}{" "}
                  {(order.shippingCost * order.exchangeRate).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between font-doodle text-doodle-text/80">
                <span>{t("orderTracking.tax")}</span>
                <span>
                  {CURRENCY_SYMBOLS[order.currencyCode] ?? order.currencyCode}{" "}
                  {(order.tax * order.exchangeRate).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between font-doodle text-lg text-doodle-text pt-2 border-t border-doodle-border">
                <span>{t("orderTracking.total")}</span>
                <span>
                  {CURRENCY_SYMBOLS[order.currencyCode] ?? order.currencyCode}{" "}
                  {(order.total * order.exchangeRate).toFixed(2)}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Link
                to="/"
                className="font-doodle text-center py-3 px-4 rounded-lg bg-doodle-accent text-doodle-bg hover:opacity-90 transition-opacity"
              >
                {t("orderTracking.continueShopping")}
              </Link>
              <Link
                to="/orders"
                className="font-doodle text-center py-3 px-4 rounded-lg border border-doodle-border text-doodle-text hover:bg-doodle-bg/5 transition-colors"
              >
                {t("orderTracking.viewOrders")}
              </Link>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

export default OrderConfirmationPage;
