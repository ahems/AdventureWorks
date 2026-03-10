import React, { useEffect } from "react";
import { trackEvent } from "@/lib/appInsights";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ShoppingCart,
  Minus,
  Plus,
  Star,
  Truck,
  Shield,
  RotateCcw,
  Bell,
  Heart,
} from "lucide-react";
import { Twemoji } from "@/components/Twemoji";
import {
  SEO,
  generateProductStructuredData,
  generateBreadcrumbStructuredData,
} from "@/components/SEO";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProductReviews from "@/components/ProductReviews";
import RecentlyViewed from "@/components/RecentlyViewed";
import ProductImageGallery from "@/components/ProductImageGallery";
import NotifyWhenAvailable from "@/components/NotifyWhenAvailable";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { useRecentlyViewed } from "@/context/RecentlyViewedContext";
import { useLanguage } from "@/context/LanguageContext";
import { useProductNames } from "@/context/ProductNamesContext";
import { useCurrency } from "@/context/CurrencyContext";
import { useUnitMeasure } from "@/context/UnitMeasureContext";
import { useProduct, useSubcategory, useCategory } from "@/hooks/useProducts";
import { getSalePrice, isVariantAvailable } from "@/types/product";
import { useReviews } from "@/hooks/useReviews";
import { toast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ProductPage: React.FC = () => {
  const { t } = useTranslation(["product", "common"]);
  const { productId } = useParams<{ productId: string }>();
  const { addToCart } = useCart();
  const { addToWishlist, removeFromWishlist, isInWishlist } = useWishlist();
  const { addToRecentlyViewed } = useRecentlyViewed();
  const { selectedLanguage } = useLanguage();
  const { formatPrice } = useCurrency();
  const { formatWeight, formatSize } = useUnitMeasure();
  const { getLocalizedName } = useProductNames();
  const [quantity, setQuantity] = React.useState(1);
  const [selectedSize, setSelectedSize] = React.useState<string | undefined>(
    undefined,
  );
  const [selectedColor, setSelectedColor] = React.useState<string | undefined>(
    undefined,
  );

  const { data: product, isLoading: productLoading } = useProduct(
    productId ? parseInt(productId) : 0,
    selectedLanguage,
  );
  const { data: subcategory } = useSubcategory(
    product?.ProductSubcategoryID || 0,
  );
  const { data: category } = useCategory(
    subcategory?.ProductCategoryID || 0,
    selectedLanguage,
  );

  const inWishlist = product ? isInWishlist(product.ProductID) : false;
  const salePrice = product ? getSalePrice(product) : null;
  const { averageRating, reviewCount } = useReviews(product?.ProductID || 0);
  const localizedName = product
    ? (getLocalizedName(product.ProductID) ?? product.Name)
    : "";

  // Check if this is a clothing item with variants
  const hasVariants = product?.availableSizes || product?.availableColors;
  const isClothing = category?.ProductCategoryID === 3; // Clothing category

  // Check if current selection is available
  const currentVariantAvailable = product
    ? isVariantAvailable(product, selectedSize, selectedColor)
    : true;

  // Generate breadcrumb structured data - MUST be before any conditional renders
  const breadcrumbData = React.useMemo(() => {
    if (!product) return null;

    const items = [
      { name: t("common:navigation.home"), url: window.location.origin },
    ];

    if (category) {
      items.push({
        name: category.Name,
        url: `${window.location.origin}/category/${category.ProductCategoryID}`,
      });
    }

    items.push({
      name: getLocalizedName(product.ProductID) ?? product.Name,
      url: window.location.href,
    });

    return generateBreadcrumbStructuredData(items);
  }, [product, category, t]);

  // Generate product structured data - MUST be before any conditional renders
  const productStructuredData = React.useMemo(() => {
    if (!product) return null;

    const price = salePrice || product.ListPrice;

    return generateProductStructuredData({
      name: getLocalizedName(product.ProductID) ?? product.Name,
      description: product.Description || product.Name,
      image: product.ThumbNailPhoto || "",
      price: price,
      sku: product.ProductNumber,
      availability:
        product.Stock && product.Stock > 0 ? "InStock" : "OutOfStock",
    });
  }, [product, salePrice]);

  // Add to recently viewed when product loads
  useEffect(() => {
    if (product) {
      addToRecentlyViewed(product);

      // Track product view in Application Insights
      trackEvent("Product_View", {
        productId: product.ProductID,
        productName: localizedName,
        category: product.ProductSubcategory?.ProductCategory?.Name,
        subcategory: product.ProductSubcategory?.Name,
        price: product.ListPrice,
      });
    }
  }, [product, addToRecentlyViewed]);

  if (productLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">
          {/* Breadcrumb Skeleton */}
          <div className="container mx-auto px-4 py-4">
            <div className="flex gap-2 items-center">
              <div className="h-4 w-12 bg-doodle-text/10 animate-pulse"></div>
              <div className="h-4 w-1">/</div>
              <div className="h-4 w-24 bg-doodle-text/10 animate-pulse"></div>
              <div className="h-4 w-1">/</div>
              <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
            </div>
          </div>

          {/* Product Details Skeleton */}
          <section className="container mx-auto px-4 pb-12">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
              {/* Image Gallery Skeleton */}
              <div className="space-y-4">
                <div className="doodle-card aspect-square w-full bg-doodle-text/10 animate-pulse"></div>
                <div className="grid grid-cols-4 gap-2">
                  {[...Array(4)].map((_, i) => (
                    <div
                      key={i}
                      className="doodle-card aspect-square bg-doodle-text/10 animate-pulse"
                    ></div>
                  ))}
                </div>
              </div>

              {/* Product Info Skeleton */}
              <div className="space-y-6">
                {/* Title */}
                <div className="space-y-2">
                  <div className="h-4 w-24 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-10 w-3/4 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
                </div>

                {/* Price */}
                <div className="doodle-border-light inline-block px-6 py-3">
                  <div className="h-8 w-24 bg-doodle-text/10 animate-pulse"></div>
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <div className="h-4 w-full bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-full bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-2/3 bg-doodle-text/10 animate-pulse"></div>
                </div>

                {/* Stock Status */}
                <div className="doodle-card p-4">
                  <div className="h-6 w-32 bg-doodle-text/10 animate-pulse"></div>
                </div>

                {/* Specs */}
                <div className="doodle-card p-4 space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="flex justify-between">
                      <div className="h-4 w-24 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                  ))}
                </div>

                {/* Add to Cart */}
                <div className="doodle-card p-6">
                  <div className="h-12 w-full bg-doodle-text/10 animate-pulse"></div>
                </div>
              </div>
            </div>

            {/* Reviews Section Skeleton */}
            <div className="mt-12 space-y-6">
              <div className="h-8 w-48 bg-doodle-text/10 animate-pulse"></div>
              {[...Array(3)].map((_, i) => (
                <div key={i} className="doodle-card p-6 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="h-6 w-24 bg-doodle-text/10 animate-pulse"></div>
                    <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
                  </div>
                  <div className="h-4 w-full bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-full bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-1/2 bg-doodle-text/10 animate-pulse"></div>
                </div>
              ))}
            </div>
          </section>
        </main>
        <Footer />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="text-center">
            <span className="text-6xl mb-4 block">🔍</span>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              {t("product:productPage.notFound")}
            </h1>
            <Link to="/" className="doodle-button doodle-button-primary">
              {t("common:buttons.backToHome")}
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const handleAddToCart = () => {
    // Validate size and color selection for clothing items
    if (hasVariants) {
      if (product.availableSizes && !selectedSize) {
        toast({
          title: t("product:productPage.selectSize"),
          description: t("product:productPage.selectSizeDesc"),
          variant: "destructive",
        });
        return;
      }
      if (product.availableColors && !selectedColor) {
        toast({
          title: t("product:productPage.selectColor"),
          description: t("product:productPage.selectColorDesc"),
          variant: "destructive",
        });
        return;
      }
      // Check if the selected combination is available
      if (!isVariantAvailable(product, selectedSize, selectedColor)) {
        toast({
          title: t("product:productPage.unavailable"),
          description: t("product:productPage.unavailableDesc"),
          variant: "destructive",
        });
        return;
      }
    }
    addToCart(product, quantity, selectedSize, selectedColor);
  };

  const handleToggleWishlist = () => {
    if (!product) return;
    if (inWishlist) {
      removeFromWishlist(product.ProductID);
    } else {
      addToWishlist(product);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {product && (
        <SEO
          title={`${localizedName} | Adventure Works`}
          description={
            product.Description ||
            `Buy ${localizedName} at Adventure Works. Premium quality outdoor adventure and sports gear.`
          }
          image={product.ThumbNailPhoto}
          type="product"
          structuredData={[breadcrumbData, productStructuredData]}
        />
      )}
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-wrap items-center gap-2 font-doodle text-sm text-doodle-text/70">
            <Link to="/" className="hover:text-doodle-accent transition-colors">
              {t("common:navigation.home")}
            </Link>
            <span>/</span>
            {category && (
              <>
                <Link
                  to={`/category/${category.ProductCategoryID}`}
                  className="hover:text-doodle-accent transition-colors"
                >
                  {category.Name}
                </Link>
                <span>/</span>
              </>
            )}
            <span className="text-doodle-text">{localizedName}</span>
          </div>
        </div>

        {/* Product Details */}
        <section className="container mx-auto px-4 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
            {/* Product Image Gallery */}
            <ProductImageGallery
              productName={localizedName}
              color={selectedColor || product.Color}
              thumbnailPhoto={product.ThumbNailPhoto}
              productPhotos={product.productPhotos}
            />

            {/* Product Info */}
            <div className="space-y-6">
              {/* Title & Price */}
              <div>
                <div className="flex items-center gap-3">
                  {subcategory && (
                    <span className="font-doodle text-sm text-doodle-accent uppercase tracking-wide">
                      {subcategory.Name}
                    </span>
                  )}
                  {product.DiscountPct && (
                    <span className="bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-2deg]">
                      {product.SpecialOfferDescription ||
                        t("product:productPage.limitedOffer")}
                    </span>
                  )}
                </div>
                <h1
                  className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mt-1"
                  data-testid="product-name"
                >
                  {localizedName}
                </h1>
                <div className="flex items-center gap-3 mt-2">
                  <div className="flex items-center gap-1 text-doodle-accent">
                    {[...Array(5)].map((_, i) => (
                      <Star
                        key={i}
                        className={`w-4 h-4 ${
                          i < Math.round(averageRating)
                            ? "fill-current"
                            : "text-doodle-text/20"
                        }`}
                      />
                    ))}
                  </div>
                  <span className="font-doodle text-sm text-doodle-text/60">
                    {averageRating > 0
                      ? t("product:reviews.ratingCount", {
                          rating: averageRating.toFixed(1),
                          count: reviewCount,
                        })
                      : t("product:reviews.noReviews")}
                  </span>
                </div>
              </div>

              {/* Price */}
              <div
                className="doodle-border-light inline-block px-6 py-3"
                data-testid="product-price"
              >
                {salePrice ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-3">
                      <span className="font-doodle text-xl text-doodle-text/50 line-through">
                        {formatPrice(product.ListPrice)}
                      </span>
                      <span className="font-doodle text-3xl font-bold text-doodle-accent">
                        {formatPrice(salePrice)}
                      </span>
                    </div>
                    <span className="font-doodle text-sm text-doodle-green font-bold">
                      {t("product:productPage.save", {
                        percent: Math.round(product.DiscountPct * 100),
                      })}
                    </span>
                  </div>
                ) : (
                  <span className="font-doodle text-3xl font-bold text-doodle-green">
                    {formatPrice(product.ListPrice)}
                  </span>
                )}
              </div>

              {/* Description */}
              <p
                className="font-doodle text-lg text-doodle-text/80 leading-relaxed"
                data-testid="product-description"
              >
                {product.Description || t("product:productPage.defaultDesc")}
              </p>

              {/* Specs */}
              {/* Stock Status */}
              <div
                className={`doodle-card p-4 ${
                  product.inStock
                    ? "bg-green-50 border-green-300"
                    : "bg-red-50 border-red-300"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`${
                      product.inStock ? "" : "grayscale opacity-50"
                    }`}
                  >
                    <Twemoji
                      emoji={product.inStock ? "✅" : "❌"}
                      size="2rem"
                    />
                  </div>
                  <div className="flex-1">
                    <h3
                      className={`font-doodle font-bold ${
                        product.inStock ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {product.inStock
                        ? t("product:productPage.inStock")
                        : t("product:productPage.outOfStock")}
                    </h3>
                    {product.quantityAvailable !== undefined && (
                      <p className="font-doodle text-sm text-doodle-text/70">
                        {product.inStock
                          ? t("product:productPage.unitsAvailable", {
                              count: product.quantityAvailable,
                            })
                          : t("product:productPage.currentlyUnavailable")}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="doodle-card p-4 space-y-2">
                <h3 className="font-doodle font-bold text-doodle-text">
                  {t("product:specifications.title")}
                </h3>
                <div className="grid grid-cols-2 gap-2 font-doodle text-sm">
                  <span className="text-doodle-text/60">
                    {t("product:specifications.sku")}
                  </span>
                  <span className="text-doodle-text">
                    {product.ProductNumber}
                  </span>

                  {product.Color && !hasVariants && (
                    <>
                      <span className="text-doodle-text/60">
                        {t("product:specifications.color")}
                      </span>
                      <span className="text-doodle-text">{product.Color}</span>
                    </>
                  )}
                  {product.Size && !hasVariants && (
                    <>
                      <span className="text-doodle-text/60">
                        {t("product:specifications.size")}
                      </span>
                      <span className="text-doodle-text">
                        {formatSize(product.Size, product.SizeUnitMeasureCode)}
                      </span>
                    </>
                  )}
                  {product.Weight && (
                    <>
                      <span className="text-doodle-text/60">
                        {t("product:specifications.weight")}
                      </span>
                      <span className="text-doodle-text">
                        {formatWeight(
                          product.Weight,
                          product.WeightUnitMeasureCode,
                        )}
                      </span>
                    </>
                  )}
                  {product.ProductLine && (
                    <>
                      <span className="text-doodle-text/60">
                        {t("product:specifications.productLine")}
                      </span>
                      <span className="text-doodle-text">
                        {product.ProductLine}
                      </span>
                    </>
                  )}
                  {product.Class && (
                    <>
                      <span className="text-doodle-text/60">
                        {t("product:specifications.class")}
                      </span>
                      <span className="text-doodle-text">{product.Class}</span>
                    </>
                  )}
                  {product.Style && (
                    <>
                      <span className="text-doodle-text/60">
                        {t("product:specifications.style")}
                      </span>
                      <span className="text-doodle-text">{product.Style}</span>
                    </>
                  )}
                  {product.SellStartDate && (
                    <>
                      <span className="text-doodle-text/60">
                        {t("product:specifications.dateFirstAvailable")}
                      </span>
                      <span className="text-doodle-text">
                        {new Date(product.SellStartDate).toLocaleDateString(
                          "en-US",
                          {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          },
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Size Selection Dropdown */}
              {product.availableSizes && (
                <div className="space-y-3">
                  <h3 className="font-doodle font-bold text-doodle-text">
                    {t("product:productPage.size")}{" "}
                    <span className="text-doodle-accent">*</span>
                  </h3>
                  <Select value={selectedSize} onValueChange={setSelectedSize}>
                    <SelectTrigger className="w-full max-w-xs font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent">
                      <SelectValue
                        placeholder={t(
                          "product:productPage.selectSizePlaceholder",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent className="bg-white border-2 border-doodle-text">
                      {product.availableSizes.map((size) => (
                        <SelectItem
                          key={size}
                          value={size}
                          className="font-doodle cursor-pointer hover:bg-doodle-accent/10"
                        >
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Color Selection for Clothing */}
              {product.availableColors && (
                <div className="space-y-3">
                  <h3 className="font-doodle font-bold text-doodle-text">
                    {t("product:productPage.color")}{" "}
                    <span className="text-doodle-accent">*</span>
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {product.availableColors.map((color) => (
                      <button
                        key={color}
                        onClick={() => setSelectedColor(color)}
                        className={`font-doodle px-4 py-2 border-2 transition-all ${
                          selectedColor === color
                            ? "border-doodle-accent bg-doodle-accent text-white"
                            : "border-doodle-text hover:border-doodle-accent hover:bg-doodle-accent/10"
                        }`}
                      >
                        {color}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Availability Warning with Notify Button */}
              {hasVariants &&
                selectedSize &&
                selectedColor &&
                !currentVariantAvailable && (
                  <div className="bg-doodle-accent/10 border-2 border-dashed border-doodle-accent p-4 space-y-3">
                    <div>
                      <p className="font-doodle text-doodle-accent font-bold flex items-center gap-2">
                        ⚠️ {t("product:productPage.currentlyUnavailableTitle")}
                      </p>
                      <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                        {t("product:productPage.variantUnavailableDesc")}
                      </p>
                    </div>
                    <NotifyWhenAvailable
                      productName={localizedName}
                      size={selectedSize}
                      color={selectedColor}
                      trigger={
                        <button className="doodle-button flex items-center gap-2 text-sm">
                          <Bell className="w-4 h-4" />
                          {t("product:productPage.notifyMe")}
                        </button>
                      }
                    />
                  </div>
                )}

              {/* Quantity & Add to Cart */}
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex items-center doodle-border-light">
                  <button
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    className="p-3 hover:bg-doodle-text/10 transition-colors"
                    aria-label={t("cart.decreaseQuantity")}
                  >
                    <Minus className="w-5 h-5" />
                  </button>
                  <span className="font-doodle text-xl font-bold px-6 min-w-[60px] text-center">
                    {quantity}
                  </span>
                  <button
                    onClick={() => setQuantity(quantity + 1)}
                    className="p-3 hover:bg-doodle-text/10 transition-colors"
                    aria-label={t("cart.increaseQuantity")}
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>

                <button
                  onClick={handleAddToCart}
                  disabled={
                    !product.inStock ||
                    (hasVariants &&
                      selectedSize &&
                      selectedColor &&
                      !currentVariantAvailable)
                  }
                  className={`flex-1 flex items-center justify-center gap-2 text-lg py-3 ${
                    !product.inStock ||
                    (hasVariants &&
                      selectedSize &&
                      selectedColor &&
                      !currentVariantAvailable)
                      ? "doodle-button bg-doodle-text/20 text-doodle-text/50 cursor-not-allowed border-doodle-text/30"
                      : "doodle-button doodle-button-primary"
                  }`}
                  data-testid="add-to-cart-button"
                >
                  <ShoppingCart className="w-5 h-5" />
                  {!product.inStock
                    ? t("product:productPage.outOfStock")
                    : hasVariants &&
                        selectedSize &&
                        selectedColor &&
                        !currentVariantAvailable
                      ? t("product:productPage.unavailable")
                      : t("product:productPage.addToCart")}
                </button>

                <button
                  onClick={handleToggleWishlist}
                  className={`p-3 border-2 transition-all ${
                    inWishlist
                      ? "bg-doodle-accent border-doodle-accent text-white"
                      : "border-doodle-text hover:border-doodle-accent hover:text-doodle-accent"
                  }`}
                  aria-label={
                    inWishlist
                      ? t("product:productPage.removeFromWishlist")
                      : t("product:productPage.addToWishlist")
                  }
                >
                  <Heart
                    className={`w-5 h-5 ${inWishlist ? "fill-current" : ""}`}
                  />
                </button>
              </div>

              {/* Benefits */}
              <div className="grid grid-cols-3 gap-4 pt-4 border-t-2 border-dashed border-doodle-text/20">
                <div className="text-center">
                  <Truck className="w-6 h-6 mx-auto mb-2 text-doodle-green" />
                  <span className="font-doodle text-xs text-doodle-text/70">
                    {t("product:productPage.freeShipping")}
                  </span>
                </div>
                <div className="text-center">
                  <Shield className="w-6 h-6 mx-auto mb-2 text-doodle-green" />
                  <span className="font-doodle text-xs text-doodle-text/70">
                    {t("product:productPage.warranty")}
                  </span>
                </div>
                <div className="text-center">
                  <RotateCcw className="w-6 h-6 mx-auto mb-2 text-doodle-green" />
                  <span className="font-doodle text-xs text-doodle-text/70">
                    {t("product:productPage.returns")}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Reviews Section */}
        <ProductReviews productId={product.ProductID} />

        {/* Recently Viewed */}
        <RecentlyViewed currentProductId={product.ProductID} />

        {/* Back Button */}
        <section className="container mx-auto px-4 pb-12">
          <Link
            to={category ? `/category/${category.ProductCategoryID}` : "/"}
            className="doodle-button inline-flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("product:productPage.backTo")}{" "}
            {category?.Name || t("common:navigation.home")}
          </Link>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ProductPage;
