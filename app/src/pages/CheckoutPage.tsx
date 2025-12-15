import React, { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CreditCard,
  Truck,
  Check,
  Package,
  MapPin,
  Plus,
  Star,
  Trash2,
  Tag,
  X,
} from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useCart } from "@/context/CartContext";
import { useAuth } from "@/context/AuthContext";
import { useAddresses, Address } from "@/hooks/useAddresses";
import {
  usePaymentMethods,
  SavedPaymentMethod,
} from "@/hooks/usePaymentMethods";
import { AddressCard } from "@/components/AddressCard";
import { AddressForm } from "@/components/AddressForm";
import { toast } from "@/hooks/use-toast";
import { z } from "zod";
import { getSalePrice } from "@/types/product";
import { useProfile } from "@/hooks/useProfile";
import { formatPhoneNumber, parsePhoneNumber } from "@/lib/phoneFormatter";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";

const shippingSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9\-()\s+]*$/, "Invalid phone number format")
    .max(25, "Phone number must be less than 25 characters")
    .optional(),
  address: z.string().min(5, "Address is required"),
  city: z.string().min(2, "City is required"),
  state: z.string().min(2, "State is required"),
  zipCode: z.string().min(5, "ZIP code is required"),
  country: z.string().min(2, "Country is required"),
});

type ShippingData = z.infer<typeof shippingSchema>;

// Mock discount codes
const DISCOUNT_CODES: Record<
  string,
  { type: "percent" | "freeshipping"; value?: number; description: string }
> = {
  SAVE10: { type: "percent", value: 10, description: "10% off your order" },
  SAVE20: { type: "percent", value: 20, description: "20% off your order" },
  FREESHIP: { type: "freeshipping", description: "Free shipping" },
  ADVENTURE25: {
    type: "percent",
    value: 25,
    description: "25% off your order",
  },
};

// Currency code to symbol mapping - complete list from database
const CURRENCY_SYMBOLS: Record<string, string> = {
  AED: "د.إ", // Emirati Dirham
  AFA: "؋", // Afghani (obsolete)
  ALL: "L", // Albanian Lek
  AMD: "֏", // Armenian Dram
  ANG: "ƒ", // Netherlands Antillean Guilder
  AOA: "Kz", // Angolan Kwanza
  ARS: "$", // Argentine Peso
  ATS: "öS", // Austrian Shilling (obsolete)
  AUD: "A$", // Australian Dollar
  AWG: "ƒ", // Aruban Guilder
  AZM: "₼", // Azerbaijani Manat (obsolete)
  BBD: "$", // Barbados Dollar
  BDT: "৳", // Bangladeshi Taka
  BEF: "₣", // Belgian Franc (obsolete)
  BGN: "лв", // Bulgarian Lev
  BHD: ".د.ب", // Bahraini Dinar
  BND: "$", // Brunei Dollar
  BOB: "Bs.", // Bolivian Boliviano
  BRL: "R$", // Brazilian Real
  BSD: "$", // Bahamian Dollar
  BTN: "Nu.", // Bhutanese Ngultrum
  CAD: "CA$", // Canadian Dollar
  CHF: "CHF", // Swiss Franc
  CLP: "$", // Chilean Peso
  CNY: "¥", // Chinese Yuan Renminbi
  COP: "$", // Colombian Peso
  CRC: "₡", // Costa Rican Colon
  CYP: "£", // Cyprus Pound (obsolete)
  CZK: "Kč", // Czech Koruna
  DEM: "DM", // Deutsche Mark (obsolete)
  DKK: "kr", // Danish Krone
  DOP: "$", // Dominican Peso
  DZD: "د.ج", // Algerian Dinar
  EEK: "kr", // Estonian Kroon (obsolete)
  EGP: "£", // Egyptian Pound
  ESP: "₧", // Spanish Peseta (obsolete)
  EUR: "€", // Euro
  FIM: "mk", // Finnish Markka (obsolete)
  FJD: "$", // Fiji Dollar
  FRF: "₣", // French Franc (obsolete)
  GBP: "£", // British Pound
  GHC: "₵", // Ghanaian Cedi (obsolete)
  GRD: "₯", // Greek Drachma (obsolete)
  GTQ: "Q", // Guatemalan Quetzal
  HKD: "HK$", // Hong Kong Dollar
  HRK: "kn", // Croatian Kuna
  HUF: "Ft", // Hungarian Forint
  IDR: "Rp", // Indonesian Rupiah
  IEP: "£", // Irish Pound (obsolete)
  ILS: "₪", // Israeli New Shekel
  INR: "₹", // Indian Rupee
  ISK: "kr", // Icelandic Krona
  ITL: "₤", // Italian Lira (obsolete)
  JMD: "$", // Jamaican Dollar
  JOD: "د.ا", // Jordanian Dinar
  JPY: "¥", // Japanese Yen
  KES: "KSh", // Kenyan Shilling
  KRW: "₩", // South Korean Won
  KWD: "د.ك", // Kuwaiti Dinar
  LBP: "ل.ل", // Lebanese Pound
  LKR: "Rs", // Sri Lankan Rupee
  LTL: "Lt", // Lithuanian Litas (obsolete)
  LVL: "Ls", // Latvian Lats (obsolete)
  MAD: "د.م.", // Moroccan Dirham
  MTL: "₤", // Maltese Lira (obsolete)
  MUR: "₨", // Mauritian Rupee
  MVR: "Rf", // Maldivian Rufiyaa
  MXN: "$", // Mexican Peso
  MYR: "RM", // Malaysian Ringgit
  NAD: "$", // Namibian Dollar
  NGN: "₦", // Nigerian Naira
  NLG: "ƒ", // Netherlands Guilder (obsolete)
  NOK: "kr", // Norwegian Krone
  NPR: "₨", // Nepalese Rupee
  NZD: "NZ$", // New Zealand Dollar
  OMR: "ر.ع.", // Omani Rial
  PAB: "B/.", // Panamanian Balboa
  PEN: "S/", // Peruvian Nuevo Sol
  PHP: "₱", // Philippine Peso
  PKR: "₨", // Pakistani Rupee
  PLN: "zł", // Polish Zloty
  PLZ: "zł", // Polish Zloty (old)
  PTE: "Esc", // Portuguese Escudo (obsolete)
  PYG: "₲", // Paraguayan Guarani
  ROL: "lei", // Romanian Leu (old)
  RUB: "₽", // Russian Ruble
  RUR: "₽", // Russian Ruble (old)
  SAR: "ر.س", // Saudi Riyal
  SEK: "kr", // Swedish Krona
  SGD: "S$", // Singapore Dollar
  SIT: "SIT", // Slovenian Tolar (obsolete)
  SKK: "Sk", // Slovak Koruna (obsolete)
  SVC: "$", // El Salvador Colon
  THB: "฿", // Thai Baht
  TND: "د.ت", // Tunisian Dinar
  TRL: "₤", // Turkish Lira (old)
  TTD: "$", // Trinidad and Tobago Dollar
  TWD: "NT$", // New Taiwan Dollar
  USD: "$", // US Dollar
  UYU: "$", // Uruguayan Peso
};

