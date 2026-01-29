import React, { useState, useEffect } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  User,
  Package,
  Heart,
  Settings,
  LogOut,
  ChevronDown,
  ChevronUp,
  ShoppingCart,
  X,
  Edit2,
  Save,
  Truck,
  MapPin,
  Plus,
  CreditCard,
  Star,
  Trash2,
  Phone,
  Mail,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  AlertTriangle,
} from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import { useWishlist } from "@/context/WishlistContext";
import { useCart } from "@/context/CartContext";
import { useAddresses, Address } from "@/hooks/useAddresses";
import { usePaymentMethods } from "@/hooks/usePaymentMethods";
import {
  useOrders,
  getOrderStatusText,
  getOrderStatusColor,
} from "@/hooks/useOrders";
import { useProfile, useUpdateProfile } from "@/hooks/useProfile";
import {
  useEmailAddresses,
  useCreateEmailAddress,
  useUpdateEmailAddress,
  useDeleteEmailAddress,
} from "@/hooks/useEmailAddresses";
import { getCustomerByPersonId } from "@/lib/customerService";
import { changePassword, deleteAccount } from "@/lib/authService";
import { AddressForm } from "@/components/AddressForm";
import { AddressCard } from "@/components/AddressCard";
import { toast } from "@/hooks/use-toast";
import { z } from "zod";
import { formatPhoneNumber, parsePhoneNumber } from "@/lib/phoneFormatter";
import { trackError } from "@/lib/appInsights";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrency } from "@/context/CurrencyContext";

const profileSchema = z.object({
  title: z.string().optional(),
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(50, "First name must be less than 50 characters"),
  middleName: z
    .string()
    .trim()
    .max(50, "Middle name must be less than 50 characters")
    .optional(),
  lastName: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(50, "Last name must be less than 50 characters"),
  suffix: z.string().optional(),
  email: z
    .string()
    .trim()
    .email("Valid email is required")
    .max(255, "Email must be less than 255 characters"),
  phoneNumber: z
    .string()
    .trim()
    .regex(/^[0-9\-() +]*$/, "Invalid phone number format")
    .max(25, "Phone number must be less than 25 characters")
    .optional(),
  phoneNumberTypeId: z.number().optional(),
});

