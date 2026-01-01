import React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Heart, Trash2, ShoppingCart } from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useWishlist } from "@/context/WishlistContext";
import { useCart } from "@/context/CartContext";
import { useAuth } from "@/context/AuthContext";
import { getSalePrice } from "@/types/product";
import { useCurrency } from "@/context/CurrencyContext";

const WishlistPage: React.FC = () => {
  const { t } = useTranslation("common");
  const { items, removeFromWishlist, clearWishlist } = useWishlist();
  const { addToCart } = useCart();
  const { user } = useAuth();
  const { formatPrice } = useCurrency();

  const handleAddToCart = (product: (typeof items)[0]) => {
    addToCart(product);
  };

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="text-center max-w-md mx-auto">
            <span className="text-6xl mb-4 block">💝</span>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              {t("wishlist.signInToViewWishlist")}
            </h1>
            <p className="font-doodle text-doodle-text/70 mb-6">
              {t("wishlist.createAccountOrSignIn")}
            </p>
            <Link to="/auth" className="doodle-button doodle-button-primary">
              {t("wishlist.signIn")}
            </Link>
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
          <div className="text-center max-w-md mx-auto">
            <span className="text-6xl mb-4 block">💝</span>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              {t("wishlist.yourWishlistIsEmpty")}
            </h1>
            <p className="font-doodle text-doodle-text/70 mb-6">
              {t("wishlist.startAddingProducts")}
            </p>
            <Link to="/" className="doodle-button doodle-button-primary">
              {t("wishlist.startShopping")}
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Heart className="w-8 h-8 text-doodle-accent" />
            <h1 className="font-doodle text-3xl font-bold text-doodle-text">
              {t("wishlist.myWishlist")}
            </h1>
            <span className="font-doodle text-sm text-doodle-text/60">
              ({items.length}{" "}
              {items.length === 1 ? t("wishlist.item") : t("wishlist.items")})
            </span>
          </div>
          {items.length > 0 && (
            <button
              onClick={clearWishlist}
              className="doodle-button text-sm flex items-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              {t("wishlist.clearAll")}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {items.map((product) => {
            const salePrice = getSalePrice(product);
            return (
              <div
                key={product.ProductID}
                className="doodle-card p-4 relative group"
              >
                {/* Sale Badge */}
                {product.DiscountPct && (
                  <div className="absolute top-6 left-6 z-10 bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-3deg]">
                    {Math.round(product.DiscountPct * 100)}% {t("wishlist.off")}
                  </div>
                )}

                {/* Remove Button */}
                <button
                  onClick={() => removeFromWishlist(product.ProductID)}
                  className="absolute top-6 right-6 z-10 p-2 border-2 bg-doodle-accent border-doodle-accent text-white hover:bg-doodle-text hover:border-doodle-text transition-all"
                  aria-label={t("wishlist.removeFromWishlist")}
                >
                  <Heart className="w-4 h-4 fill-current" />
                </button>

                {/* Product Image */}
                <Link to={`/product/${product.ProductID}`}>
                  <div className="aspect-square mb-4 bg-doodle-bg border-2 border-doodle-text border-dashed flex items-center justify-center overflow-hidden">
                    <div className="text-center p-4">
                      <span className="font-doodle text-4xl">🚴</span>
                      <p className="font-doodle text-xs text-doodle-text/60 mt-2">
                        {product.Color || t("wishlist.productImage")}
                      </p>
                    </div>
                  </div>
                </Link>

                {/* Product Info */}
                <div className="space-y-2">
                  <Link to={`/product/${product.ProductID}`}>
                    <h3 className="font-doodle text-lg font-bold text-doodle-text hover:text-doodle-accent transition-colors line-clamp-2">
                      {product.Name}
                    </h3>
                  </Link>

                  <div className="flex items-center gap-2 flex-wrap">
                    {product.Color && (
                      <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                        {product.Color}
                      </span>
                    )}
                    {product.Size && (
                      <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                        {t("wishlist.size")}: {product.Size}
                      </span>
                    )}
                  </div>

                  <div className="flex items-end justify-between pt-2">
                    <div className="flex flex-col">
                      {salePrice ? (
                        <>
                          <span className="font-doodle text-sm text-doodle-text/50 line-through">
                            {formatPrice(product.ListPrice)}
                          </span>
                          <span className="font-doodle text-xl font-bold text-doodle-accent">
                            {formatPrice(salePrice)}
                          </span>
                        </>
                      ) : (
                        <span className="font-doodle text-xl font-bold text-doodle-green">
                          {formatPrice(product.ListPrice)}
                        </span>
                      )}
                    </div>

                    <button
                      onClick={() => handleAddToCart(product)}
                      className="doodle-button doodle-button-primary p-2 text-sm flex items-center gap-1"
                      aria-label={t("wishlist.addToCart")}
                    >
                      <ShoppingCart className="w-4 h-4" />
                      <span className="hidden sm:inline">
                        {t("wishlist.add")}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default WishlistPage;
