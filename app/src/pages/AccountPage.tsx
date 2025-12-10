import React, { useState, useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft, User, Package, Heart, Settings, LogOut, ChevronDown, ChevronUp, ShoppingCart, X, Edit2, Save, Truck, MapPin, Plus, CreditCard, Star, Trash2 } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useAuth } from '@/context/AuthContext';
import { useWishlist } from '@/context/WishlistContext';
import { useCart } from '@/context/CartContext';
import { useAddresses, Address } from '@/hooks/useAddresses';
import { usePaymentMethods } from '@/hooks/usePaymentMethods';
import { useOrders, getOrderStatusText, getOrderStatusColor } from '@/hooks/useOrders';
import { getCustomerByPersonId } from '@/lib/customerService';
import { AddressForm } from '@/components/AddressForm';
import { AddressCard } from '@/components/AddressCard';
import { toast } from '@/hooks/use-toast';
import { z } from 'zod';

const profileSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(50, 'First name must be less than 50 characters'),
  lastName: z.string().trim().min(1, 'Last name is required').max(50, 'Last name must be less than 50 characters'),
  email: z.string().trim().email('Valid email is required').max(255, 'Email must be less than 255 characters'),
});

const AccountPage: React.FC = () => {
  const { user, isAuthenticated, logout, updateProfile, isLoading } = useAuth();
  const { items: wishlistItems, removeFromWishlist } = useWishlist();
  const { addToCart } = useCart();
  const { addresses, addAddress, updateAddress, deleteAddress, setDefaultAddress } = useAddresses();
  const { paymentMethods, deletePaymentMethod, setDefaultPaymentMethod } = usePaymentMethods();
  const [customerId, setCustomerId] = useState<number | null>(null);
  const { data: orders = [], isLoading: ordersLoading } = useOrders(customerId || 0);
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [profileData, setProfileData] = useState({
    firstName: '',
    lastName: '',
    email: '',
  });
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);

  const [memberSinceDate, setMemberSinceDate] = useState<string>('Recently');

  useEffect(() => {
    if (user) {
      console.log('[AccountPage] User object:', user);
      console.log('[AccountPage] user.createdAt:', user.createdAt);
      
      setProfileData({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      });

      // Fetch customer ID for orders
      if (user.businessEntityId) {
        getCustomerByPersonId(user.businessEntityId).then(customer => {
          if (customer) {
            setCustomerId(customer.CustomerID);
          }
        });
      }

      // If createdAt is not in user object, fetch it from API
      if (!user.createdAt && user.businessEntityId) {
        const fetchCreatedDate = async () => {
          try {
            const apiUrl = window.APP_CONFIG?.API_URL?.replace('/graphql', '/api') || 
                          import.meta.env.VITE_API_URL?.replace('/graphql', '/api') || 
                          'http://localhost:5000/api';
            
            const response = await fetch(`${apiUrl}/Person/BusinessEntityID/${user.businessEntityId}`);
            if (response.ok) {
              const result = await response.json();
              const personData = result.value?.[0];
              if (personData?.ModifiedDate) {
                const date = new Date(personData.ModifiedDate).toLocaleDateString('en-US', {
                  month: 'long',
                  year: 'numeric'
                });
                console.log('[AccountPage] Fetched ModifiedDate from API:', personData.ModifiedDate, '→', date);
                setMemberSinceDate(date);
              }
            }
          } catch (error) {
            console.error('[AccountPage] Error fetching creation date:', error);
          }
        };
        fetchCreatedDate();
      } else if (user.createdAt) {
        const date = new Date(user.createdAt).toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric'
        });
        console.log('[AccountPage] Using createdAt from user object:', user.createdAt, '→', date);
        setMemberSinceDate(date);
      }
    }
  }, [user]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-doodle-bg">
        <div className="text-center">
          <span className="text-6xl block mb-4 animate-bounce">🚴</span>
          <p className="font-doodle text-doodle-text">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/auth" state={{ from: { pathname: '/account' } }} replace />;
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
            Back to Shop
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="max-w-4xl mx-auto">
            {/* Profile Header */}
            <div className="doodle-card p-6 md:p-8 mb-6">
              <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
                <div className="w-20 h-20 rounded-full bg-doodle-accent flex items-center justify-center border-4 border-doodle-text">
                  <span className="text-white text-2xl font-bold font-doodle">
                    {user.firstName[0]}{user.lastName[0]}
                  </span>
                </div>
                <div className="text-center sm:text-left">
                  <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text">
                    {user.firstName} {user.lastName}
                  </h1>
                  <p className="font-doodle text-doodle-text/70">{user.email}</p>
                  <p className="font-doodle text-sm text-doodle-text/50 mt-1">
                    Member since {memberSinceDate}
                  </p>
                </div>
              </div>
            </div>

            {/* Order History */}
            <div className="doodle-card p-6 mb-6">
              <div className="flex items-center gap-3 mb-6">
                <Package className="w-6 h-6 text-doodle-accent" />
                <h2 className="font-doodle text-xl font-bold text-doodle-text">
                  Order History
                </h2>
                {!ordersLoading && (
                  <span className="font-doodle text-sm text-doodle-text/50">
                    ({orders.length} {orders.length === 1 ? 'order' : 'orders'})
                  </span>
                )}
              </div>

              {ordersLoading ? (
                <div className="text-center py-8">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-doodle-accent"></div>
                  <p className="font-doodle text-doodle-text/70 mt-4">Loading orders...</p>
                </div>
              ) : orders.length === 0 ? (
                <div className="text-center py-8">
                  <Package className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                  <p className="font-doodle text-doodle-text/70 mb-4">
                    You haven't placed any orders yet.
                  </p>
                  <Link to="/" className="doodle-button inline-block">
                    Start Shopping
                  </Link>
                </div>
              ) : (
                <div className="space-y-4">
                  {orders.map((order) => (
                    <div key={order.SalesOrderID} className="border-2 border-dashed border-doodle-text/20 p-4">
                      <button
                        onClick={() => setExpandedOrder(expandedOrder === order.SalesOrderID ? null : order.SalesOrderID)}
                        className="w-full flex items-center justify-between"
                      >
                        <div className="flex items-center gap-4">
                          <div className="text-left">
                            <div className="flex items-center gap-2">
                              <p className="font-doodle font-bold text-doodle-accent">
                                {order.SalesOrderNumber}
                              </p>
                              <span className={`text-xs px-2 py-1 rounded-full border ${getOrderStatusColor(order.Status)}`}>
                                {getOrderStatusText(order.Status)}
                              </span>
                            </div>
                            <p className="font-doodle text-sm text-doodle-text/70">
                              {new Date(order.OrderDate).toLocaleDateString('en-US', {
                                month: 'long',
                                day: 'numeric',
                                year: 'numeric'
                              })}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="font-doodle font-bold text-doodle-green">
                            ${order.TotalDue.toFixed(2)}
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
                            {order.salesOrderDetails.items.map((item, index) => (
                              <div key={`${item.ProductID}-${index}`} className="flex justify-between font-doodle text-sm">
                                <span className="text-doodle-text/70">
                                  {item.product.Name} × {item.OrderQty}
                                </span>
                                <span>${item.LineTotal.toFixed(2)}</span>
                              </div>
                            ))}
                          </div>

                          <hr className="border-dashed border-doodle-text/20 my-3" />

                          {/* Order Summary */}
                          <div className="space-y-1 font-doodle text-sm">
                            <div className="flex justify-between">
                              <span className="text-doodle-text/70">Subtotal</span>
                              <span>${order.SubTotal.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-doodle-text/70">Shipping</span>
                              <span>${order.Freight.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-doodle-text/70">Tax</span>
                              <span>${order.TaxAmt.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between font-bold text-base pt-2 border-t border-dashed border-doodle-text/20">
                              <span>Total</span>
                              <span className="text-doodle-green">${order.TotalDue.toFixed(2)}</span>
                            </div>
                          </div>

                          {order.Comment && (
                            <>
                              <hr className="border-dashed border-doodle-text/20 my-3" />
                              <div className="font-doodle text-sm">
                                <p className="font-bold text-doodle-text mb-1">Order Notes:</p>
                                <p className="text-doodle-text/70">{order.Comment}</p>
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
                  My Wishlist
                </h2>
                <span className="font-doodle text-sm text-doodle-text/50">
                  ({wishlistItems.length} {wishlistItems.length === 1 ? 'item' : 'items'})
                </span>
              </div>

              {wishlistItems.length === 0 ? (
                <div className="text-center py-8">
                  <Heart className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                  <p className="font-doodle text-doodle-text/70 mb-4">
                    Your wishlist is empty.
                  </p>
                  <Link to="/" className="doodle-button inline-block">
                    Browse Products
                  </Link>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {wishlistItems.map((item) => (
                    <div key={item.ProductID} className="border-2 border-dashed border-doodle-text/20 p-4 flex gap-4">
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
                          ${item.ListPrice.toFixed(2)}
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
                            Add to Cart
                          </button>
                          <button
                            onClick={() => removeFromWishlist(item.ProductID)}
                            className="doodle-button text-xs py-1 px-2 flex items-center gap-1"
                          >
                            <X className="w-3 h-3" />
                            Remove
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
                      Profile Settings
                    </h2>
                  </div>
                  {!isEditingProfile && (
                    <button
                      onClick={() => setIsEditingProfile(true)}
                      className="doodle-button text-sm py-1 px-3 flex items-center gap-2"
                    >
                      <Edit2 className="w-4 h-4" />
                      Edit
                    </button>
                  )}
                </div>

                {isEditingProfile ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          First Name
                        </label>
                        <input
                          type="text"
                          value={profileData.firstName}
                          onChange={(e) => {
                            setProfileData(prev => ({ ...prev, firstName: e.target.value }));
                            if (profileErrors.firstName) {
                              setProfileErrors(prev => ({ ...prev, firstName: '' }));
                            }
                          }}
                          className="doodle-input w-full"
                          placeholder="John"
                        />
                        {profileErrors.firstName && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">{profileErrors.firstName}</p>
                        )}
                      </div>
                      <div>
                        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                          Last Name
                        </label>
                        <input
                          type="text"
                          value={profileData.lastName}
                          onChange={(e) => {
                            setProfileData(prev => ({ ...prev, lastName: e.target.value }));
                            if (profileErrors.lastName) {
                              setProfileErrors(prev => ({ ...prev, lastName: '' }));
                            }
                          }}
                          className="doodle-input w-full"
                          placeholder="Doe"
                        />
                        {profileErrors.lastName && (
                          <p className="font-doodle text-xs text-doodle-accent mt-1">{profileErrors.lastName}</p>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
                        Email
                      </label>
                      <input
                        type="email"
                        value={profileData.email}
                        onChange={(e) => {
                          setProfileData(prev => ({ ...prev, email: e.target.value }));
                          if (profileErrors.email) {
                            setProfileErrors(prev => ({ ...prev, email: '' }));
                          }
                        }}
                        className="doodle-input w-full"
                        placeholder="john@example.com"
                      />
                      {profileErrors.email && (
                        <p className="font-doodle text-xs text-doodle-accent mt-1">{profileErrors.email}</p>
                      )}
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={async () => {
                          try {
                            profileSchema.parse(profileData);
                            setProfileErrors({});
                            setIsSaving(true);
                            const success = await updateProfile(
                              profileData.firstName.trim(),
                              profileData.lastName.trim(),
                              profileData.email.trim()
                            );
                            if (success) {
                              setIsEditingProfile(false);
                            }
                            setIsSaving(false);
                          } catch (error) {
                            if (error instanceof z.ZodError) {
                              const newErrors: Record<string, string> = {};
                              error.errors.forEach(err => {
                                if (err.path[0]) {
                                  newErrors[err.path[0] as string] = err.message;
                                }
                              });
                              setProfileErrors(newErrors);
                            }
                          }
                        }}
                        disabled={isSaving}
                        className="doodle-button doodle-button-primary py-2 px-4 flex items-center gap-2"
                      >
                        <Save className="w-4 h-4" />
                        {isSaving ? 'Saving...' : 'Save Changes'}
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingProfile(false);
                          setProfileErrors({});
                          if (user) {
                            setProfileData({
                              firstName: user.firstName,
                              lastName: user.lastName,
                              email: user.email,
                            });
                          }
                        }}
                        className="doodle-button py-2 px-4"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                      <span className="font-doodle text-sm text-doodle-text/70 sm:w-24">Name:</span>
                      <span className="font-doodle font-bold text-doodle-text">
                        {user?.firstName} {user?.lastName}
                      </span>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                      <span className="font-doodle text-sm text-doodle-text/70 sm:w-24">Email:</span>
                      <span className="font-doodle font-bold text-doodle-text">{user?.email}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Saved Addresses */}
              <div className="doodle-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <MapPin className="w-6 h-6 text-doodle-accent" />
                    <h2 className="font-doodle text-xl font-bold text-doodle-text">
                      Saved Addresses
                    </h2>
                    <span className="font-doodle text-sm text-doodle-text/50">
                      ({addresses.length} {addresses.length === 1 ? 'address' : 'addresses'})
                    </span>
                  </div>
                  {!showAddressForm && !editingAddress && (
                    <button
                      onClick={() => setShowAddressForm(true)}
                      className="doodle-button text-sm py-1 px-3 flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Add New
                    </button>
                  )}
                </div>

                {showAddressForm && (
                  <div className="mb-6 p-4 border-2 border-dashed border-doodle-accent/30 bg-doodle-accent/5">
                    <h3 className="font-doodle font-bold text-doodle-text mb-4">Add New Address</h3>
                    <AddressForm
                      onSave={(addressData) => {
                        addAddress(addressData);
                        setShowAddressForm(false);
                        toast({
                          title: "Address Added",
                          description: "Your new address has been saved.",
                        });
                      }}
                      onCancel={() => setShowAddressForm(false)}
                    />
                  </div>
                )}

                {editingAddress && (
                  <div className="mb-6 p-4 border-2 border-dashed border-doodle-accent/30 bg-doodle-accent/5">
                    <h3 className="font-doodle font-bold text-doodle-text mb-4">Edit Address</h3>
                    <AddressForm
                      address={editingAddress}
                      onSave={(addressData) => {
                        updateAddress(editingAddress.id, addressData);
                        setEditingAddress(null);
                        toast({
                          title: "Address Updated",
                          description: "Your address has been updated.",
                        });
                      }}
                      onCancel={() => setEditingAddress(null)}
                    />
                  </div>
                )}

                {addresses.length === 0 && !showAddressForm ? (
                  <div className="text-center py-8">
                    <MapPin className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                    <p className="font-doodle text-doodle-text/70 mb-4">
                      No saved addresses yet.
                    </p>
                    <button
                      onClick={() => setShowAddressForm(true)}
                      className="doodle-button doodle-button-primary inline-flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Add Your First Address
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {addresses.map((address) => (
                      <AddressCard
                        key={address.id}
                        address={address}
                        onEdit={(addr) => setEditingAddress(addr)}
                        onDelete={(id) => {
                          deleteAddress(id);
                          toast({
                            title: "Address Deleted",
                            description: "The address has been removed.",
                          });
                        }}
                        onSetDefault={(id) => {
                          setDefaultAddress(id);
                          toast({
                            title: "Default Address Updated",
                            description: "Your default address has been changed.",
                          });
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
                      Payment Methods
                    </h2>
                    <span className="font-doodle text-sm text-doodle-text/50">
                      ({paymentMethods.length} saved)
                    </span>
                  </div>
                </div>

                {paymentMethods.length === 0 ? (
                  <div className="text-center py-8">
                    <CreditCard className="w-16 h-16 mx-auto mb-4 text-doodle-text/30" />
                    <p className="font-doodle text-doodle-text/70 mb-4">
                      No saved payment methods yet.
                    </p>
                    <p className="font-doodle text-sm text-doodle-text/50">
                      Save a card during checkout to see it here.
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
                                Default
                              </span>
                            )}
                          </div>
                          <p className="font-doodle text-sm text-doodle-text/70">
                            {pm.cardholderName} • Expires {pm.cardExpiry}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {!pm.isDefault && (
                            <button
                              onClick={() => {
                                setDefaultPaymentMethod(pm.id);
                                toast({
                                  title: "Default Updated",
                                  description: "Your default payment method has been changed.",
                                });
                              }}
                              className="p-2 hover:bg-doodle-text/5 rounded transition-colors"
                              title="Set as default"
                            >
                              <Star className="w-4 h-4 text-doodle-text/70" />
                            </button>
                          )}
                          <button
                            onClick={() => {
                              deletePaymentMethod(pm.id);
                              toast({
                                title: "Payment Method Removed",
                                description: "The card has been removed from your account.",
                              });
                            }}
                            className="p-2 hover:bg-doodle-accent/10 rounded transition-colors"
                            title="Delete"
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
              <div className="doodle-card p-6 group cursor-pointer">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 doodle-border-light flex items-center justify-center group-hover:rotate-6 transition-transform">
                    <Settings className="w-6 h-6 text-doodle-text" />
                  </div>
                  <div>
                    <h2 className="font-doodle text-xl font-bold text-doodle-text group-hover:text-doodle-accent transition-colors">
                      Account Settings
                    </h2>
                    <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                      Password & security
                    </p>
                    <span className="font-doodle text-xs text-doodle-accent mt-2 inline-block">
                      Coming soon!
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Sign Out */}
            <div className="mt-8 text-center">
              <button
                onClick={logout}
                className="doodle-button inline-flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
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