const AccountPage: React.FC = () => {
  const { user, isAuthenticated, logout, updateProfile, isLoading } = useAuth();
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const { items: wishlistItems, removeFromWishlist } = useWishlist();
  const { addToCart } = useCart();
  const { formatPrice } = useCurrency();
  const {
    addresses,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
    isLoading: addressesLoading,
  } = useAddresses();
  const {
    paymentMethods,
    removePaymentMethod,
    isLoading: paymentMethodsLoading,
  } = usePaymentMethods();
  const [customerId, setCustomerId] = useState<number | null>(null);
  const { data: orders = [], isLoading: ordersLoading } = useOrders(
    customerId || 0,
  );
  const { data: profileData, isLoading: profileLoading } = useProfile(
    user?.businessEntityId || 0,
  );
  const updateProfileMutation = useUpdateProfile();
  const { data: emailAddresses = [], isLoading: emailAddressesLoading } =
    useEmailAddresses(user?.businessEntityId || 0);
  const createEmailMutation = useCreateEmailAddress();
  const updateEmailMutation = useUpdateEmailAddress();
  const deleteEmailMutation = useDeleteEmailAddress();
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editProfileData, setEditProfileData] = useState({
    title: "",
    firstName: "",
    middleName: "",
    lastName: "",
    suffix: "",
    email: "",
    countryCode: "+1",
    phoneNumber: "",
    phoneNumberTypeId: 1,
  });
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>(
    {},
  );
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);
  const [showAddEmailForm, setShowAddEmailForm] = useState(false);
  const [editingEmailId, setEditingEmailId] = useState<number | null>(null);
  const [newEmailAddress, setNewEmailAddress] = useState("");
  const [editEmailAddress, setEditEmailAddress] = useState("");
  const [emailError, setEmailError] = useState("");

  const [memberSinceDate, setMemberSinceDate] = useState<string>("Recently");

  // Password change state
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>(
    {},
  );

  // Delete account state
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  useEffect(() => {
    if (user) {
      // Fetch customer ID for orders
      if (user.businessEntityId) {
        getCustomerByPersonId(user.businessEntityId).then((customer) => {
          if (customer) {
            setCustomerId(customer.CustomerID);
          }
        });
      }

      // If createdAt is not in user object, fetch it from API
      if (!user.createdAt && user.businessEntityId) {
        const fetchCreatedDate = async () => {
          try {
            const apiUrl =
              window.APP_CONFIG?.API_URL?.replace("/graphql", "/api") ||
              import.meta.env.VITE_API_URL?.replace("/graphql", "/api") ||
              "http://localhost:5000/api";

            const response = await fetch(
              `${apiUrl}/Person/BusinessEntityID/${user.businessEntityId}`,
            );
            if (response.ok) {
              const result = await response.json();
              const personData = result.value?.[0];
              if (personData?.ModifiedDate) {
                const date = new Date(
                  personData.ModifiedDate,
                ).toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                });
                setMemberSinceDate(date);
              }
            }
          } catch (error) {
            trackError("Error fetching creation date", error, {
              page: "AccountPage",
              businessEntityId: user.businessEntityId,
            });
          }
        };
        fetchCreatedDate();
      } else if (user.createdAt) {
        const date = new Date(user.createdAt).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        });
        setMemberSinceDate(date);
      }
    }
  }, [user]);

  // Initialize edit form when profile data loads
  useEffect(() => {
    if (profileData) {
      // Parse country code from phone number if it exists
      let countryCode = "+1";
      let phoneNumber = profileData.PhoneNumber || "";

      if (phoneNumber.startsWith("+")) {
        const match = phoneNumber.match(/^(\+\d+)\s*(.*)$/);
        if (match) {
          countryCode = match[1];
          phoneNumber = match[2];
        }
      }

      // Format the phone number for display
      const formattedPhone = phoneNumber
        ? formatPhoneNumber(phoneNumber, countryCode)
        : "";

      setEditProfileData({
        title: profileData.Title || "",
        firstName: profileData.FirstName,
        middleName: profileData.MiddleName || "",
        lastName: profileData.LastName,
        suffix: profileData.Suffix || "",
        email: profileData.EmailAddress,
        countryCode: countryCode,
        phoneNumber: formattedPhone,
        phoneNumberTypeId: profileData.PhoneNumberTypeID || 1,
      });
    }
  }, [profileData]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">
          {/* Breadcrumb Skeleton */}
          <div className="container mx-auto px-4 py-4">
            <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
          </div>

          <section className="container mx-auto px-4 pb-12">
            <div className="max-w-4xl mx-auto">
              {/* Profile Header Skeleton */}
              <div className="doodle-card p-6 md:p-8 mb-6">
                <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
                  <div className="w-20 h-20 rounded-full bg-doodle-text/10 animate-pulse"></div>
                  <div className="text-center sm:text-left space-y-2 flex-1">
                    <div className="h-8 w-48 bg-doodle-text/10 animate-pulse mx-auto sm:mx-0"></div>
                    <div className="h-4 w-64 bg-doodle-text/10 animate-pulse mx-auto sm:mx-0"></div>
                    <div className="h-3 w-40 bg-doodle-text/10 animate-pulse mx-auto sm:mx-0"></div>
                  </div>
                </div>
              </div>

              {/* Order History Skeleton */}
              <div className="doodle-card p-6 mb-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-6 h-6 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-6 w-32 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-16 bg-doodle-text/10 animate-pulse"></div>
                </div>
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="border-2 border-dashed border-doodle-text/20 p-4"
                    >
                      <div className="flex items-center justify-between">
                        <div className="space-y-2 flex-1">
                          <div className="flex items-center gap-2">
                            <div className="h-5 w-32 bg-doodle-text/10 animate-pulse"></div>
                            <div className="h-6 w-20 bg-doodle-text/10 animate-pulse rounded-full"></div>
                          </div>
                          <div className="h-4 w-40 bg-doodle-text/10 animate-pulse"></div>
                        </div>
                        <div className="h-5 w-20 bg-doodle-text/10 animate-pulse"></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Wishlist Skeleton */}
              <div className="doodle-card p-6 mb-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-6 h-6 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-6 w-32 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-16 bg-doodle-text/10 animate-pulse"></div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[1, 2].map((i) => (
                    <div
                      key={i}
                      className="border-2 border-dashed border-doodle-text/20 p-4 flex gap-4"
                    >
                      <div className="w-20 h-20 bg-doodle-text/10 animate-pulse"></div>
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-full bg-doodle-text/10 animate-pulse"></div>
                        <div className="h-5 w-20 bg-doodle-text/10 animate-pulse"></div>
                        <div className="flex gap-2">
                          <div className="h-8 w-24 bg-doodle-text/10 animate-pulse"></div>
                          <div className="h-8 w-20 bg-doodle-text/10 animate-pulse"></div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Profile Details Skeleton */}
              <div className="doodle-card p-6 mb-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className="w-6 h-6 bg-doodle-text/10 animate-pulse"></div>
                    <div className="h-6 w-32 bg-doodle-text/10 animate-pulse"></div>
                  </div>
                  <div className="h-10 w-20 bg-doodle-text/10 animate-pulse"></div>
                </div>
                <div className="space-y-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className="flex justify-between py-3 border-b border-dashed border-doodle-text/20"
                    >
                      <div className="h-4 w-24 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-4 w-48 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Addresses Skeleton */}
              <div className="doodle-card p-6 mb-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className="w-6 h-6 bg-doodle-text/10 animate-pulse"></div>
                    <div className="h-6 w-32 bg-doodle-text/10 animate-pulse"></div>
                  </div>
                  <div className="h-10 w-32 bg-doodle-text/10 animate-pulse"></div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[1, 2].map((i) => (
                    <div
                      key={i}
                      className="border-2 border-dashed border-doodle-text/20 p-4 space-y-2"
                    >
                      <div className="h-5 w-24 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-4 w-full bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-4 w-3/4 bg-doodle-text/10 animate-pulse"></div>
                      <div className="flex gap-2 mt-3">
                        <div className="h-8 w-16 bg-doodle-text/10 animate-pulse"></div>
                        <div className="h-8 w-20 bg-doodle-text/10 animate-pulse"></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Payment Methods Skeleton */}
              <div className="doodle-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className="w-6 h-6 bg-doodle-text/10 animate-pulse"></div>
                    <div className="h-6 w-40 bg-doodle-text/10 animate-pulse"></div>
                  </div>
                  <div className="h-10 w-32 bg-doodle-text/10 animate-pulse"></div>
                </div>
                <div className="space-y-3">
                  {[1, 2].map((i) => (
                    <div
                      key={i}
                      className="border-2 border-dashed border-doodle-text/20 p-4 flex justify-between items-center"
                    >
                      <div className="flex items-center gap-3 flex-1">
                        <div className="w-10 h-6 bg-doodle-text/10 animate-pulse"></div>
                        <div className="space-y-1">
                          <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
                          <div className="h-3 w-20 bg-doodle-text/10 animate-pulse"></div>
                        </div>
                      </div>
                      <div className="h-8 w-20 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </main>
        <Footer />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <Navigate to="/auth" state={{ from: { pathname: "/account" } }} replace />
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("account.backToShop")}
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="max-w-4xl mx-auto">
            {/* Profile Header */}
            <div className="doodle-card p-6 md:p-8 mb-6">
              <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
                <div className="w-20 h-20 rounded-full bg-doodle-accent flex items-center justify-center border-4 border-doodle-text">
                  <span className="text-white text-2xl font-bold font-doodle">
                    {user.firstName[0]}
                    {user.lastName[0]}
                  </span>
                </div>
                <div className="text-center sm:text-left">
                  <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text">
                    {user.firstName} {user.lastName}
                  </h1>
                  <p className="font-doodle text-doodle-text/70">
                    {user.email}
                  </p>
                  <p className="font-doodle text-sm text-doodle-text/50 mt-1">
                    {t("account.memberSince")} {memberSinceDate}
                  </p>
                </div>
              </div>
            </div>

            {/* Order History */}
            <div className="doodle-card p-6 mb-6">
              <div className="flex items-center gap-3 mb-6">
                <Package className="w-6 h-6 text-doodle-accent" />
                <h2 className="font-doodle text-xl font-bold text-doodle-text">
                  {t("account.orderHistory")}
                </h2>
                {!ordersLoading && (
                  <span className="font-doodle text-sm text-doodle-text/50">
                    ({orders.length}{" "}
                    {orders.length === 1
                      ? t("account.order")
                      : t("account.orders")}
                    )
                  </span>
                )}
              </div>

              {ordersLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="border-2 border-dashed border-doodle-text/20 p-4"
                    >
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-4 flex-1">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Skeleton className="h-5 w-32" />
                              <Skeleton className="h-6 w-20 rounded-full" />
                            </div>
                            <Skeleton className="h-4 w-40" />
                          </div>
                        </div>
                        <Skeleton className="h-5 w-20" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : orders.length === 0 ? (
                <div className="text-center py-8">
                  <Package className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                  <p className="font-doodle text-doodle-text/70 mb-4">
                    {t("account.noOrdersYet")}
                  </p>
                  <Link to="/" className="doodle-button inline-block">
                    {t("orderTracking.startShopping")}
                  </Link>
                </div>
              ) : (
                <div className="space-y-4">
                  {orders.map((order) => (
                    <div
                      key={order.SalesOrderID}
                      className="border-2 border-dashed border-doodle-text/20 p-4"
                    >
                      <button
                        onClick={() =>
                          setExpandedOrder(
                            expandedOrder === order.SalesOrderID
                              ? null
                              : order.SalesOrderID,
                          )
                        }
                        className="w-full flex items-center justify-between"
                      >
                        <div className="flex items-center gap-4">
                          <div className="text-left">
                            <div className="flex items-center gap-2">
                              <p className="font-doodle font-bold text-doodle-accent">
                                {order.SalesOrderNumber}
                              </p>
                              <span
                                className={`text-xs px-2 py-1 rounded-full border ${getOrderStatusColor(
                                  order.Status,
                                )}`}
                              >
                                {getOrderStatusText(order.Status)}
                              </span>
                            </div>
                            <p className="font-doodle text-sm text-doodle-text/70">
                              {new Date(order.OrderDate).toLocaleDateString(
                                "en-US",
                                {
                                  month: "long",
                                  day: "numeric",
                                  year: "numeric",
                                },
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="font-doodle font-bold text-doodle-green">
                            {formatPrice(order.TotalDue)}
                          </span>
                          {expandedOrder === order.SalesOrderID ? (
                            <ChevronUp className="w-5 h-5 text-doodle-text/50" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-doodle-text/50" />
                          )}
                        </div>
                      </button>

                      {expandedOrder === order.SalesOrderID && (
                        <div className="mt-4 pt-4 border-t border-dashed border-doodle-text/20">
                          {/* Order Items */}
                          <div className="space-y-2 mb-4">
                            {order.salesOrderDetails.items.map(
                              (item, index) => (
                                <div
                                  key={`${item.ProductID}-${index}`}
                                  className="flex justify-between font-doodle text-sm"
                                >
                                  <span className="text-doodle-text/70">
                                    {item.product.Name} × {item.OrderQty}
                                  </span>
                                  <span>{formatPrice(item.LineTotal)}</span>
                                </div>
                              ),
                            )}
                          </div>

                          <hr className="border-dashed border-doodle-text/20 my-3" />

                          {/* Order Summary */}
                          <div className="space-y-1 font-doodle text-sm">
                            <div className="flex justify-between">
                              <span className="text-doodle-text/70">
                                {t("orderTracking.subtotal")}
                              </span>
                              <span>{formatPrice(order.SubTotal)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-doodle-text/70">
                                {t("orderTracking.shipping")}{" "}
                                {order.shipMethod?.Name &&
                                  `(${order.shipMethod.Name})`}
                              </span>
                              <span>{formatPrice(order.Freight)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-doodle-text/70">
                                {t("orderTracking.tax")}
                              </span>
                              <span>{formatPrice(order.TaxAmt)}</span>
                            </div>
                            <div className="flex justify-between font-bold text-base pt-2 border-t border-dashed border-doodle-text/20">
                              <span>{t("orderTracking.total")}</span>
                              <span className="text-doodle-green">
                                {formatPrice(order.TotalDue)}
                              </span>
                            </div>
                          </div>

                          {order.Comment && (
                            <>
                              <hr className="border-dashed border-doodle-text/20 my-3" />
                              <div className="font-doodle text-sm">
                                <p className="font-bold text-doodle-text mb-1">
                                  {t("account.orderNotes")}
                                </p>
                                <p className="text-doodle-text/70">
                                  {order.Comment}
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Wishlist */}
            <div className="doodle-card p-6 mb-6">
              <div className="flex items-center gap-3 mb-6">
                <Heart className="w-6 h-6 text-doodle-accent" />
                <h2 className="font-doodle text-xl font-bold text-doodle-text">
                  {t("account.myWishlist")}
                </h2>
                <span className="font-doodle text-sm text-doodle-text/50">
                  ({wishlistItems.length}{" "}
                  {wishlistItems.length === 1
                    ? t("account.item")
                    : t("account.items")}
                  )
                </span>
              </div>

              {wishlistItems.length === 0 ? (
                <div className="text-center py-8">
                  <Heart className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                  <p className="font-doodle text-doodle-text/70 mb-4">
                    {t("account.wishlistEmpty")}
                  </p>
                  <Link to="/" className="doodle-button inline-block">
                    {t("account.browseProducts")}
                  </Link>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {wishlistItems.map((item) => (
                    <div
                      key={item.ProductID}
                      className="border-2 border-dashed border-doodle-text/20 p-4 flex gap-4"
                    >
                      <div className="w-20 h-20 bg-doodle-bg border-2 border-doodle-text border-dashed flex items-center justify-center flex-shrink-0">
                        <span className="font-doodle text-2xl">🚴</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <Link
                          to={`/product/${item.ProductID}`}
                          className="font-doodle font-bold text-doodle-text hover:text-doodle-accent transition-colors line-clamp-2"
                        >
                          {item.Name}
                        </Link>
                        <p className="font-doodle text-lg font-bold text-doodle-green mt-1">
                          {formatPrice(item.ListPrice)}
                        </p>
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => {
                              addToCart(item);
                              removeFromWishlist(item.ProductID);
                            }}
                            className="doodle-button doodle-button-primary text-xs py-1 px-2 flex items-center gap-1"
                          >
                            <ShoppingCart className="w-3 h-3" />
                            {t("account.addToCart")}
                          </button>
                          <button
                            onClick={() => removeFromWishlist(item.ProductID)}
                            className="doodle-button text-xs py-1 px-2 flex items-center gap-1"
                          >
                            <X className="w-3 h-3" />
                            {t("account.remove")}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Account Sections */}
            <div className="grid grid-cols-1 gap-4">
              {/* Profile Settings */}
              <div className="doodle-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <User className="w-6 h-6 text-doodle-accent" />
                    <h2 className="font-doodle text-xl font-bold text-doodle-text">
                      {t("account.profileSettings")}
                    </h2>
                  </div>
                  {!isEditingProfile && !profileLoading && (
                    <button
                      onClick={() => setIsEditingProfile(true)}
                      className="doodle-button text-sm py-1 px-3 flex items-center gap-2"
                    >
                      <Edit2 className="w-4 h-4" />
                      {t("account.edit")}
                    </button>
                  )}
                </div>

                {profileLoading ? (
                  <div className="text-center py-8">
                    <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-doodle-accent"></div>
                    <p className="font-doodle text-doodle-text/70 mt-4">
                      {t("account.loadingProfile")}
                    </p>
                  </div>
                ) : isEditingProfile ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          {t("account.title")}
                        </label>
                        <select
                          value={editProfileData.title}
                          onChange={(e) => {
                            setEditProfileData((prev) => ({
                              ...prev,
                              title: e.target.value,
                            }));
                            if (profileErrors.title) {
                              setProfileErrors((prev) => ({
                                ...prev,
                                title: "",
                              }));
                            }
                          }}
                          className="doodle-input w-full"
                        >
                          <option value="">{t("account.none")}</option>
                          <option value="Mr.">Mr.</option>
                          <option value="Ms.">Ms.</option>
                          <option value="Mrs.">Mrs.</option>
                          <option value="Dr.">Dr.</option>
                        </select>
                        {profileErrors.title && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {profileErrors.title}
                          </p>
                        )}
                      </div>
                      <div className="sm:col-span-2">
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          {t("account.firstName")} *
                        </label>
                        <input
                          type="text"
                          value={editProfileData.firstName}
                          onChange={(e) => {
                            setEditProfileData((prev) => ({
                              ...prev,
                              firstName: e.target.value,
                            }));
                            if (profileErrors.firstName) {
                              setProfileErrors((prev) => ({
                                ...prev,
                                firstName: "",
                              }));
                            }
                          }}
                          className="doodle-input w-full"
                          placeholder={t("account.placeholders.firstName")}
                        />
                        {profileErrors.firstName && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {profileErrors.firstName}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          {t("account.middleName")}
                        </label>
                        <input
                          type="text"
                          value={editProfileData.middleName}
                          onChange={(e) => {
                            setEditProfileData((prev) => ({
                              ...prev,
                              middleName: e.target.value,
                            }));
                            if (profileErrors.middleName) {
                              setProfileErrors((prev) => ({
                                ...prev,
                                middleName: "",
                              }));
                            }
                          }}
                          className="doodle-input w-full"
                          placeholder={t("account.middleNamePlaceholder")}
                        />
                        {profileErrors.middleName && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {profileErrors.middleName}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          {t("account.lastName")} *
                        </label>
                        <input
                          type="text"
                          value={editProfileData.lastName}
                          onChange={(e) => {
                            setEditProfileData((prev) => ({
                              ...prev,
                              lastName: e.target.value,
                            }));
                            if (profileErrors.lastName) {
                              setProfileErrors((prev) => ({
                                ...prev,
                                lastName: "",
                              }));
                            }
                          }}
                          className="doodle-input w-full"
                          placeholder={t("account.placeholders.lastName")}
                        />
                        {profileErrors.lastName && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {profileErrors.lastName}
                          </p>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                        {t("account.suffix")}
                      </label>
                      <select
                        value={editProfileData.suffix}
                        onChange={(e) => {
                          setEditProfileData((prev) => ({
                            ...prev,
                            suffix: e.target.value,
                          }));
                          if (profileErrors.suffix) {
                            setProfileErrors((prev) => ({
                              ...prev,
                              suffix: "",
                            }));
                          }
                        }}
                        className="doodle-input w-full"
                      >
                        <option value="">{t("account.none")}</option>
                        <option value="Jr.">Jr.</option>
                        <option value="Sr.">Sr.</option>
                        <option value="II">II</option>
                        <option value="III">III</option>
                        <option value="IV">IV</option>
                      </select>
                      {profileErrors.suffix && (
                        <p className="font-doodle text-xs text-doodle-accent mt-1">
                          {profileErrors.suffix}
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                        {t("account.email")} *
                      </label>
                      <input
                        type="email"
                        value={editProfileData.email}
                        onChange={(e) => {
                          setEditProfileData((prev) => ({
                            ...prev,
                            email: e.target.value,
                          }));
                          if (profileErrors.email) {
                            setProfileErrors((prev) => ({
                              ...prev,
                              email: "",
                            }));
                          }
                        }}
                        className="doodle-input w-full"
                        placeholder={t("account.placeholders.email")}
                      />
                      {profileErrors.email && (
                        <p className="font-doodle text-xs text-doodle-accent mt-1">
                          {profileErrors.email}
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          {t("account.phoneNumber")}
                        </label>
                        <div className="flex gap-2">
                          <select
                            value={editProfileData.countryCode}
                            onChange={(e) => {
                              setEditProfileData((prev) => ({
                                ...prev,
                                countryCode: e.target.value,
                              }));
                            }}
                            className="doodle-input w-24 flex-shrink-0"
                          >
                            <option value="+1">🇺🇸 +1</option>
                            <option value="+44">🇬🇧 +44</option>
                            <option value="+61">🇦🇺 +61</option>
                            <option value="+81">🇯🇵 +81</option>
                            <option value="+86">🇨🇳 +86</option>
                            <option value="+49">🇩🇪 +49</option>
                            <option value="+33">🇫🇷 +33</option>
                            <option value="+39">🇮🇹 +39</option>
                            <option value="+34">🇪🇸 +34</option>
                            <option value="+52">🇲🇽 +52</option>
                            <option value="+55">🇧🇷 +55</option>
                            <option value="+91">🇮🇳 +91</option>
                          </select>
                          <input
                            type="tel"
                            value={editProfileData.phoneNumber}
                            onChange={(e) => {
                              const formatted = formatPhoneNumber(
                                e.target.value,
                                editProfileData.countryCode,
                              );
                              setEditProfileData((prev) => ({
                                ...prev,
                                phoneNumber: formatted,
                              }));
                              if (profileErrors.phoneNumber) {
                                setProfileErrors((prev) => ({
                                  ...prev,
                                  phoneNumber: "",
                                }));
                              }
                            }}
                            className="doodle-input flex-1"
                            placeholder={t("account.placeholders.phone")}
                          />
                        </div>
                        {profileErrors.phoneNumber && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {profileErrors.phoneNumber}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          {t("account.phoneType")}
                        </label>
                        <select
                          value={editProfileData.phoneNumberTypeId}
                          onChange={(e) => {
                            setEditProfileData((prev) => ({
                              ...prev,
                              phoneNumberTypeId: parseInt(e.target.value),
                            }));
                          }}
                          className="doodle-input w-full"
                        >
                          <option value="1">{t("account.cell")}</option>
                          <option value="2">{t("account.home")}</option>
                          <option value="3">{t("account.work")}</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={async () => {
                          try {
                            profileSchema.parse(editProfileData);
                            setProfileErrors({});

                            if (profileData) {
                              // Strip formatting from phone number before saving
                              const cleanPhoneNumber = parsePhoneNumber(
                                editProfileData.phoneNumber,
                              );
                              const fullPhoneNumber = cleanPhoneNumber
                                ? `${editProfileData.countryCode} ${cleanPhoneNumber}`
                                : null;

                              await updateProfileMutation.mutateAsync({
                                BusinessEntityID: profileData.BusinessEntityID,
                                Title: editProfileData.title || null,
                                FirstName: editProfileData.firstName.trim(),
                                MiddleName:
                                  editProfileData.middleName.trim() || null,
                                LastName: editProfileData.lastName.trim(),
                                Suffix: editProfileData.suffix || null,
                                EmailAddress: editProfileData.email.trim(),
                                EmailAddressID: profileData.EmailAddressID,
                                PhoneNumber: fullPhoneNumber,
                                PhoneNumberTypeID:
                                  editProfileData.phoneNumberTypeId,
                              });

                              // Update auth context with new name/email
                              await updateProfile(
                                editProfileData.firstName.trim(),
                                editProfileData.lastName.trim(),
                                editProfileData.email.trim(),
                              );

                              setIsEditingProfile(false);
                            }
                          } catch (error) {
                            if (error instanceof z.ZodError) {
                              const newErrors: Record<string, string> = {};
                              error.errors.forEach((err) => {
                                if (err.path[0]) {
                                  newErrors[err.path[0] as string] =
                                    err.message;
                                }
                              });
                              setProfileErrors(newErrors);
                            }
                          }
                        }}
                        disabled={updateProfileMutation.isPending}
                        className="doodle-button doodle-button-primary py-2 px-4 flex items-center gap-2"
                      >
                        <Save className="w-4 h-4" />
                        {updateProfileMutation.isPending
                          ? t("account.saving")
                          : t("account.saveChanges")}
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingProfile(false);
                          setProfileErrors({});
                          if (profileData) {
                            // Parse country code from phone number
                            let countryCode = "+1";
                            let phoneNumber = profileData.PhoneNumber || "";

                            if (phoneNumber.startsWith("+")) {
                              const match =
                                phoneNumber.match(/^(\+\d+)\s*(.*)$/);
                              if (match) {
                                countryCode = match[1];
                                phoneNumber = match[2];
                              }
                            }

                            // Format the phone number for display
                            const formattedPhone = phoneNumber
                              ? formatPhoneNumber(phoneNumber, countryCode)
                              : "";

                            setEditProfileData({
                              title: profileData.Title || "",
                              firstName: profileData.FirstName,
                              middleName: profileData.MiddleName || "",
                              lastName: profileData.LastName,
                              suffix: profileData.Suffix || "",
                              email: profileData.EmailAddress,
                              countryCode: countryCode,
                              phoneNumber: formattedPhone,
                              phoneNumberTypeId:
                                profileData.PhoneNumberTypeID || 1,
                            });
                          }
                        }}
                        className="doodle-button py-2 px-4"
                      >
                        {t("account.cancel")}
                      </button>
                    </div>
                  </div>
                ) : profileData ? (
                  <div className="space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                      <span className="font-doodle text-sm text-doodle-text/70 sm:w-24">
                        {t("account.name")}:
                      </span>
                      <span className="font-doodle font-bold text-doodle-text">
                        {profileData.Title && `${profileData.Title} `}
                        {profileData.FirstName}
                        {profileData.MiddleName && ` ${profileData.MiddleName}`}
                        {` ${profileData.LastName}`}
                        {profileData.Suffix && `, ${profileData.Suffix}`}
                      </span>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                      <span className="font-doodle text-sm text-doodle-text/70 sm:w-24">
                        {t("account.email")}:
                      </span>
                      <span className="font-doodle font-bold text-doodle-text">
                        {profileData.EmailAddress}
                      </span>
                    </div>
                    {profileData.PhoneNumber && (
                      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                        <span className="font-doodle text-sm text-doodle-text/70 sm:w-24">
                          {t("account.phone")}:
                        </span>
                        <span className="font-doodle font-bold text-doodle-text">
                          {(() => {
                            // Parse and format the phone number for display
                            let countryCode = "+1";
                            let phoneNumber = profileData.PhoneNumber;

                            if (phoneNumber.startsWith("+")) {
                              const match =
                                phoneNumber.match(/^(\+\d+)\s*(.*)$/);
                              if (match) {
                                countryCode = match[1];
                                phoneNumber = match[2];
                              }
                            }

                            const formatted = formatPhoneNumber(
                              phoneNumber,
                              countryCode,
                            );
                            return `${countryCode} ${formatted}`;
                          })()}
                          <span className="text-sm text-doodle-text/50 ml-2">
                            (
                            {profileData.PhoneNumberTypeID === 1
                              ? t("account.cell")
                              : profileData.PhoneNumberTypeID === 2
                                ? t("account.home")
                                : t("account.work")}
                            )
                          </span>
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <p className="font-doodle text-doodle-text/70">
                      {t("account.unableToLoad")}
                    </p>
                  </div>
                )}
              </div>
              {/* Email Addresses */}
              <div className="doodle-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <Mail className="w-6 h-6 text-doodle-accent" />
                    <h2 className="font-doodle text-xl font-bold text-doodle-text">
                      Email Addresses
                    </h2>
                    <span className="font-doodle text-sm text-doodle-text/50">
                      ({emailAddresses.length}{" "}
                      {emailAddresses.length === 1 ? "email" : "emails"})
                    </span>
                  </div>
                  {!showAddEmailForm && (
                    <button
                      onClick={() => {
                        setShowAddEmailForm(true);
                        setNewEmailAddress("");
                        setEmailError("");
                      }}
                      className="doodle-button text-sm py-1 px-3 flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Add Email
                    </button>
                  )}
                </div>

                {showAddEmailForm && (
                  <div className="mb-6 p-4 border-2 border-dashed border-doodle-accent/30 bg-doodle-accent/5">
                    <h3 className="font-doodle font-bold text-doodle-text mb-4">
                      Add New Email Address
                    </h3>
                    <div className="space-y-3">
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          Email Address *
                        </label>
                        <input
                          type="email"
                          value={newEmailAddress}
                          onChange={(e) => {
                            setNewEmailAddress(e.target.value);
                            setEmailError("");
                          }}
                          className="doodle-input w-full"
                          placeholder="your.email@example.com"
                        />
                        {emailError && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {emailError}
                          </p>
                        )}
                        {newEmailAddress &&
                          (newEmailAddress
                            .toLowerCase()
                            .includes("@yahoo.com") ||
                            newEmailAddress
                              .toLowerCase()
                              .includes("@gmail.com")) && (
                            <div className="mt-2 p-3 bg-amber-50 border-2 border-dashed border-amber-300 rounded">
                              <p className="font-doodle text-xs text-amber-800">
                                <strong>⚠️ Note:</strong> This demo site uses
                                Azure Communication Services.
                                {newEmailAddress
                                  .toLowerCase()
                                  .includes("@yahoo.com")
                                  ? "Yahoo may block emails from this service."
                                  : "Gmail may mark emails from this service as spam."}{" "}
                                You can still use this address, but check your
                                spam folder.
                              </p>
                            </div>
                          )}
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={async () => {
                            const trimmedEmail = newEmailAddress.trim();

                            // Validation
                            if (!trimmedEmail) {
                              setEmailError("Email address is required");
                              return;
                            }
                            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                            if (!emailRegex.test(trimmedEmail)) {
                              setEmailError(
                                "Please enter a valid email address",
                              );
                              return;
                            }
                            // Check for duplicates
                            if (
                              emailAddresses.some(
                                (e) =>
                                  e.EmailAddress.toLowerCase() ===
                                  trimmedEmail.toLowerCase(),
                              )
                            ) {
                              setEmailError(
                                "This email address is already in your account",
                              );
                              return;
                            }

                            try {
                              await createEmailMutation.mutateAsync({
                                businessEntityId: user!.businessEntityId,
                                emailAddress: trimmedEmail,
                              });
                              setShowAddEmailForm(false);
                              setNewEmailAddress("");
                            } catch (error) {
                              setEmailError("Failed to add email address");
                            }
                          }}
                          disabled={createEmailMutation.isPending}
                          className="doodle-button doodle-button-primary py-2 px-4 flex items-center gap-2"
                        >
                          <Save className="w-4 h-4" />
                          {createEmailMutation.isPending ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={() => {
                            setShowAddEmailForm(false);
                            setNewEmailAddress("");
                            setEmailError("");
                          }}
                          className="doodle-button py-2 px-4"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {emailAddressesLoading ? (
                  <div className="space-y-3">
                    {[1, 2].map((i) => (
                      <div
                        key={i}
                        className="border-2 border-dashed border-doodle-text/20 p-4"
                      >
                        <Skeleton className="h-4 w-full" />
                      </div>
                    ))}
                  </div>
                ) : emailAddresses.length === 0 ? (
                  <div className="text-center py-8">
                    <Mail className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                    <p className="font-doodle text-doodle-text/70 mb-4">
                      No email addresses found
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {emailAddresses.map((email, index) => (
                      <div
                        key={email.EmailAddressID}
                        className="border-2 border-dashed border-doodle-text/20 p-4"
                      >
                        {editingEmailId === email.EmailAddressID ? (
                          <div className="space-y-3">
                            <div>
                              <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                                Email Address *
                              </label>
                              <input
                                type="email"
                                value={editEmailAddress}
                                onChange={(e) => {
                                  setEditEmailAddress(e.target.value);
                                  setEmailError("");
                                }}
                                className="doodle-input w-full"
                              />
                              {emailError && (
                                <p className="font-doodle text-xs text-doodle-accent mt-1">
                                  {emailError}
                                </p>
                              )}
                              {editEmailAddress &&
                                (editEmailAddress
                                  .toLowerCase()
                                  .includes("@yahoo.com") ||
                                  editEmailAddress
                                    .toLowerCase()
                                    .includes("@gmail.com")) && (
                                  <div className="mt-2 p-3 bg-amber-50 border-2 border-dashed border-amber-300 rounded">
                                    <p className="font-doodle text-xs text-amber-800">
                                      <strong>⚠️ Note:</strong> This demo site
                                      uses Azure Communication Services.
                                      {editEmailAddress
                                        .toLowerCase()
                                        .includes("@yahoo.com")
                                        ? "Yahoo may block emails from this service."
                                        : "Gmail may mark emails from this service as spam."}{" "}
                                      You can still use this address, but check
                                      your spam folder.
                                    </p>
                                  </div>
                                )}
                            </div>
                            <div className="flex gap-3">
                              <button
                                onClick={async () => {
                                  const trimmedEmail = editEmailAddress.trim();

                                  // Validation
                                  if (!trimmedEmail) {
                                    setEmailError("Email address is required");
                                    return;
                                  }
                                  const emailRegex =
                                    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                                  if (!emailRegex.test(trimmedEmail)) {
                                    setEmailError(
                                      "Please enter a valid email address",
                                    );
                                    return;
                                  }
                                  // Check for duplicates (excluding current email)
                                  if (
                                    emailAddresses.some(
                                      (e) =>
                                        e.EmailAddressID !==
                                          email.EmailAddressID &&
                                        e.EmailAddress.toLowerCase() ===
                                          trimmedEmail.toLowerCase(),
                                    )
                                  ) {
                                    setEmailError(
                                      "This email address is already in your account",
                                    );
                                    return;
                                  }

                                  try {
                                    await updateEmailMutation.mutateAsync({
                                      businessEntityId: user!.businessEntityId,
                                      emailAddressId: email.EmailAddressID,
                                      emailAddress: trimmedEmail,
                                    });
                                    setEditingEmailId(null);
                                    setEditEmailAddress("");
                                  } catch (error) {
                                    setEmailError(
                                      "Failed to update email address",
                                    );
                                  }
                                }}
                                disabled={updateEmailMutation.isPending}
                                className="doodle-button doodle-button-primary py-2 px-4 flex items-center gap-2"
                              >
                                <Save className="w-4 h-4" />
                                {updateEmailMutation.isPending
                                  ? "Saving..."
                                  : "Save"}
                              </button>
                              <button
                                onClick={() => {
                                  setEditingEmailId(null);
                                  setEditEmailAddress("");
                                  setEmailError("");
                                }}
                                className="doodle-button py-2 px-4"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3 flex-1">
                              <Mail className="w-5 h-5 text-doodle-text/50" />
                              <div>
                                <p className="font-doodle font-bold text-doodle-text">
                                  {email.EmailAddress}
                                </p>
                                {email.EmailAddress.toLowerCase() ===
                                  user?.email.toLowerCase() && (
                                  <span className="text-xs text-doodle-text/50">
                                    Used for login (cannot be removed)
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  setEditingEmailId(email.EmailAddressID);
                                  setEditEmailAddress(email.EmailAddress);
                                  setEmailError("");
                                }}
                                className="doodle-button text-sm py-1 px-3 flex items-center gap-1"
                              >
                                <Edit2 className="w-3 h-3" />
                                Edit
                              </button>
                              {email.EmailAddress.toLowerCase() !==
                                user?.email.toLowerCase() &&
                                emailAddresses.length > 1 && (
                                  <button
                                    onClick={async () => {
                                      if (
                                        window.confirm(
                                          "Are you sure you want to remove this email address?",
                                        )
                                      ) {
                                        try {
                                          await deleteEmailMutation.mutateAsync(
                                            {
                                              businessEntityId:
                                                user!.businessEntityId,
                                              emailAddressId:
                                                email.EmailAddressID,
                                            },
                                          );
                                        } catch (error) {
                                          toast({
                                            title: "Error",
                                            description:
                                              "Failed to remove email address",
                                            variant: "destructive",
                                          });
                                        }
                                      }
                                    }}
                                    disabled={deleteEmailMutation.isPending}
                                    className="doodle-button text-sm py-1 px-3 flex items-center gap-1 text-doodle-accent hover:bg-doodle-accent/10"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    Remove
                                  </button>
                                )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              ;{/* Saved Addresses */}
              <div className="doodle-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <MapPin className="w-6 h-6 text-doodle-accent" />
                    <h2 className="font-doodle text-xl font-bold text-doodle-text">
                      {t("account.savedAddresses")}
                    </h2>
                    <span className="font-doodle text-sm text-doodle-text/50">
                      ({addresses.length}{" "}
                      {addresses.length === 1
                        ? t("account.address")
                        : t("account.addresses")}
                      )
                    </span>
                  </div>
                  {!showAddressForm && !editingAddress && (
                    <button
                      data-testid="add-address-button"
                      onClick={() => setShowAddressForm(true)}
                      className="doodle-button text-sm py-1 px-3 flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      {t("account.addNew")}
                    </button>
                  )}
                </div>

                {showAddressForm && (
                  <div className="mb-6 p-4 border-2 border-dashed border-doodle-accent/30 bg-doodle-accent/5">
                    <h3 className="font-doodle font-bold text-doodle-text mb-4">
                      {t("account.addNewAddress")}
                    </h3>
                    <AddressForm
                      onSave={async (addressData) => {
                        try {
                          await addAddress(addressData);
                          setShowAddressForm(false);
                          toast({
                            title: t("account.addressAdded"),
                            description: t("account.addressAddedDesc"),
                          });
                        } catch (error) {
                          toast({
                            title: t("account.error"),
                            description: t("account.errorAddAddress"),
                            variant: "destructive",
                          });
                        }
                      }}
                      onCancel={() => setShowAddressForm(false)}
                    />
                  </div>
                )}

                {editingAddress && (
                  <div className="mb-6 p-4 border-2 border-dashed border-doodle-accent/30 bg-doodle-accent/5">
                    <h3 className="font-doodle font-bold text-doodle-text mb-4">
                      {t("account.editAddress")}
                    </h3>
                    <AddressForm
                      address={editingAddress}
                      onSave={async (addressData) => {
                        try {
                          await updateAddress(editingAddress.id, addressData);
                          setEditingAddress(null);
                          toast({
                            title: t("account.addressUpdated"),
                            description: t("account.addressUpdatedDesc"),
                          });
                        } catch (error) {
                          toast({
                            title: t("account.error"),
                            description: t("account.errorUpdateAddress"),
                            variant: "destructive",
                          });
                        }
                      }}
                      onCancel={() => setEditingAddress(null)}
                    />
                  </div>
                )}

                {addressesLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[1, 2].map((i) => (
                      <div
                        key={i}
                        className="border-2 border-dashed border-doodle-text/20 p-4"
                      >
                        <div className="flex items-start gap-3">
                          <Skeleton className="w-5 h-5 rounded-full" />
                          <div className="flex-1 space-y-3">
                            <Skeleton className="h-5 w-24" />
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-4 w-1/2" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : addresses.length === 0 && !showAddressForm ? (
                  <div className="text-center py-8">
                    <MapPin className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                    <p className="font-doodle text-doodle-text/70">
                      {t("account.noAddressesYet")}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {addresses.map((address) => (
                      <AddressCard
                        key={address.id}
                        address={address}
                        onEdit={(addr) => setEditingAddress(addr)}
                        onDelete={async (id) => {
                          try {
                            await deleteAddress(id);
                            toast({
                              title: t("account.addressDeleted"),
                              description: t("account.addressDeletedDesc"),
                            });
                          } catch (error) {
                            toast({
                              title: t("account.error"),
                              description: t("account.errorDeleteAddress"),
                              variant: "destructive",
                            });
                          }
                        }}
                        onSetDefault={async (id) => {
                          try {
                            await setDefaultAddress(id);
                            toast({
                              title: t("account.defaultAddressUpdated"),
                              description: t(
                                "account.defaultAddressUpdatedDesc",
                              ),
                            });
                          } catch (error) {
                            toast({
                              title: t("account.error"),
                              description: t("account.errorSetDefaultAddress"),
                              variant: "destructive",
                            });
                          }
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
              {/* Saved Payment Methods */}
              <div className="doodle-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <CreditCard className="w-6 h-6 text-doodle-accent" />
                    <h2 className="font-doodle text-xl font-bold text-doodle-text">
                      {t("account.paymentMethods")}
                    </h2>
                    <span className="font-doodle text-sm text-doodle-text/50">
                      ({paymentMethods.length} {t("account.saved")})
                    </span>
                  </div>
                </div>

                {paymentMethodsLoading ? (
                  <div className="space-y-3">
                    {[1, 2].map((i) => (
                      <div
                        key={i}
                        className="flex items-center gap-4 p-4 border-2 border-dashed border-doodle-text/20"
                      >
                        <Skeleton className="w-8 h-8" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-5 w-48" />
                          <Skeleton className="h-4 w-64" />
                        </div>
                        <div className="flex gap-2">
                          <Skeleton className="w-9 h-9" />
                          <Skeleton className="w-9 h-9" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : paymentMethods.length === 0 ? (
                  <div className="text-center py-8">
                    <CreditCard className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                    <p className="font-doodle text-doodle-text/70 mb-4">
                      {t("account.noPaymentMethods")}
                    </p>
                    <p className="font-doodle text-sm text-doodle-text/50">
                      {t("account.saveCardDuringCheckout")}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {paymentMethods.map((pm) => (
                      <div
                        key={pm.id}
                        className="flex items-center gap-4 p-4 border-2 border-dashed border-doodle-text/20"
                      >
                        <CreditCard className="w-8 h-8 text-doodle-text/70" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-doodle font-bold text-doodle-text">
                              {pm.cardBrand} •••• {pm.cardLast4}
                            </span>
                            {pm.isDefault && (
                              <span className="font-doodle text-xs bg-doodle-accent text-white px-2 py-0.5 rounded">
                                {t("account.default")}
                              </span>
                            )}
                          </div>
                          <p className="font-doodle text-sm text-doodle-text/70">
                            {pm.cardholderName} • {t("account.expires")}{" "}
                            {pm.cardExpiry}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={async () => {
                              try {
                                await removePaymentMethod(pm.id);
                                toast({
                                  title: t("account.paymentMethodRemoved"),
                                  description: t(
                                    "account.paymentMethodRemovedDesc",
                                  ),
                                });
                              } catch (error) {
                                toast({
                                  title: t("account.error"),
                                  description: t("account.errorRemovePayment"),
                                  variant: "destructive",
                                });
                              }
                            }}
                            className="p-2 hover:bg-doodle-accent/10 rounded transition-colors"
                            title={t("account.delete")}
                          >
                            <Trash2 className="w-4 h-4 text-doodle-accent" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Account Settings */}
              <div className="doodle-card p-6">
                <div
                  data-testid="account-settings-toggle"
                  className="flex items-start gap-4 cursor-pointer group"
                  onClick={() => setShowPasswordForm(!showPasswordForm)}
                >
                  <div className="w-12 h-12 doodle-border-light flex items-center justify-center group-hover:rotate-6 transition-transform">
                    <Settings className="w-6 h-6 text-doodle-text" />
                  </div>
                  <div className="flex-1">
                    <h2 className="font-doodle text-xl font-bold text-doodle-text group-hover:text-doodle-accent transition-colors">
                      {t("account.accountSettings")}
                    </h2>
                    <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                      {t("account.passwordAndSecurity")}
                    </p>
                  </div>
                  {showPasswordForm ? (
                    <ChevronUp className="w-5 h-5 text-doodle-text" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-doodle-text" />
                  )}
                </div>

                {showPasswordForm && (
                  <div className="mt-6 pt-6 border-t-2 border-dashed border-doodle-text/20">
                    <h3 className="font-doodle text-lg font-bold text-doodle-text mb-4 flex items-center gap-2">
                      <Lock className="w-5 h-5" />
                      Change Password
                    </h3>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setPasswordErrors({});

                        // Validation
                        const errors: Record<string, string> = {};
                        if (!currentPassword) {
                          errors.currentPassword =
                            "Current password is required";
                        }
                        if (!newPassword) {
                          errors.newPassword = "New password is required";
                        } else if (newPassword.length < 8) {
                          errors.newPassword =
                            "Password must be at least 8 characters";
                        }
                        if (newPassword !== confirmNewPassword) {
                          errors.confirmNewPassword = "Passwords don't match";
                        }
                        if (
                          currentPassword &&
                          newPassword &&
                          currentPassword === newPassword
                        ) {
                          errors.newPassword =
                            "New password must be different from current password";
                        }

                        if (Object.keys(errors).length > 0) {
                          setPasswordErrors(errors);
                          return;
                        }

                        setIsChangingPassword(true);
                        const result = await changePassword(
                          user!.businessEntityId,
                          currentPassword,
                          newPassword,
                        );
                        setIsChangingPassword(false);

                        if (result.success) {
                          toast({
                            title: "Password Changed",
                            description:
                              "Your password has been updated successfully.",
                          });
                          // Reset form
                          setCurrentPassword("");
                          setNewPassword("");
                          setConfirmNewPassword("");
                          setShowPasswordForm(false);
                        } else {
                          toast({
                            title: "Error",
                            description:
                              result.error || "Failed to change password.",
                            variant: "destructive",
                          });
                        }
                      }}
                      className="space-y-4"
                    >
                      {/* Current Password */}
                      <div>
                        <label
                          htmlFor="currentPassword"
                          className="font-doodle text-sm text-doodle-text block mb-1"
                        >
                          Current Password
                        </label>
                        <div className="relative">
                          <input
                            id="currentPassword"
                            type={showCurrentPassword ? "text" : "password"}
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            className={`doodle-input w-full pr-10 ${
                              passwordErrors.currentPassword
                                ? "border-doodle-accent"
                                : ""
                            }`}
                            placeholder="Enter current password"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowCurrentPassword(!showCurrentPassword)
                            }
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-doodle-text/50 hover:text-doodle-text"
                          >
                            {showCurrentPassword ? (
                              <EyeOff className="w-5 h-5" />
                            ) : (
                              <Eye className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                        {passwordErrors.currentPassword && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {passwordErrors.currentPassword}
                          </p>
                        )}
                      </div>

                      {/* New Password */}
                      <div>
                        <label
                          htmlFor="newPassword"
                          className="font-doodle text-sm text-doodle-text block mb-1"
                        >
                          New Password
                        </label>
                        <div className="relative">
                          <input
                            id="newPassword"
                            type={showNewPassword ? "text" : "password"}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className={`doodle-input w-full pr-10 ${
                              passwordErrors.newPassword
                                ? "border-doodle-accent"
                                : ""
                            }`}
                            placeholder="Enter new password (min 8 characters)"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-doodle-text/50 hover:text-doodle-text"
                          >
                            {showNewPassword ? (
                              <EyeOff className="w-5 h-5" />
                            ) : (
                              <Eye className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                        {passwordErrors.newPassword && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {passwordErrors.newPassword}
                          </p>
                        )}
                      </div>

                      {/* Confirm New Password */}
                      <div>
                        <label
                          htmlFor="confirmNewPassword"
                          className="font-doodle text-sm text-doodle-text block mb-1"
                        >
                          Confirm New Password
                        </label>
                        <div className="relative">
                          <input
                            id="confirmNewPassword"
                            type={showConfirmPassword ? "text" : "password"}
                            value={confirmNewPassword}
                            onChange={(e) =>
                              setConfirmNewPassword(e.target.value)
                            }
                            className={`doodle-input w-full pr-10 ${
                              passwordErrors.confirmNewPassword
                                ? "border-doodle-accent"
                                : ""
                            }`}
                            placeholder="Confirm new password"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowConfirmPassword(!showConfirmPassword)
                            }
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-doodle-text/50 hover:text-doodle-text"
                          >
                            {showConfirmPassword ? (
                              <EyeOff className="w-5 h-5" />
                            ) : (
                              <Eye className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                        {passwordErrors.confirmNewPassword && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">
                            {passwordErrors.confirmNewPassword}
                          </p>
                        )}
                      </div>

                      {/* Submit Buttons */}
                      <div className="flex gap-3 pt-2">
                        <button
                          type="submit"
                          disabled={isChangingPassword}
                          className="doodle-button doodle-button-primary flex items-center gap-2"
                        >
                          {isChangingPassword ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Changing...
                            </>
                          ) : (
                            <>
                              <Save className="w-4 h-4" />
                              Change Password
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowPasswordForm(false);
                            setCurrentPassword("");
                            setNewPassword("");
                            setConfirmNewPassword("");
                            setPasswordErrors({});
                          }}
                          className="doodle-button"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Delete Account Section */}
                <div className="mt-6 pt-6 border-t-2 border-dashed border-doodle-accent/20">
                  <div className="bg-doodle-accent/10 border-2 border-dashed border-doodle-accent/30 p-4 rounded-lg">
                    <div className="flex items-start gap-3 mb-3">
                      <AlertTriangle className="w-5 h-5 text-doodle-accent flex-shrink-0 mt-0.5" />
                      <div>
                        <h3 className="font-doodle text-lg font-bold text-doodle-accent">
                          Delete Account
                        </h3>
                        <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                          This will permanently delete your account and all
                          associated data including orders, addresses, and saved
                          information. This action cannot be undone.
                        </p>
                      </div>
                    </div>

                    {!showDeleteConfirmation ? (
                      <button
                        onClick={() => setShowDeleteConfirmation(true)}
                        className="doodle-button border-doodle-accent text-doodle-accent hover:bg-doodle-accent hover:text-white transition-colors"
                      >
                        Delete My Account
                      </button>
                    ) : (
                      <div className="mt-4 space-y-4">
                        <div>
                          <label className="font-doodle text-sm text-doodle-text block mb-2">
                            Type <strong>DELETE</strong> to confirm:
                          </label>
                          <input
                            type="text"
                            value={deleteConfirmText}
                            onChange={(e) =>
                              setDeleteConfirmText(e.target.value)
                            }
                            className="doodle-input w-full max-w-xs"
                            placeholder="DELETE"
                          />
                        </div>
                        <div className="flex gap-3">
                          <button
                            onClick={async () => {
                              if (deleteConfirmText !== "DELETE") {
                                toast({
                                  title: "Confirmation Required",
                                  description: "Please type DELETE to confirm.",
                                  variant: "destructive",
                                });
                                return;
                              }

                              setIsDeletingAccount(true);
                              const result = await deleteAccount(
                                user!.businessEntityId,
                              );
                              setIsDeletingAccount(false);

                              if (result.success) {
                                toast({
                                  title: "Account Deleted",
                                  description:
                                    "Your account has been permanently deleted.",
                                });
                                logout();
                                navigate("/");
                              } else {
                                toast({
                                  title: "Error",
                                  description:
                                    result.error || "Failed to delete account.",
                                  variant: "destructive",
                                });
                                setShowDeleteConfirmation(false);
                                setDeleteConfirmText("");
                              }
                            }}
                            disabled={
                              isDeletingAccount ||
                              deleteConfirmText !== "DELETE"
                            }
                            className="doodle-button bg-doodle-accent border-doodle-accent text-white hover:bg-doodle-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            {isDeletingAccount ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Deleting...
                              </>
                            ) : (
                              <>
                                <Trash2 className="w-4 h-4" />
                                Permanently Delete Account
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => {
                              setShowDeleteConfirmation(false);
                              setDeleteConfirmText("");
                            }}
                            disabled={isDeletingAccount}
                            className="doodle-button"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Sign Out */}
            <div className="mt-8 text-center">
              <button
                onClick={() => {
                  logout();
                  navigate("/");
                }}
                className="doodle-button inline-flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                {t("account.signOut")}
              </button>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default AccountPage;