const GET_SALES_TAX_RATE = gql`
  query GetSalesTaxRate($stateProvinceId: Int!) {
    salesTaxRates(filter: { StateProvinceID: { eq: $stateProvinceId } }) {
      items {
        TaxRate
        Name
      }
    }
  }
`;

const GET_STATE_PROVINCE = gql`
  query GetStateProvince($stateProvinceId: Int!) {
    stateProvinces(filter: { StateProvinceID: { eq: $stateProvinceId } }) {
      items {
        StateProvinceID
        CountryRegionCode
      }
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
        EndOfDayRate
      }
    }
  }
`;

const GET_SHIP_METHODS = gql`
  query GetShipMethods {
    shipMethods {
      items {
        ShipMethodID
        Name
        ShipBase
        ShipRate
      }
    }
  }
`;

interface ShipMethod {
  ShipMethodID: number;
  Name: string;
  ShipBase: number;
  ShipRate: number;
}

const isValidCardNumber = (number: string): boolean => {
  const digits = number.replace(/\s/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
};

const CheckoutPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    items,
    getTotalPrice,
    getOriginalPrice,
    getTotalDiscount,
    clearCart,
  } = useCart();
  const { user } = useAuth();
  const { data: profileData } = useProfile(user?.businessEntityId || 0);
  const { addresses, getDefaultAddress, addAddress } = useAddresses();
  const { paymentMethods, getDefaultPaymentMethod, addPaymentMethod } =
    usePaymentMethods();
  const [step, setStep] = useState(1);
  const [countryCode, setCountryCode] = useState("+1");
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(
    null
  );
  const [useNewAddress, setUseNewAddress] = useState(false);
  const [saveNewAddress, setSaveNewAddress] = useState(false);
  const [addressLabel, setAddressLabel] = useState("");
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(
    null
  );
  const [useNewPayment, setUseNewPayment] = useState(false);
  const [saveNewPayment, setSaveNewPayment] = useState(false);
  const [paymentLabel, setPaymentLabel] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState("");
  const [taxRate, setTaxRate] = useState(0.08); // Default 8%
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [exchangeRate, setExchangeRate] = useState(1); // Default 1 for USD
  const [shipMethods, setShipMethods] = useState<ShipMethod[]>([]);
  const [selectedShipMethodId, setSelectedShipMethodId] = useState<
    number | null
  >(null);

  const [title, setTitle] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [suffix, setSuffix] = useState("");

  const [shippingData, setShippingData] = useState<ShippingData>({
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    email: user?.email || "",
    phone: "",
    address: "",
    city: "",
    state: "",
    zipCode: "",
    country: "United States",
  });

  // Initialize profile data (phone, title, middleName, suffix)
  useEffect(() => {
    if (profileData) {
      // Set title, middleName, suffix
      if (profileData.Title) setTitle(profileData.Title);
      if (profileData.MiddleName) setMiddleName(profileData.MiddleName);
      if (profileData.Suffix) setSuffix(profileData.Suffix);

      // Set phone number
      if (profileData.PhoneNumber) {
        let parsedCountryCode = "+1";
        let phoneNumber = profileData.PhoneNumber;

        if (phoneNumber.startsWith("+")) {
          const match = phoneNumber.match(/^(\+\d+)\s*(.*)$/);
          if (match) {
            parsedCountryCode = match[1];
            phoneNumber = match[2];
          }
        }

        const formattedPhone = formatPhoneNumber(
          phoneNumber,
          parsedCountryCode
        );
        setCountryCode(parsedCountryCode);
        setShippingData((prev) => ({ ...prev, phone: formattedPhone }));
      }
    }
  }, [profileData]);

  const [paymentMethod, setPaymentMethod] = useState<"card" | "paypal">("card");
  const [cardData, setCardData] = useState({
    number: "",
    name: "",
    expiry: "",
    cvv: "",
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const applyAddressToShipping = useCallback(
    (address: Address) => {
      setShippingData({
        firstName: user?.firstName || "",
        lastName: user?.lastName || "",
        email: user?.email || "",
        phone: "",
        address: address.addressLine2
          ? `${address.addressLine1}, ${address.addressLine2}`
          : address.addressLine1,
        city: address.city,
        state: address.stateProvinceId.toString(),
        zipCode: address.postalCode,
        country: "United States",
      });
    },
    [user]
  );

  // Initialize with default address if available
  useEffect(() => {
    const defaultAddress = getDefaultAddress();
    if (defaultAddress && !selectedAddressId && !useNewAddress) {
      setSelectedAddressId(defaultAddress.id);
      applyAddressToShipping(defaultAddress);
    }
  }, [
    addresses,
    getDefaultAddress,
    selectedAddressId,
    useNewAddress,
    applyAddressToShipping,
  ]);

  // Initialize with default payment method if available
  useEffect(() => {
    const defaultPayment = getDefaultPaymentMethod();
    if (defaultPayment && !selectedPaymentId && !useNewPayment) {
      setSelectedPaymentId(defaultPayment.id);
      setPaymentMethod(defaultPayment.type);
    }
  }, [
    paymentMethods,
    getDefaultPaymentMethod,
    selectedPaymentId,
    useNewPayment,
  ]);

  // Fetch tax rate and currency when address changes
  useEffect(() => {
    const fetchTaxRateAndCurrency = async () => {
      const stateId = parseInt(shippingData.state);
      if (!stateId || isNaN(stateId)) {
        setTaxRate(0.08); // Default 8%
        setCurrencyCode("USD");
        return;
      }

      try {
        // Get tax rate for the state
        const taxResponse = await graphqlClient.request<{
          salesTaxRates: { items: Array<{ TaxRate: number; Name: string }> };
        }>(GET_SALES_TAX_RATE, { stateProvinceId: stateId });

        if (taxResponse.salesTaxRates.items.length > 0) {
          // TaxRate is stored as a whole number (e.g., 14 for 14%), convert to decimal
          setTaxRate(taxResponse.salesTaxRates.items[0].TaxRate / 100);
        } else {
          setTaxRate(0.08); // Default 8% if no tax rate found
        }

        // Get state province to find country code
        const stateResponse = await graphqlClient.request<{
          stateProvinces: { items: Array<{ CountryRegionCode: string }> };
        }>(GET_STATE_PROVINCE, { stateProvinceId: stateId });

        if (stateResponse.stateProvinces.items.length > 0) {
          const countryCode =
            stateResponse.stateProvinces.items[0].CountryRegionCode;

          // Get currency for the country
          const currencyResponse = await graphqlClient.request<{
            countryRegionCurrencies: { items: Array<{ CurrencyCode: string }> };
          }>(GET_COUNTRY_CURRENCY, { countryCode });

          if (currencyResponse.countryRegionCurrencies.items.length > 0) {
            const newCurrencyCode =
              currencyResponse.countryRegionCurrencies.items[0].CurrencyCode;
            setCurrencyCode(newCurrencyCode);

            // Get exchange rate for the currency (if not USD)
            if (newCurrencyCode !== "USD") {
              const rateResponse = await graphqlClient.request<{
                currencyRates: {
                  items: Array<{ AverageRate: number; EndOfDayRate: number }>;
                };
              }>(GET_CURRENCY_RATE, { toCurrencyCode: newCurrencyCode });

              if (rateResponse.currencyRates.items.length > 0) {
                // Use AverageRate for conversion
                setExchangeRate(
                  rateResponse.currencyRates.items[0].AverageRate
                );
              } else {
                setExchangeRate(1); // Default to 1 if no rate found
              }
            } else {
              setExchangeRate(1); // USD = 1:1
            }
          } else {
            setCurrencyCode("USD"); // Default to USD
            setExchangeRate(1);
          }
        }
      } catch (error) {
        console.error("Error fetching tax rate or currency:", error);
        setTaxRate(0.08); // Default 8%
        setCurrencyCode("USD");
        setExchangeRate(1);
      }
    };

    fetchTaxRateAndCurrency();
  }, [shippingData.state]);

  // Fetch shipping methods
  useEffect(() => {
    const fetchShipMethods = async () => {
      try {
        const response = await graphqlClient.request<{
          shipMethods: { items: ShipMethod[] };
        }>(GET_SHIP_METHODS);
        setShipMethods(response.shipMethods.items);
        // Select the first (cheapest) method by default
        if (response.shipMethods.items.length > 0) {
          setSelectedShipMethodId(response.shipMethods.items[0].ShipMethodID);
        }
      } catch (error) {
        console.error("Error fetching shipping methods:", error);
      }
    };
    fetchShipMethods();
  }, []);

  const handleSelectAddress = (address: Address) => {
    setSelectedAddressId(address.id);
    setUseNewAddress(false);
    applyAddressToShipping(address);
  };

  const totalPrice = getTotalPrice();
  const originalPrice = getOriginalPrice();
  const totalDiscount = getTotalDiscount();

  // Apply exchange rate to convert from USD to selected currency
  const totalPriceConverted = totalPrice * exchangeRate;
  const originalPriceConverted = originalPrice * exchangeRate;
  const totalDiscountConverted = totalDiscount * exchangeRate;

  // Calculate discount from code
  const appliedDiscount = appliedCode && DISCOUNT_CODES[appliedCode];
  const codeDiscountAmount =
    appliedDiscount?.type === "percent"
      ? totalPriceConverted * (appliedDiscount.value! / 100)
      : 0;
  const priceAfterCodeDiscount = totalPriceConverted - codeDiscountAmount;
  const freeShippingFromCode = appliedDiscount?.type === "freeshipping";

  // Get selected shipping method's price
  const selectedShipMethod = shipMethods.find(
    (method) => method.ShipMethodID === selectedShipMethodId
  );
  const baseShipping =
    priceAfterCodeDiscount > 50 * exchangeRate
      ? 0
      : (selectedShipMethod?.ShipBase || 9.99) * exchangeRate;
  const shipping = freeShippingFromCode ? 0 : baseShipping;
  const tax = priceAfterCodeDiscount * taxRate;
  const grandTotal = priceAfterCodeDiscount + shipping + tax;

  const handleApplyCode = () => {
    const code = discountCode.toUpperCase().trim();
    if (!code) {
      setCodeError("Please enter a code");
      return;
    }
    if (DISCOUNT_CODES[code]) {
      setAppliedCode(code);
      setDiscountCode("");
      setCodeError("");
    } else {
      setCodeError("Invalid discount code");
    }
  };

  const handleRemoveCode = () => {
    setAppliedCode(null);
    setCodeError("");
  };

  if (items.length === 0) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <div className="doodle-card p-12">
              <Package className="w-20 h-20 mx-auto mb-6 text-doodle-text/40" />
              <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
                No Items to Checkout
              </h1>
              <p className="font-doodle text-doodle-text/70 mb-8">
                Add some gear to your cart first!
              </p>
              <Link
                to="/"
                className="doodle-button doodle-button-primary inline-flex items-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                Start Shopping
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const handleShippingChange = (field: keyof ShippingData, value: string) => {
    setShippingData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  const validateShipping = () => {
    try {
      shippingSchema.parse(shippingData);
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) {
            newErrors[err.path[0] as string] = err.message;
          }
        });
        setErrors(newErrors);
      }
      return false;
    }
  };

  const handleContinueToPayment = () => {
    // If using saved address, just check that one is selected
    if (!useNewAddress && addresses.length > 0) {
      if (!selectedAddressId) {
        toast({
          title: "Address Required",
          description: "Please select a shipping address.",
          variant: "destructive",
        });
        return;
      }
      setStep(2);
      return;
    }

    // If using new address, AddressForm will handle validation and call its onSave
    // which will then move to step 2
    // So this button shouldn't be visible when entering new address
    toast({
      title: "Complete Address",
      description: "Please fill out the address form.",
      variant: "destructive",
    });
  };

  const handlePlaceOrder = async () => {
    setIsProcessing(true);

    // Save address if user opted in and entering a new address (either explicitly or when no saved addresses exist)
    const isEnteringNewAddress = useNewAddress || addresses.length === 0;
    if (isEnteringNewAddress && saveNewAddress && user) {
      await addAddress({
        addressLine1: shippingData.address.split(",")[0],
        addressLine2: shippingData.address.split(",")[1]?.trim() || "",
        city: shippingData.city,
        stateProvinceId: parseInt(shippingData.state),
        postalCode: shippingData.zipCode,
        addressType: addressLabel || "Shipping Address",
        isDefault: addresses.length === 0,
      });
      toast({
        title: "Address Saved",
        description: "Your address has been saved for future orders.",
      });
    }

    // Save payment method if user opted in and entering new payment
    const isEnteringNewPayment = useNewPayment || paymentMethods.length === 0;
    if (
      isEnteringNewPayment &&
      saveNewPayment &&
      user &&
      paymentMethod === "card"
    ) {
      addPaymentMethod({
        type: "card",
        label: paymentLabel || "Credit Card",
        cardNumber: cardData.number,
        cardExpiry: cardData.expiry,
        cardholderName: cardData.name,
        isDefault: paymentMethods.length === 0,
      });
      toast({
        title: "Payment Method Saved",
        description: "Your card has been saved for future orders.",
      });
    }

    // Simulate payment processing
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Generate mock order ID
    const orderId = `AW-${Date.now().toString(36).toUpperCase()}`;

    // Store order in localStorage for confirmation page
    const order = {
      id: orderId,
      items: items,
      shipping: shippingData,
      paymentMethod,
      subtotal: totalPrice,
      shippingCost: shipping,
      tax,
      total: grandTotal,
      date: new Date().toISOString(),
    };

    localStorage.setItem("lastOrder", JSON.stringify(order));

    // Also save to order history
    const existingOrders = JSON.parse(
      localStorage.getItem("orderHistory") || "[]"
    );
    localStorage.setItem(
      "orderHistory",
      JSON.stringify([order, ...existingOrders])
    );

    clearCart();

    toast({
      title: "Order Placed!",
      description: `Your order ${orderId} has been confirmed`,
    });

    navigate("/order-confirmation");
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link
            to="/cart"
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Cart
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-8">
            Checkout
          </h1>

          {/* Progress Steps */}
          <div className="flex items-center justify-center gap-4 mb-10">
            <div
              className={`flex items-center gap-2 ${
                step >= 1 ? "text-doodle-accent" : "text-doodle-text/40"
              }`}
            >
              <div
                className={`w-8 h-8 rounded-full border-2 flex items-center justify-center font-doodle font-bold ${
                  step >= 1
                    ? "border-doodle-accent bg-doodle-accent text-white"
                    : "border-doodle-text/40"
                }`}
              >
                {step > 1 ? <Check className="w-4 h-4" /> : "1"}
              </div>
              <span className="font-doodle font-bold hidden sm:inline">
                Shipping
              </span>
            </div>
            <div
              className={`w-12 h-0.5 ${
                step >= 2 ? "bg-doodle-accent" : "bg-doodle-text/20"
              }`}
            />
            <div
              className={`flex items-center gap-2 ${
                step >= 2 ? "text-doodle-accent" : "text-doodle-text/40"
              }`}
            >
              <div
                className={`w-8 h-8 rounded-full border-2 flex items-center justify-center font-doodle font-bold ${
                  step >= 2
                    ? "border-doodle-accent bg-doodle-accent text-white"
                    : "border-doodle-text/40"
                }`}
              >
                {step > 2 ? <Check className="w-4 h-4" /> : "2"}
              </div>
              <span className="font-doodle font-bold hidden sm:inline">
                Payment
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Main Form Area */}
            <div className="lg:col-span-2">
              {/* Step 1: Shipping */}
              {step === 1 && (
                <div className="doodle-card p-6 md:p-8">
                  <div className="flex items-center gap-3 mb-6">
                    <Truck className="w-6 h-6 text-doodle-accent" />
                    <h2 className="font-doodle text-2xl font-bold text-doodle-text">
                      Shipping Address
                    </h2>
                  </div>

                  {/* Saved Addresses Selection */}
                  {addresses.length > 0 && (
                    <div className="mb-6">
                      <p className="font-doodle text-sm font-bold text-doodle-text mb-3">
                        Select a saved address:
                      </p>
                      <div className="grid grid-cols-1 gap-3 mb-4">
                        {addresses.map((address) => (
                          <AddressCard
                            key={address.id}
                            address={address}
                            selectable
                            selected={
                              selectedAddressId === address.id && !useNewAddress
                            }
                            onSelect={handleSelectAddress}
                            onEdit={() => {}}
                            onDelete={() => {}}
                            onSetDefault={() => {}}
                          />
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          setUseNewAddress(true);
                          setSelectedAddressId(null);
                          setShippingData({
                            firstName: user?.firstName || "",
                            lastName: user?.lastName || "",
                            email: user?.email || "",
                            phone: "",
                            address: "",
                            city: "",
                            state: "",
                            zipCode: "",
                            country: "United States",
                          });
                        }}
                        className={`w-full p-4 border-2 transition-all flex items-center justify-center gap-2 ${
                          useNewAddress
                            ? "border-doodle-accent bg-doodle-accent/5"
                            : "border-dashed border-doodle-text/20 hover:border-doodle-accent"
                        }`}
                      >
                        <Plus className="w-4 h-4" />
                        <span className="font-doodle font-bold">
                          Use a different address
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Address Form - show if no saved addresses or using new address */}
                  {(addresses.length === 0 || useNewAddress) && (
                    <>
                      {addresses.length > 0 && (
                        <p className="font-doodle text-sm font-bold text-doodle-text mb-3">
                          Enter new address:
                        </p>
                      )}
                      <AddressForm
                        onSave={(addressData) => {
                          // Convert AddressForm data to checkout shipping data
                          setShippingData({
                            firstName: user?.firstName || "",
                            lastName: user?.lastName || "",
                            email: user?.email || "",
                            phone: shippingData.phone,
                            address: addressData.addressLine1,
                            city: addressData.city,
                            state: String(addressData.stateProvinceId), // Will need to map this properly
                            zipCode: addressData.postalCode,
                            country: addressData.countryRegionCode || "US",
                          });

                          // Save address if user wants to
                          if (saveNewAddress && user) {
                            addAddress({
                              addressType: addressData.addressType,
                              addressLine1: addressData.addressLine1,
                              addressLine2: addressData.addressLine2,
                              city: addressData.city,
                              stateProvinceId: addressData.stateProvinceId,
                              postalCode: addressData.postalCode,
                              isDefault: addressData.isDefault,
                            });
                          }

                          // Move to next step
                          setStep(2);
                        }}
                        onCancel={() => {
                          setUseNewAddress(false);
                        }}
                      />

                      {/* Save Address Option */}
                      {user && (
                        <div className="mt-4">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={saveNewAddress}
                              onChange={(e) =>
                                setSaveNewAddress(e.target.checked)
                              }
                              className="w-4 h-4"
                            />
                            <span className="font-doodle text-sm text-doodle-text">
                              Save this address for future orders
                            </span>
                          </label>
                        </div>
                      )}
                    </>
                  )}

                  {/* Only show Continue button when not filling out new address form */}
                  {!useNewAddress && addresses.length > 0 && (
                    <button
                      onClick={handleContinueToPayment}
                      className="doodle-button doodle-button-primary w-full mt-8 py-3 text-lg"
                    >
                      Continue to Payment
                    </button>
                  )}
                </div>
              )}

              {/* Step 2: Payment */}
              {step === 2 && (
                <div className="doodle-card p-6 md:p-8">
                  <div className="flex items-center gap-3 mb-6">
                    <CreditCard className="w-6 h-6 text-doodle-accent" />
                    <h2 className="font-doodle text-2xl font-bold text-doodle-text">
                      Payment Method
                    </h2>
                  </div>

                  {/* Saved Payment Methods */}
                  {paymentMethods.length > 0 && !useNewPayment && (
                    <div className="mb-6">
                      <p className="font-doodle text-sm font-bold text-doodle-text mb-3">
                        Select a saved payment method:
                      </p>
                      <div className="space-y-3 mb-4">
                        {paymentMethods.map((pm) => (
                          <div
                            key={pm.id}
                            onClick={() => {
                              setSelectedPaymentId(pm.id);
                              setPaymentMethod(pm.type);
                              setUseNewPayment(false);
                            }}
                            className={`flex items-center gap-4 p-4 border-2 cursor-pointer transition-colors ${
                              selectedPaymentId === pm.id && !useNewPayment
                                ? "border-doodle-accent bg-doodle-accent/5"
                                : "border-dashed border-doodle-text/20 hover:border-doodle-accent"
                            }`}
                          >
                            <div
                              className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                                selectedPaymentId === pm.id && !useNewPayment
                                  ? "border-doodle-accent"
                                  : "border-doodle-text/40"
                              }`}
                            >
                              {selectedPaymentId === pm.id &&
                                !useNewPayment && (
                                  <div className="w-3 h-3 rounded-full bg-doodle-accent" />
                                )}
                            </div>
                            <CreditCard className="w-6 h-6 text-doodle-text/70" />
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-doodle font-bold text-doodle-text">
                                  {pm.cardBrand} •••• {pm.cardLast4}
                                </span>
                                {pm.isDefault && (
                                  <span className="font-doodle text-xs bg-doodle-accent text-white px-2 py-0.5 rounded">
                                    Default
                                  </span>
                                )}
                              </div>
                              <p className="font-doodle text-sm text-doodle-text/70">
                                {pm.cardholderName} • Expires {pm.cardExpiry}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          setUseNewPayment(true);
                          setSelectedPaymentId(null);
                        }}
                        className={`w-full p-4 border-2 transition-all flex items-center justify-center gap-2 ${
                          useNewPayment
                            ? "border-doodle-accent bg-doodle-accent/5"
                            : "border-dashed border-doodle-text/20 hover:border-doodle-accent"
                        }`}
                      >
                        <Plus className="w-4 h-4" />
                        <span className="font-doodle font-bold">
                          Use a different payment method
                        </span>
                      </button>
                    </div>
                  )}

                  {/* New Payment Method Form */}
                  {(paymentMethods.length === 0 || useNewPayment) && (
                    <>
                      {/* Payment Method Selection */}
                      <div className="space-y-3 mb-6">
                        <label
                          className={`flex items-center gap-4 p-4 border-2 cursor-pointer transition-colors ${
                            paymentMethod === "card"
                              ? "border-doodle-accent bg-doodle-accent/5"
                              : "border-dashed border-doodle-text/30 hover:border-doodle-text/50"
                          }`}
                        >
                          <input
                            type="radio"
                            name="payment"
                            checked={paymentMethod === "card"}
                            onChange={() => setPaymentMethod("card")}
                            className="sr-only"
                          />
                          <div
                            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                              paymentMethod === "card"
                                ? "border-doodle-accent"
                                : "border-doodle-text/40"
                            }`}
                          >
                            {paymentMethod === "card" && (
                              <div className="w-3 h-3 rounded-full bg-doodle-accent" />
                            )}
                          </div>
                          <CreditCard className="w-6 h-6" />
                          <span className="font-doodle font-bold">
                            Credit / Debit Card
                          </span>
                        </label>

                        <label
                          className={`flex items-center gap-4 p-4 border-2 cursor-pointer transition-colors ${
                            paymentMethod === "paypal"
                              ? "border-doodle-accent bg-doodle-accent/5"
                              : "border-dashed border-doodle-text/30 hover:border-doodle-text/50"
                          }`}
                        >
                          <input
                            type="radio"
                            name="payment"
                            checked={paymentMethod === "paypal"}
                            onChange={() => setPaymentMethod("paypal")}
                            className="sr-only"
                          />
                          <div
                            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                              paymentMethod === "paypal"
                                ? "border-doodle-accent"
                                : "border-doodle-text/40"
                            }`}
                          >
                            {paymentMethod === "paypal" && (
                              <div className="w-3 h-3 rounded-full bg-doodle-accent" />
                            )}
                          </div>
                          <span className="text-xl">💳</span>
                          <span className="font-doodle font-bold">PayPal</span>
                        </label>
                      </div>

                      {/* Card Details */}
                      {paymentMethod === "card" && (
                        <div className="space-y-4 mb-6">
                          <div>
                            <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                              Card Number
                            </label>
                            <div className="relative">
                              <input
                                type="text"
                                value={cardData.number}
                                onChange={(e) => {
                                  const value = e.target.value
                                    .replace(/\s/g, "")
                                    .replace(/\D/g, "");
                                  const formatted =
                                    value.match(/.{1,4}/g)?.join(" ") || "";
                                  setCardData((prev) => ({
                                    ...prev,
                                    number: formatted,
                                  }));
                                }}
                                className="doodle-input w-full pr-16"
                                placeholder="4242 4242 4242 4242"
                                maxLength={19}
                              />
                              {(() => {
                                const num = cardData.number.replace(/\s/g, "");
                                let cardType = "";
                                let cardColor = "";
                                if (/^4/.test(num)) {
                                  cardType = "VISA";
                                  cardColor = "bg-blue-600";
                                } else if (
                                  /^5[1-5]/.test(num) ||
                                  /^2[2-7]/.test(num)
                                ) {
                                  cardType = "MC";
                                  cardColor = "bg-orange-500";
                                } else if (/^3[47]/.test(num)) {
                                  cardType = "AMEX";
                                  cardColor = "bg-green-600";
                                } else if (/^6(?:011|5)/.test(num)) {
                                  cardType = "DISC";
                                  cardColor = "bg-amber-500";
                                }
                                return cardType ? (
                                  <span
                                    className={`absolute right-3 top-1/2 -translate-y-1/2 ${cardColor} text-white text-xs font-bold px-2 py-1 rounded`}
                                  >
                                    {cardType}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                            {(() => {
                              const digits = cardData.number.replace(/\s/g, "");
                              if (
                                digits.length >= 13 &&
                                !isValidCardNumber(cardData.number)
                              ) {
                                return (
                                  <p className="font-doodle text-xs text-doodle-accent mt-1">
                                    Invalid card number
                                  </p>
                                );
                              }
                              return null;
                            })()}
                          </div>
                          <div>
                            <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                              Cardholder Name
                            </label>
                            <input
                              type="text"
                              value={cardData.name}
                              onChange={(e) =>
                                setCardData((prev) => ({
                                  ...prev,
                                  name: e.target.value,
                                }))
                              }
                              className="doodle-input w-full"
                              placeholder="John Doe"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                                Expiry Date
                              </label>
                              <input
                                type="text"
                                value={cardData.expiry}
                                onChange={(e) => {
                                  let value = e.target.value.replace(/\D/g, "");
                                  // Validate month (01-12)
                                  if (value.length >= 2) {
                                    const month = parseInt(
                                      value.slice(0, 2),
                                      10
                                    );
                                    if (month > 12)
                                      value = "12" + value.slice(2);
                                    if (month === 0)
                                      value = "01" + value.slice(2);
                                  }
                                  if (value.length >= 2) {
                                    value =
                                      value.slice(0, 2) +
                                      "/" +
                                      value.slice(2, 4);
                                  }
                                  setCardData((prev) => ({
                                    ...prev,
                                    expiry: value,
                                  }));
                                }}
                                className="doodle-input w-full"
                                placeholder="MM/YY"
                                maxLength={5}
                              />
                              {cardData.expiry.length === 5 &&
                                (() => {
                                  const [month, year] = cardData.expiry
                                    .split("/")
                                    .map(Number);
                                  const now = new Date();
                                  const currentYear = now.getFullYear() % 100;
                                  const currentMonth = now.getMonth() + 1;
                                  const isExpired =
                                    year < currentYear ||
                                    (year === currentYear &&
                                      month < currentMonth);
                                  return isExpired ? (
                                    <p className="font-doodle text-xs text-doodle-accent mt-1">
                                      Card has expired
                                    </p>
                                  ) : null;
                                })()}
                            </div>
                            <div>
                              <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                                CVV
                              </label>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={cardData.cvv}
                                onChange={(e) => {
                                  const value = e.target.value
                                    .replace(/\D/g, "")
                                    .slice(0, 4);
                                  setCardData((prev) => ({
                                    ...prev,
                                    cvv: value,
                                  }));
                                }}
                                className="doodle-input w-full"
                                placeholder="123"
                                maxLength={4}
                              />
                            </div>
                          </div>

                          {/* Save Payment Option */}
                          {user && (
                            <div className="mt-2">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={saveNewPayment}
                                  onChange={(e) =>
                                    setSaveNewPayment(e.target.checked)
                                  }
                                  className="w-4 h-4"
                                />
                                <span className="font-doodle text-sm text-doodle-text">
                                  Save this card for future orders
                                </span>
                              </label>

                              {saveNewPayment && (
                                <div className="mt-3">
                                  <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                                    Card Label (optional)
                                  </label>
                                  <input
                                    type="text"
                                    value={paymentLabel}
                                    onChange={(e) =>
                                      setPaymentLabel(e.target.value)
                                    }
                                    className="doodle-input w-full md:w-1/2"
                                    placeholder="Personal, Business, etc."
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {paymentMethod === "paypal" && (
                    <div className="p-6 border-2 border-dashed border-doodle-text/30 text-center mb-6">
                      <p className="font-doodle text-doodle-text/70">
                        You will be redirected to PayPal to complete your
                        payment (mock)
                      </p>
                    </div>
                  )}

                  <div className="flex gap-4">
                    <button
                      onClick={() => setStep(1)}
                      className="doodle-button flex-1 py-3"
                    >
                      Back
                    </button>
                    {(() => {
                      const isNewPaymentMethod =
                        useNewPayment || paymentMethods.length === 0;
                      const cardInvalid =
                        isNewPaymentMethod &&
                        paymentMethod === "card" &&
                        !isValidCardNumber(cardData.number);
                      return (
                        <button
                          onClick={handlePlaceOrder}
                          disabled={isProcessing || cardInvalid}
                          className="doodle-button doodle-button-primary flex-1 py-3 text-lg disabled:opacity-50"
                        >
                          {isProcessing
                            ? "Processing..."
                            : `Pay $${grandTotal.toFixed(2)}`}
                        </button>
                      );
                    })()}
                  </div>

                  <p className="font-doodle text-center text-xs text-doodle-text/50 mt-4">
                    🔒 Your payment information is secure (mock checkout)
                  </p>
                </div>
              )}
            </div>

            {/* Order Summary Sidebar */}
            <div className="lg:col-span-1">
              <div className="doodle-card p-6 sticky top-24">
                <h3 className="font-doodle text-xl font-bold text-doodle-text mb-4">
                  Order Summary
                </h3>

                {/* Items */}
                <div className="space-y-3 max-h-48 overflow-y-auto mb-4">
                  {items.map((item) => {
                    const salePrice = getSalePrice(item);
                    const itemPrice = salePrice || item.ListPrice;
                    const itemPriceConverted = itemPrice * exchangeRate;
                    const listPriceConverted = item.ListPrice * exchangeRate;
                    return (
                      <div
                        key={`${item.ProductID}-${item.selectedSize}-${item.selectedColor}`}
                        className="flex gap-3"
                      >
                        <div className="w-12 h-12 flex-shrink-0 bg-doodle-bg border border-dashed border-doodle-text/50 flex items-center justify-center text-lg">
                          🚴
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-doodle text-sm font-bold text-doodle-text line-clamp-1">
                            {item.Name}
                          </p>
                          <div className="flex items-center gap-2">
                            <p className="font-doodle text-xs text-doodle-text/70">
                              Qty: {item.quantity} ×{" "}
                              {CURRENCY_SYMBOLS[currencyCode] || currencyCode}
                              {itemPriceConverted.toFixed(2)}
                            </p>
                            {salePrice && (
                              <span className="font-doodle text-xs text-doodle-green font-bold">
                                Save {Math.round((item.DiscountPct || 0) * 100)}
                                %
                              </span>
                            )}
                          </div>
                          {salePrice && (
                            <p className="font-doodle text-xs text-doodle-text/50 line-through">
                              Was{" "}
                              {CURRENCY_SYMBOLS[currencyCode] || currencyCode}
                              {listPriceConverted.toFixed(2)}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {(step === 1 || appliedCode) && (
                  <hr className="border-dashed border-doodle-text/30 my-4" />
                )}

                {/* Discount Code Input */}
                {(step === 1 || appliedCode) && (
                  <div className="mb-4">
                    <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
                      Discount Code
                    </label>
                    {appliedCode ? (
                      <div className="flex items-center justify-between p-3 bg-doodle-green/10 border-2 border-doodle-green/30">
                        <div className="flex items-center gap-2">
                          <Tag className="w-4 h-4 text-doodle-green" />
                          <span className="font-doodle font-bold text-doodle-green">
                            {appliedCode}
                          </span>
                          <span className="font-doodle text-xs text-doodle-text/70">
                            ({DISCOUNT_CODES[appliedCode]?.description})
                          </span>
                        </div>
                        {step === 1 && (
                          <button
                            onClick={handleRemoveCode}
                            className="p-1 hover:bg-doodle-text/10 rounded transition-colors"
                            aria-label="Remove discount code"
                          >
                            <X className="w-4 h-4 text-doodle-text/70" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={discountCode}
                          onChange={(e) => {
                            setDiscountCode(e.target.value.toUpperCase());
                            setCodeError("");
                          }}
                          className="doodle-input flex-1 uppercase"
                          placeholder="ENTER CODE"
                        />
                        <button
                          onClick={handleApplyCode}
                          className="doodle-button px-4"
                        >
                          Apply
                        </button>
                      </div>
                    )}
                    {codeError && (
                      <p className="font-doodle text-xs text-doodle-accent mt-1">
                        {codeError}
                      </p>
                    )}
                  </div>
                )}

                {(step === 1 || appliedCode) && (
                  <hr className="border-dashed border-doodle-text/30 my-4" />
                )}

                {/* Shipping Method - Step 1 only */}
                {step === 1 && (
                  <div className="mb-4">
                    <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
                      Shipping Method
                    </label>
                    {shipMethods.length > 0 ? (
                      <select
                        value={selectedShipMethodId || ""}
                        onChange={(e) =>
                          setSelectedShipMethodId(Number(e.target.value))
                        }
                        className="doodle-input w-full text-sm"
                      >
                        {shipMethods.map((method) => {
                          const methodPrice =
                            priceAfterCodeDiscount > 50 * exchangeRate
                              ? 0
                              : method.ShipBase * exchangeRate;
                          return (
                            <option
                              key={method.ShipMethodID}
                              value={method.ShipMethodID}
                            >
                              {method.Name} -{" "}
                              {methodPrice === 0
                                ? "FREE"
                                : `${
                                    CURRENCY_SYMBOLS[currencyCode] ||
                                    currencyCode
                                  }${methodPrice.toFixed(2)}`}
                            </option>
                          );
                        })}
                      </select>
                    ) : (
                      <p className="font-doodle text-sm text-doodle-text">
                        Loading shipping methods...
                      </p>
                    )}
                  </div>
                )}

                {step === 1 && (
                  <hr className="border-dashed border-doodle-text/30 my-4" />
                )}

                {/* Totals */}
                <div className="space-y-2 font-doodle text-sm">
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">Subtotal</span>
                    <span>
                      {CURRENCY_SYMBOLS[currencyCode] || currencyCode}
                      {originalPriceConverted.toFixed(2)}
                    </span>
                  </div>
                  {totalDiscountConverted > 0 && (
                    <div className="flex justify-between text-doodle-green">
                      <span className="font-bold">Sale Discounts</span>
                      <span className="font-bold">
                        -{CURRENCY_SYMBOLS[currencyCode] || currencyCode}
                        {totalDiscountConverted.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {appliedDiscount?.type === "percent" &&
                    codeDiscountAmount > 0 && (
                      <div className="flex justify-between text-doodle-green">
                        <span className="font-bold">
                          Code: {appliedCode} (-{appliedDiscount.value}%)
                        </span>
                        <span className="font-bold">
                          -{CURRENCY_SYMBOLS[currencyCode] || currencyCode}
                          {codeDiscountAmount.toFixed(2)}
                        </span>
                      </div>
                    )}
                  {step === 2 && (
                    <div className="flex justify-between">
                      <span className="text-doodle-text/70">Shipping</span>
                      <span>
                        {(() => {
                          const selectedMethod = shipMethods.find(
                            (m) => m.ShipMethodID === selectedShipMethodId
                          );
                          if (!selectedMethod) return "Loading...";

                          const methodPrice =
                            priceAfterCodeDiscount > 50 * exchangeRate
                              ? 0
                              : selectedMethod.ShipBase * exchangeRate;

                          return `${selectedMethod.Name} - ${
                            methodPrice === 0
                              ? "FREE"
                              : `${
                                  CURRENCY_SYMBOLS[currencyCode] || currencyCode
                                }${methodPrice.toFixed(2)}`
                          }`;
                        })()}
                      </span>
                    </div>
                  )}
                </div>

                <hr className="border-dashed border-doodle-text/30 my-4" />

                {/* Final Totals */}
                <div className="space-y-2 font-doodle text-sm">
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">
                      Tax ({(taxRate * 100).toFixed(1)}%)
                    </span>
                    <span>
                      {CURRENCY_SYMBOLS[currencyCode] || currencyCode}
                      {tax.toFixed(2)}
                    </span>
                  </div>
                  <hr className="border-dashed border-doodle-text/30" />
                  <div className="flex justify-between text-lg font-bold">
                    <span>Total</span>
                    <span className="text-doodle-green">
                      {CURRENCY_SYMBOLS[currencyCode] || currencyCode}
                      {grandTotal.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default CheckoutPage;
