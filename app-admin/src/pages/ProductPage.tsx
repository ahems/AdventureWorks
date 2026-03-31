import React, { useState, useEffect } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { ArrowLeft, Star, Save, Tag, ExternalLink, Globe } from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import ProductImageGallery from "@/components/ProductImageGallery";
import AiImageGeneratorDialog from "@/components/AiImageGeneratorDialog";
import { useAuth } from "@/context/AuthContext";
import {
  useAdminProductById,
  useAdminCategoryById,
  useAdminAllSubcategories,
  useAdminCategories,
  useAdminSubcategoriesByCategory,
  useAdminProductEnglishDescription,
  useUpdateProduct,
  useUpdateProductDescription,
  useProductInventory,
  useUpdateProductInventory,
} from "@/hooks/useAdminProducts";
import {
  PRODUCT_COLORS,
  PRODUCT_LINES,
  PRODUCT_CLASSES,
  PRODUCT_STYLES,
  PRODUCT_SIZES,
} from "@/lib/product-constants";
import { useAdminSpecialOffers } from "@/hooks/useAdminPromotions";
import { useReviews } from "@/hooks/useReviews";
import { toast } from "@/hooks/use-toast";
import { getOfferStatus } from "@/types/promotion";
import { getAppUrl } from "@/lib/utils";
import { translateProductContent } from "@/services/utilityService";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ProductPage: React.FC = () => {
  const { productId } = useParams<{ productId: string }>();
  const { isAuthenticated } = useAuth();
  const prodIdNum = productId ? parseInt(productId) : 0;
  const { data: product, isLoading: productLoading } =
    useAdminProductById(prodIdNum);
  const subcatId = product?.ProductSubcategoryID ?? 0;
  const { data: allSubcategories = [] } = useAdminAllSubcategories();
  const { data: editableCategories = [] } = useAdminCategories();
  // editCategoryId must be declared before useAdminSubcategoriesByCategory uses it
  const [editCategoryId, setEditCategoryId] = useState<number | "">("");
  const [editSubcategoryId, setEditSubcategoryId] = useState<number | "">("");
  const { data: filteredSubcategories = [] } = useAdminSubcategoriesByCategory(
    editCategoryId as number,
  );
  const catIdNum = React.useMemo(
    () =>
      allSubcategories.find((s) => s.ProductSubcategoryID === subcatId)
        ?.ProductCategoryID ?? 0,
    [allSubcategories, subcatId],
  );
  const { data: category } = useAdminCategoryById(catIdNum);
  const { averageRating, reviewCount } = useReviews(prodIdNum);
  const { data: promotions = [] } = useAdminSpecialOffers();

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [standardCost, setStandardCost] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [weight, setWeight] = useState("");
  const [weightUnit, setWeightUnit] = useState<"lb" | "kg">("lb");
  const [productLine, setProductLine] = useState("");
  const [productClass, setProductClass] = useState("");
  const [style, setStyle] = useState("");
  const [description, setDescription] = useState("");
  const [productDescriptionId, setProductDescriptionId] = useState<
    number | null
  >(null);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedPromotionId, setSelectedPromotionId] =
    useState<string>("none");

  const { data: inventoryRecords = [] } = useProductInventory(prodIdNum);
  const updateInventory = useUpdateProductInventory();
  // Total stock across all locations
  const totalStock = inventoryRecords.reduce(
    (sum, r) => sum + (r.Quantity ?? 0),
    0,
  );
  const [stockQuantity, setStockQuantity] = useState<string>("0");

  const { data: englishDesc } = useAdminProductEnglishDescription(
    product?.ProductModelID ?? null,
  );

  const updateProduct = useUpdateProduct();
  const updateProductDescription = useUpdateProductDescription();

  // Sync form state when product loads
  useEffect(() => {
    if (product) {
      setName(product.Name);
      setPrice(product.ListPrice.toString());
      setStandardCost(product.StandardCost?.toString() ?? "");
      setColor(product.Color ?? "");
      setSize(product.Size ?? "");
      setWeight(product.Weight?.toString() ?? "");
      setProductLine(product.ProductLine ?? "");
      setProductClass(product.Class ?? "");
      setStyle(product.Style ?? "");
      if (product.ProductSubcategoryID) {
        setEditSubcategoryId(product.ProductSubcategoryID);
      }
    }
  }, [product]);

  // Sync editable category id once allSubcategories resolves
  useEffect(() => {
    if (catIdNum) setEditCategoryId(catIdNum);
  }, [catIdNum]);

  // Sync stock quantity when inventory loads
  useEffect(() => {
    setStockQuantity(totalStock.toString());
  }, [totalStock]);

  // Sync description from the dedicated description query
  useEffect(() => {
    if (englishDesc) {
      setDescription(englishDesc.description);
      setProductDescriptionId(englishDesc.productDescriptionId);
    }
  }, [englishDesc]);

  // Filter to only show active and upcoming US English promotions (exclude "No Discount")
  const availablePromotions = promotions.filter((p) => {
    const status = getOfferStatus(p);
    return (
      p.SpecialOfferID !== 1 &&
      p.CultureID.trim() === "en" &&
      (status === "active" || status === "upcoming")
    );
  });

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (productLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <AdminHeader />
        <main className="flex-1 container mx-auto px-4 py-12 text-center">
          <span className="font-doodle text-doodle-text/60">
            Loading product...
          </span>
        </main>
        <Footer />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="min-h-screen flex flex-col">
        <AdminHeader />
        <main className="flex-1 container mx-auto px-4 py-12 text-center">
          <span className="text-6xl block mb-4">🔍</span>
          <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
            Product Not Found
          </h1>
          <Link to="/" className="doodle-button doodle-button-primary">
            Back to Dashboard
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = parseInt(e.target.value);
    setEditCategoryId(isNaN(val) ? "" : val);
    setEditSubcategoryId("");
  };

  const handleWeightUnitChange = (newUnit: "lb" | "kg") => {
    const cur = parseFloat(weight);
    if (!isNaN(cur) && cur > 0) {
      if (newUnit === "kg" && weightUnit === "lb") {
        setWeight((cur * 0.453592).toFixed(2));
      } else if (newUnit === "lb" && weightUnit === "kg") {
        setWeight((cur * 2.20462).toFixed(4));
      }
    }
    setWeightUnit(newUnit);
  };

  const handleSave = async () => {
    if (!product) return;
    setIsSaving(true);
    try {
      // 1. Update product fields
      await updateProduct.mutateAsync({
        ProductID: product.ProductID,
        Name: name,
        ListPrice: parseFloat(price),
        StandardCost: standardCost ? parseFloat(standardCost) : undefined,
        Color: color || undefined,
        Size: size || undefined,
        Weight: weight
          ? weightUnit === "lb"
            ? parseFloat(weight)
            : parseFloat(weight) * 2.20462
          : undefined,
        ProductLine: productLine || undefined,
        Class: productClass || undefined,
        Style: style || undefined,
        ProductSubcategoryID: editSubcategoryId
          ? (editSubcategoryId as number)
          : undefined,
      });

      // 1b. Update stock quantity at primary location (LocationID=1)
      const primaryRecord = inventoryRecords.find((r) => r.LocationID === 1);
      if (primaryRecord) {
        await updateInventory.mutateAsync({
          productId: product.ProductID,
          locationId: 1,
          quantity: parseInt(stockQuantity) || 0,
        });
      }

      // 2. Update or create English description (only if product has a model)
      if (product.ProductModelID) {
        const newDescId = await updateProductDescription.mutateAsync({
          productModelId: product.ProductModelID,
          productDescriptionId,
          description,
        });
        if (!productDescriptionId && newDescId) {
          setProductDescriptionId(newDescId as number);
        }

        // 3. Fire-and-forget translation to all other cultures
        translateProductContent([product.ProductModelID]).catch(() => {
          toast({
            title: "Translation Warning",
            description:
              "Product saved, but auto-translation to other languages failed.",
            variant: "destructive",
          });
        });
      }

      toast({
        title: "Product Saved",
        description: product.ProductModelID
          ? `${name} saved. Translations to all languages are queued.`
          : `${name} saved successfully.`,
      });
    } catch {
      toast({
        title: "Save Failed",
        description: "An error occurred while saving the product.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-4">
              <ProductImageGallery
                productId={product.ProductID}
                productName={product.Name}
                color={product.Color}
              />
              <AiImageGeneratorDialog
                productId={product.ProductID}
                productName={product.Name}
              />
            </div>

            <div className="space-y-6">
              <div className="doodle-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-doodle text-xl font-bold text-doodle-text">
                    Edit Product
                  </h2>
                  {getAppUrl() && (
                    <a
                      href={`${getAppUrl()}/product/${product.ProductID}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="View in customer app"
                      className="inline-flex items-center gap-1 font-doodle text-xs text-doodle-blue hover:underline"
                    >
                      <ExternalLink className="w-4 h-4" />
                      View in app
                    </a>
                  )}
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="font-doodle text-sm text-doodle-text flex items-center gap-2 mb-1">
                      Product Name
                      <span className="inline-flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                        <Globe className="w-3 h-3" /> US English
                      </span>
                    </label>
                    <input
                      type="text"
                      name="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="doodle-input w-full"
                    />
                  </div>

                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      SKU
                    </label>
                    <input
                      type="text"
                      value={product.ProductNumber}
                      disabled
                      className="doodle-input w-full bg-doodle-text/5"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Standard Cost ($)
                      </label>
                      <input
                        type="number"
                        name="standardCost"
                        value={standardCost}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setStandardCost(raw);
                          const cost = parseFloat(raw);
                          if (!isNaN(cost) && cost > 0) {
                            setPrice((cost * 1.2).toFixed(2));
                          }
                        }}
                        min="0"
                        step="0.01"
                        className="doodle-input w-full"
                      />
                    </div>
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        List Price ($)
                        <span className="ml-1 text-xs text-doodle-text/50 font-normal">
                          (auto-fills +20%)
                        </span>
                      </label>
                      <input
                        type="number"
                        name="listPrice"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        min="0"
                        step="0.01"
                        className="doodle-input w-full"
                      />
                    </div>
                  </div>
                  {parseFloat(standardCost) > parseFloat(price) && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      Standard Cost cannot exceed List Price.
                    </p>
                  )}

                  {/* Category + Subcategory */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Category
                      </label>
                      <select
                        value={editCategoryId}
                        onChange={handleCategoryChange}
                        className="doodle-input w-full"
                      >
                        <option value="">Select a category…</option>
                        {editableCategories.map((cat) => (
                          <option
                            key={cat.ProductCategoryID}
                            value={cat.ProductCategoryID}
                          >
                            {cat.Name}
                          </option>
                        ))}
                      </select>
                      {editCategoryId !== "" && (
                        <Link
                          to={`/category/${editCategoryId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-doodle-blue hover:underline mt-1"
                        >
                          <ExternalLink className="w-3 h-3" /> Edit this
                          category
                        </Link>
                      )}
                    </div>
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Subcategory
                      </label>
                      <select
                        value={editSubcategoryId}
                        onChange={(e) =>
                          setEditSubcategoryId(
                            e.target.value ? parseInt(e.target.value) : "",
                          )
                        }
                        disabled={!editCategoryId}
                        className="doodle-input w-full disabled:opacity-50"
                      >
                        <option value="">
                          {editCategoryId
                            ? "Select a subcategory…"
                            : "Select a category first…"}
                        </option>
                        {filteredSubcategories.map((sub) => (
                          <option
                            key={sub.ProductSubcategoryID}
                            value={sub.ProductSubcategoryID}
                          >
                            {sub.Name}
                          </option>
                        ))}
                      </select>
                      <Link
                        to="/categories"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-doodle-blue hover:underline mt-1"
                      >
                        <ExternalLink className="w-3 h-3" /> Manage
                        subcategories
                      </Link>
                    </div>
                  </div>

                  {/* Color + Size */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Color
                      </label>
                      <select
                        value={color}
                        onChange={(e) => setColor(e.target.value)}
                        className="doodle-input w-full"
                      >
                        <option value="">— None —</option>
                        {PRODUCT_COLORS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Size
                      </label>
                      <select
                        value={size}
                        onChange={(e) => setSize(e.target.value)}
                        className="doodle-input w-full"
                      >
                        <option value="">— None —</option>
                        {PRODUCT_SIZES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Weight + Stock (side-by-side, matching dialog) */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Weight
                        <span className="ml-1 text-xs text-doodle-text/50 font-normal">
                          (stored in lb)
                        </span>
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          value={weight}
                          onChange={(e) => setWeight(e.target.value)}
                          min="0"
                          step="0.01"
                          className="doodle-input flex-1"
                          placeholder={
                            weightUnit === "lb" ? "e.g. 14.3" : "e.g. 6.5"
                          }
                        />
                        <select
                          value={weightUnit}
                          onChange={(e) =>
                            handleWeightUnitChange(
                              e.target.value as "lb" | "kg",
                            )
                          }
                          className="doodle-input w-20"
                        >
                          <option value="lb">lb</option>
                          <option value="kg">kg</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Stock Quantity
                        <span className="ml-1 text-xs text-doodle-text/50 font-normal">
                          (primary warehouse)
                        </span>
                      </label>
                      <input
                        type="number"
                        value={stockQuantity}
                        onChange={(e) => {
                          const v = Math.max(
                            0,
                            Math.floor(Number(e.target.value) || 0),
                          );
                          setStockQuantity(String(v));
                        }}
                        min="0"
                        step="1"
                        className="doodle-input w-full"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Product Line
                      </label>
                      <select
                        value={productLine}
                        onChange={(e) => setProductLine(e.target.value)}
                        className="doodle-input w-full"
                      >
                        <option value="">— None —</option>
                        {PRODUCT_LINES.map((pl) => (
                          <option key={pl.value} value={pl.value}>
                            {pl.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Class
                      </label>
                      <select
                        value={productClass}
                        onChange={(e) => setProductClass(e.target.value)}
                        className="doodle-input w-full"
                      >
                        <option value="">— None —</option>
                        {PRODUCT_CLASSES.map((pc) => (
                          <option key={pc.value} value={pc.value}>
                            {pc.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Style
                      </label>
                      <select
                        value={style}
                        onChange={(e) => setStyle(e.target.value)}
                        className="doodle-input w-full"
                      >
                        <option value="">— None —</option>
                        {PRODUCT_STYLES.map((ps) => (
                          <option key={ps.value} value={ps.value}>
                            {ps.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      Promotion (optional)
                    </label>
                    <Select
                      value={selectedPromotionId}
                      onValueChange={setSelectedPromotionId}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="No promotion" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          <span className="flex items-center gap-2">
                            No promotion
                          </span>
                        </SelectItem>
                        {availablePromotions.map((promo) => {
                          const status = getOfferStatus(promo);
                          return (
                            <SelectItem
                              key={promo.SpecialOfferID}
                              value={promo.SpecialOfferID.toString()}
                            >
                              <span className="flex items-center gap-2">
                                <Tag className="w-3 h-3" />
                                {promo.Description} (
                                {(promo.DiscountPct * 100).toFixed(0)}% off)
                                {status === "upcoming" && (
                                  <span className="text-xs text-muted-foreground">
                                    (upcoming)
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  {selectedPromotionId !== "none" && (
                    <div className="bg-doodle-accent/10 border border-doodle-accent/30 rounded-lg p-3">
                      {(() => {
                        const promo = availablePromotions.find(
                          (p) =>
                            p.SpecialOfferID.toString() === selectedPromotionId,
                        );
                        if (!promo) return null;
                        const status = getOfferStatus(promo);
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Tag className="w-4 h-4 text-doodle-accent" />
                              <span className="font-doodle font-bold text-doodle-text">
                                {promo.Description}
                              </span>
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full ${
                                  status === "active"
                                    ? "bg-green-500/20 text-green-700"
                                    : "bg-yellow-500/20 text-yellow-700"
                                }`}
                              >
                                {status}
                              </span>
                            </div>
                            <p className="text-sm text-doodle-text/70">
                              {promo.Type} •{" "}
                              {(promo.DiscountPct * 100).toFixed(0)}% discount
                              {promo.MinQty > 0 &&
                                ` • Min qty: ${promo.MinQty}`}
                              {promo.MaxQty && ` • Max qty: ${promo.MaxQty}`}
                            </p>
                            <p className="text-xs text-doodle-text/50">
                              Valid:{" "}
                              {new Date(promo.StartDate).toLocaleDateString()} -{" "}
                              {new Date(promo.EndDate).toLocaleDateString()}
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  <div>
                    <label className="font-doodle text-sm text-doodle-text flex items-center gap-2 mb-1">
                      Description *
                      <span className="inline-flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                        <Globe className="w-3 h-3" /> US English
                      </span>
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={4}
                      maxLength={400}
                      className="doodle-input w-full"
                      placeholder="Enter English description — other languages are auto-translated on save"
                    />
                  </div>

                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="doodle-button doodle-button-primary w-full py-3 flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    <Save className="w-5 h-5" />
                    {isSaving ? "Saving…" : "Save Changes"}
                  </button>
                </div>
              </div>

              <div className="doodle-card p-4">
                <h3 className="font-doodle font-bold text-doodle-text mb-2">
                  Product Stats
                </h3>
                <div className="flex items-center gap-2">
                  <div className="flex">
                    {[...Array(5)].map((_, i) => (
                      <Star
                        key={i}
                        className={`w-4 h-4 ${i < Math.round(averageRating) ? "fill-doodle-accent text-doodle-accent" : "text-doodle-text/20"}`}
                      />
                    ))}
                  </div>
                  <span className="font-doodle text-sm text-doodle-text/60">
                    {averageRating.toFixed(1)} ({reviewCount} reviews)
                  </span>
                </div>
                <Link
                  to="/reviews"
                  className="inline-flex items-center gap-1 font-doodle text-xs text-doodle-blue hover:underline mt-2"
                >
                  <ExternalLink className="w-3 h-3" />
                  Edit reviews for this product
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12">
          <Link
            to={category ? `/category/${category.ProductCategoryID}` : "/"}
            className="doodle-button inline-flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back to{" "}
            {category?.Name || "Dashboard"}
          </Link>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ProductPage;
