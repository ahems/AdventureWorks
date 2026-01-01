import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Twemoji } from "@/components/Twemoji";
import {
  ArrowLeft,
  Trash2,
  Minus,
  Plus,
  ShoppingBag,
  Tag,
  Heart,
} from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { getSalePrice } from "@/types/product";
import { useCurrency } from "@/context/CurrencyContext";

const CartPage: React.FC = () => {
  const { t } = useTranslation(["cart", "common"]);
  const { items, isLoading, updateQuantity, removeFromCart, clearCart } =
    useCart();
  const { addToWishlist, isInWishlist } = useWishlist();
  const { formatPrice } = useCurrency();

  // Calculate totals with sale prices
  const { subtotalBeforeDiscount, totalAfterDiscount, totalDiscount } =
    useMemo(() => {
      let beforeDiscount = 0;
      let afterDiscount = 0;

      items.forEach((item) => {
        const originalTotal = item.ListPrice * item.quantity;
        const salePrice = getSalePrice(item);
        const discountedTotal = salePrice
          ? salePrice * item.quantity
          : originalTotal;

        beforeDiscount += originalTotal;
        afterDiscount += discountedTotal;
      });

      return {
        subtotalBeforeDiscount: beforeDiscount,
        totalAfterDiscount: afterDiscount,
        totalDiscount: beforeDiscount - afterDiscount,
      };
    }, [items]);

  const shipping = totalAfterDiscount > 50 ? 0 : 9.99;
  const grandTotal = totalAfterDiscount + shipping;

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-8">
            {t("cart:cart.title")}
          </h1>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Cart items skeleton */}
            <div className="lg:col-span-2 space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="doodle-card p-6">
                  <div className="flex gap-6">
                    <div className="w-24 h-24 bg-doodle-text/10 animate-pulse"></div>
                    <div className="flex-1 space-y-3">
                      <div className="h-6 w-3/4 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-4 w-1/2 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-8 w-32 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Summary skeleton */}
            <div className="lg:col-span-1">
              <div className="doodle-card p-6 space-y-4">
                <div className="h-8 w-32 bg-doodle-text/10 animate-pulse"></div>
                <div className="space-y-3">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex justify-between">
                      <div className="h-4 w-20 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-4 w-16 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                  ))}
                </div>
                <div className="h-12 w-full bg-doodle-text/10 animate-pulse"></div>
              </div>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <div className="doodle-card p-12">
              <ShoppingBag className="w-20 h-20 mx-auto mb-6 text-doodle-text/40" />
              <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
                {t("cart:cart.empty")}
              </h1>
              <p className="font-doodle text-doodle-text/70 mb-8">
                {t("cart:cart.emptyDesc")}
              </p>
              <Link
                to="/"
                className="doodle-button doodle-button-primary inline-flex items-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                {t("cart:cart.startShopping")}
              </Link>
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
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("cart:cart.continueShopping")}
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-8">
            {t("cart:cart.title")}
          </h1>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Cart Items */}
            <div className="lg:col-span-2 space-y-4">
              {items.map((item, index) => (
                <div
                  key={`${item.ProductID}-${item.selectedSize}-${item.selectedColor}-${index}`}
                  className="doodle-card p-4 md:p-6"
                >
                  <div className="flex gap-4">
                    {/* Product Image */}
                    <div className="w-24 h-24 flex-shrink-0 bg-doodle-bg border-2 border-dashed border-doodle-text flex items-center justify-center">
                      <span className="text-3xl">🚴</span>
                    </div>

                    {/* Product Details */}
                    <div className="flex-1 min-w-0">
                      <Link
                        to={`/product/${item.ProductID}`}
                        className="font-doodle font-bold text-lg text-doodle-text hover:text-doodle-accent transition-colors line-clamp-1"
                      >
                        {item.Name}
                      </Link>

                      <div className="flex flex-wrap gap-2 mt-1">
                        {item.selectedColor && (
                          <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-accent/20 border border-doodle-accent/50">
                            {item.selectedColor}
                          </span>
                        )}
                        {item.selectedSize && (
                          <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-accent/20 border border-doodle-accent/50">
                            {t("cart:cart.size")}: {item.selectedSize}
                          </span>
                        )}
                        {item.Color && !item.selectedColor && (
                          <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                            {item.Color}
                          </span>
                        )}
                        {item.Size && !item.selectedSize && (
                          <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                            {t("cart:cart.size")}: {item.Size}
                          </span>
                        )}
                      </div>

                      {/* Price with discount display */}
                      {item.DiscountPct ? (
                        <div className="mt-2">
                          <div className="flex items-center gap-2">
                            <span className="font-doodle text-sm text-doodle-text/50 line-through">
                              {formatPrice(item.ListPrice)}
                            </span>
                            <span className="font-doodle text-lg font-bold text-doodle-accent">
                              {formatPrice(
                                getSalePrice(item) || item.ListPrice
                              )}
                            </span>
                          </div>
                          <span className="font-doodle text-xs text-doodle-green font-bold flex items-center gap-1">
                            <Tag className="w-3 h-3" />
                            {t("cart:cart.save", {
                              percent: Math.round(item.DiscountPct * 100),
                            })}
                          </span>
                        </div>
                      ) : (
                        <p className="font-doodle text-lg font-bold text-doodle-green mt-2">
                          {formatPrice(item.ListPrice)}
                        </p>
                      )}
                    </div>

                    {/* Quantity & Remove */}
                    <div className="flex flex-col items-end gap-3">
                      <div className="flex items-center gap-1">
                        {/* Move to Wishlist */}
                        <button
                          onClick={() => {
                            if (!isInWishlist(item.ProductID)) {
                              addToWishlist(item);
                            }
                            removeFromCart(
                              item.ProductID,
                              item.selectedSize,
                              item.selectedColor
                            );
                          }}
                          className="text-doodle-text/50 hover:text-doodle-accent transition-colors p-1"
                          aria-label={t("cart:cart.moveToWishlist")}
                          title={t("cart:cart.saveLater")}
                        >
                          <Heart className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() =>
                            removeFromCart(
                              item.ProductID,
                              item.selectedSize,
                              item.selectedColor
                            )
                          }
                          className="text-doodle-text/50 hover:text-doodle-accent transition-colors p-1"
                          aria-label={t("cart.removeItem")}
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>

                      <div className="flex items-center doodle-border-light">
                        <button
                          onClick={() =>
                            updateQuantity(
                              item.ProductID,
                              item.quantity - 1,
                              item.selectedSize,
                              item.selectedColor
                            )
                          }
                          className="p-1.5 hover:bg-doodle-text/10 transition-colors"
                          aria-label={t("cart.decreaseQuantity")}
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <span className="font-doodle font-bold px-3 min-w-[40px] text-center">
                          {item.quantity}
                        </span>
                        <button
                          onClick={() =>
                            updateQuantity(
                              item.ProductID,
                              item.quantity + 1,
                              item.selectedSize,
                              item.selectedColor
                            )
                          }
                          className="p-1.5 hover:bg-doodle-text/10 transition-colors"
                          aria-label={t("cart.increaseQuantity")}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>

                      <p className="font-doodle text-sm text-doodle-text/70">
                        Subtotal:{" "}
                        <span className="font-bold">
                          {formatPrice(
                            (getSalePrice(item) || item.ListPrice) *
                              item.quantity
                          )}
                        </span>
                      </p>
                    </div>
                  </div>
                </div>
              ))}

              {/* Cart Actions */}
              <div className="flex flex-wrap gap-4">
                <button
                  onClick={() => {
                    items.forEach((item) => {
                      if (!isInWishlist(item.ProductID)) {
                        addToWishlist(item);
                      }
                    });
                    clearCart();
                  }}
                  className="font-doodle text-sm text-doodle-text/70 hover:text-doodle-accent transition-colors inline-flex items-center gap-1"
                >
                  <Heart className="w-4 h-4" />
                  {t("cart:cart.moveAllToWishlist")}
                </button>
                <button
                  onClick={clearCart}
                  className="font-doodle text-sm text-doodle-accent hover:text-doodle-text transition-colors"
                >
                  {t("cart:cart.clearCart")}
                </button>
              </div>
            </div>

            {/* Order Summary */}
            <div className="lg:col-span-1">
              <div className="doodle-card p-6 sticky top-24">
                <h2 className="font-doodle text-xl font-bold text-doodle-text mb-6">
                  {t("cart:checkout.orderSummary")}
                </h2>

                <div className="space-y-4 font-doodle">
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">Subtotal</span>
                    <span className="font-bold">
                      {formatPrice(subtotalBeforeDiscount)}
                    </span>
                  </div>

                  {/* Discount Line */}
                  {totalDiscount > 0 && (
                    <div className="flex justify-between text-doodle-green">
                      <span className="flex items-center gap-1">
                        <Tag className="w-4 h-4" />
                        Discounts
                      </span>
                      <span className="font-bold">
                        -{formatPrice(totalDiscount)}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">Shipping</span>
                    <span
                      className={
                        shipping === 0 ? "text-doodle-green font-bold" : ""
                      }
                    >
                      {shipping === 0 ? "FREE" : formatPrice(shipping)}
                    </span>
                  </div>
                  {shipping > 0 && (
                    <p className="text-xs text-doodle-accent">
                      Add {formatPrice(50 - totalAfterDiscount)} more for FREE
                      shipping!
                    </p>
                  )}

                  <hr className="border-dashed border-doodle-text/30" />

                  <div className="flex justify-between text-xl">
                    <span className="font-bold">Total</span>
                    <span className="font-bold text-doodle-green">
                      {formatPrice(grandTotal)}
                    </span>
                  </div>

                  {totalDiscount > 0 && (
                    <p className="text-xs text-doodle-green text-center font-bold bg-doodle-green/10 py-2 border border-dashed border-doodle-green/30 flex items-center justify-center gap-1">
                      <Twemoji emoji="🎉" size="1rem" /> You're saving{" "}
                      {formatPrice(totalDiscount)} on this order!
                    </p>
                  )}
                </div>

                <Link
                  to="/checkout"
                  className="doodle-button doodle-button-primary w-full mt-6 py-3 text-lg block text-center"
                >
                  Proceed to Checkout
                </Link>

                <p className="font-doodle text-center text-xs text-doodle-text/50 mt-4">
                  Secure checkout • SSL Encrypted
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default CartPage;
