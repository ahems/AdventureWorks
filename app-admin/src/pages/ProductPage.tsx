import React, { useState, useEffect, useMemo } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import {
  ArrowLeft,
  Star,
  Save,
  Tag,
  ExternalLink,
  Globe,
  Sparkles,
  Loader2,
  Trash2,
  History,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import ProductImageGallery from "@/components/ProductImageGallery";
import AiImageGeneratorDialog from "@/components/AiImageGeneratorDialog";
import CreateVariationsDialog from "@/components/CreateVariationsDialog";
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
  useCreateProductModel,
  useProductInventory,
  useUpdateProductInventory,
  useProductPhotos,
  useDeleteProductPhoto,
  useAdminSiblingProducts,
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
import {
  translateProductContent,
  generateProductContent,
  getProductEligibleReviewerCount,
  generateVerifiedReviewsForProduct,
} from "@/services/utilityService";
import {
  useProductTransactionHistory,
  TransactionRecord,
  TransactionType,
} from "@/hooks/useAdminTransactions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TYPE_LABELS: Record<TransactionType, string> = {
  W: "Work Order",
  S: "Sales Order",
  P: "Purchase Order",
};

const TYPE_COLORS: Record<TransactionType, string> = {
  W: "bg-blue-100 text-blue-800 border-blue-300",
  S: "bg-orange-100 text-orange-800 border-orange-300",
  P: "bg-green-100 text-green-800 border-green-300",
};

const formatCurrency = (val: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    val,
  );

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

interface TransactionHistorySectionProps {
  productId: number;
}

const TransactionHistorySection: React.FC<TransactionHistorySectionProps> = ({
  productId,
}) => {
  const {
    data: transactions = [],
    isLoading,
    isError,
  } = useProductTransactionHistory(productId);

  return (
    <div className="doodle-card">
      <div className="flex items-center gap-2 px-6 py-4 border-b-4 border-doodle-text">
        <History className="w-5 h-5 text-doodle-text" />
        <h2 className="font-doodle text-xl font-bold text-doodle-text">
          Transaction History
        </h2>
        <span className="font-doodle text-xs text-doodle-text/50 ml-auto">
          Last 50 records (live + archive)
        </span>
      </div>
      {isLoading ? (
        <TableSkeleton rows={5} cols={5} />
      ) : isError ? (
        <p className="font-doodle text-sm text-red-600 px-6 py-4">
          Failed to load transaction history.
        </p>
      ) : transactions.length === 0 ? (
        <p className="font-doodle text-sm text-doodle-text/50 px-6 py-4">
          No inventory movements recorded for this product yet. Run the
          manufacturing or supply chain simulators to generate records.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-doodle-text/5 border-b-2 border-doodle-text/10">
                <th className="font-doodle text-xs font-bold text-doodle-text/60 text-left px-4 py-2">
                  Date
                </th>
                <th className="font-doodle text-xs font-bold text-doodle-text/60 text-left px-4 py-2">
                  Type
                </th>
                <th className="font-doodle text-xs font-bold text-doodle-text/60 text-right px-4 py-2">
                  Qty
                </th>
                <th className="font-doodle text-xs font-bold text-doodle-text/60 text-right px-4 py-2">
                  Unit Cost
                </th>
                <th className="font-doodle text-xs font-bold text-doodle-text/60 text-right px-4 py-2">
                  Ref. Order
                </th>
              </tr>
            </thead>
            <tbody>
              {(transactions as TransactionRecord[]).map((tx) => (
                <tr
                  key={tx.TransactionID}
                  className="border-b border-dashed border-doodle-text/10 hover:bg-doodle-text/5"
                >
                  <td className="font-doodle text-sm text-doodle-text px-4 py-2 whitespace-nowrap">
                    {formatDate(tx.TransactionDate)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`font-doodle text-xs font-bold px-2 py-0.5 border-2 ${TYPE_COLORS[tx.TransactionType]}`}
                    >
                      {tx.TransactionType} — {TYPE_LABELS[tx.TransactionType]}
                    </span>
                  </td>
                  <td
                    className={`font-doodle text-sm font-bold text-right px-4 py-2 ${
                      tx.Quantity > 0 ? "text-green-700" : "text-red-700"
                    }`}
                  >
                    {tx.Quantity > 0 ? "+" : ""}
                    {tx.Quantity.toLocaleString()}
                  </td>
                  <td className="font-doodle text-sm text-right px-4 py-2 text-doodle-text">
                    {formatCurrency(tx.ActualCost)}
                  </td>
                  <td className="font-doodle text-sm text-right px-4 py-2 text-doodle-text/60">
                    {tx.ReferenceOrderID || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-6 py-3 border-t-2 border-dashed border-doodle-text/20 text-right">
        <a
          href={`/inventory-transactions`}
          className="font-doodle text-xs text-doodle-blue hover:underline"
        >
          View all transactions →
        </a>
      </div>
    </div>
  );
};

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
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingReviews, setIsGeneratingReviews] = useState(false);
  const [eligibleReviewerCount, setEligibleReviewerCount] = useState<
    number | null
  >(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);
  const [isDeletingAiImages, setIsDeletingAiImages] = useState(false);
  const [isVariationsOpen, setIsVariationsOpen] = useState(false);
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

  // Fetch eligible unreviewed customer count for this product whenever the product loads.
  // Uses the lightweight count endpoint — avoids downloading full customer rows.
  useEffect(() => {
    if (!prodIdNum) return;
    setEligibilityLoading(true);
    getProductEligibleReviewerCount(prodIdNum)
      .then((count) => setEligibleReviewerCount(count))
      .catch(() => setEligibleReviewerCount(0))
      .finally(() => setEligibilityLoading(false));
  }, [prodIdNum]);

  const updateProduct = useUpdateProduct();
  const updateProductDescription = useUpdateProductDescription();
  const createProductModel = useCreateProductModel();
  const { data: photoRecords = [] } = useProductPhotos(prodIdNum);
  const deletePhoto = useDeleteProductPhoto();
  const { data: siblingProducts = [] } = useAdminSiblingProducts(
    product?.ProductModelID ?? null,
    prodIdNum,
  );

  // Precompute the set of taken Color|Style|Size combinations from sibling products.
  // Sibling values are trimmed to handle SQL NCHAR padding (e.g. "M " → "M").
  const takenSet = useMemo(() => {
    const set = new Set<string>();
    for (const s of siblingProducts) {
      const c = (s.Color ?? "").trim();
      const st = (s.Style ?? "").trim();
      const sz = (s.Size ?? "").trim();
      set.add(`${c}|${st}|${sz}`);
    }
    return set;
  }, [siblingProducts]);

  const isTaken = (c: string, st: string, sz: string) =>
    takenSet.has(`${c}|${st}|${sz}`);

  // Sync form state when product loads
  useEffect(() => {
    if (product) {
      setName(product.Name);
      setPrice(product.ListPrice.toString());
      setStandardCost(product.StandardCost?.toString() ?? "");
      setColor(product.Color ?? "");
      setSize(product.Size ?? "");
      setWeight(product.Weight?.toString() ?? "");
      setProductLine(product.ProductLine?.trim() ?? "");
      setProductClass(product.Class?.trim() ?? "");
      setStyle(product.Style?.trim() ?? "");
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

  const handleGenerateWithAI = async () => {
    const categoryName = category?.Name;
    const subcategoryName = allSubcategories.find(
      (s) => s.ProductSubcategoryID === editSubcategoryId,
    )?.Name;
    if (!categoryName || !subcategoryName) return;

    const productLineLabel =
      PRODUCT_LINES.find((pl) => pl.value === productLine)?.label ||
      productLine ||
      undefined;
    const classLabel =
      PRODUCT_CLASSES.find((pc) => pc.value === productClass)?.label ||
      productClass ||
      undefined;
    const styleLabel =
      PRODUCT_STYLES.find((ps) => ps.value === style)?.label ||
      style ||
      undefined;

    setIsGenerating(true);
    try {
      const result = await generateProductContent({
        category: categoryName,
        subcategory: subcategoryName,
        productLine: productLineLabel ?? null,
        class_: classLabel ?? null,
        style: styleLabel ?? null,
      });
      setName(result.productName);
      setDescription(result.productDescription);
      toast({
        title: "AI Content Generated",
        description:
          "Product name and description have been updated. Review and save when ready.",
      });
    } catch (err) {
      toast({
        title: "Generation Failed",
        description:
          err instanceof Error
            ? err.message
            : "Could not generate product content.",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!product) return;

    // Guard: prevent duplicate Color+Style+Size combination within the same product model
    if (siblingProducts.length > 0) {
      const isDuplicate = siblingProducts.some(
        (s) =>
          (s.Color ?? "").trim() === (color || "") &&
          (s.Style ?? "").trim() === (style || "") &&
          (s.Size ?? "").trim() === (size || ""),
      );
      if (isDuplicate) {
        toast({
          title: "Duplicate Variation",
          description: `Another product in this model already has Color="${color || "–"}", Style="${style || "–"}", Size="${size || "–"}". Choose a different combination.`,
          variant: "destructive",
        });
        return;
      }
    }

    setIsSaving(true);

    // If description is provided but this product has no ProductModel yet,
    // create one now so the description can be stored and linked.
    let resolvedProductModelId: number | null = product.ProductModelID ?? null;

    try {
      if (description.trim() && !resolvedProductModelId) {
        resolvedProductModelId = await createProductModel.mutateAsync({
          name,
        });
      }

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
        ProductModelID: resolvedProductModelId,
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
      if (resolvedProductModelId) {
        const newDescId = await updateProductDescription.mutateAsync({
          productModelId: resolvedProductModelId,
          productDescriptionId,
          description,
        });
        if (!productDescriptionId && newDescId) {
          setProductDescriptionId(newDescId as number);
        }

        // 3. Fire-and-forget translation to all other cultures
        translateProductContent([resolvedProductModelId]).catch(() => {
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
        description: resolvedProductModelId
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

  const handleDeleteAiImages = async () => {
    const aiPhotos = photoRecords.filter((r) =>
      r.productPhoto?.LargePhotoFileName?.toLowerCase().endsWith(".png"),
    );
    if (aiPhotos.length === 0) {
      toast({
        title: "No AI Images",
        description: "There are no AI-generated PNG images to delete.",
      });
      return;
    }
    setIsDeletingAiImages(true);
    try {
      await Promise.all(
        aiPhotos.map((r) =>
          deletePhoto.mutateAsync({
            productId: product.ProductID,
            productPhotoId: r.ProductPhotoID,
          }),
        ),
      );
      toast({
        title: "AI Images Deleted",
        description: `${aiPhotos.length} AI-generated image(s) have been removed.`,
      });
    } catch {
      toast({
        title: "Delete Failed",
        description: "An error occurred while deleting AI-generated images.",
        variant: "destructive",
      });
    } finally {
      setIsDeletingAiImages(false);
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
                productName={name}
                description={description}
                categoryName={category?.Name ?? null}
                subcategoryName={
                  allSubcategories.find(
                    (s) => s.ProductSubcategoryID === editSubcategoryId,
                  )?.Name ?? null
                }
                color={color || null}
                productLine={
                  productLine
                    ? (PRODUCT_LINES.find((pl) => pl.value === productLine)
                        ?.label ?? productLine)
                    : null
                }
                style={
                  style
                    ? (PRODUCT_STYLES.find((ps) => ps.value === style)?.label ??
                      style)
                    : null
                }
              />
              {product.ProductSubcategoryID && (
                <CreateVariationsDialog
                  product={product}
                  description={description}
                  siblingProducts={siblingProducts}
                  externalOpen={isVariationsOpen}
                  onExternalOpenChange={setIsVariationsOpen}
                />
              )}
              <button
                type="button"
                onClick={handleDeleteAiImages}
                disabled={isDeletingAiImages}
                className="doodle-button w-full py-3 flex items-center justify-center gap-2 text-doodle-accent border-doodle-accent/50 hover:bg-doodle-accent/10 disabled:opacity-60"
              >
                {isDeletingAiImages ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Trash2 className="w-5 h-5" />
                )}
                {isDeletingAiImages
                  ? "Deleting…"
                  : "Delete AI Generated Images"}
              </button>
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
                        <option value="" disabled={isTaken("", style, size)}>
                          {isTaken("", style, size)
                            ? "— None — (already exists)"
                            : "— None —"}
                        </option>
                        {PRODUCT_COLORS.map((c) => {
                          const taken = isTaken(c, style, size);
                          return (
                            <option key={c} value={c} disabled={taken}>
                              {taken ? `${c} (already exists)` : c}
                            </option>
                          );
                        })}
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
                        <option value="" disabled={isTaken(color, style, "")}>
                          {isTaken(color, style, "")
                            ? "— None — (already exists)"
                            : "— None —"}
                        </option>
                        {PRODUCT_SIZES.map((s) => {
                          const taken = isTaken(color, style, s);
                          return (
                            <option key={s} value={s} disabled={taken}>
                              {taken ? `${s} (already exists)` : s}
                            </option>
                          );
                        })}
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
                          className="doodle-input flex-1 min-w-0"
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
                        <option value="" disabled={isTaken(color, "", size)}>
                          {isTaken(color, "", size)
                            ? "— None — (already exists)"
                            : "— None —"}
                        </option>
                        {PRODUCT_STYLES.map((ps) => {
                          const taken = isTaken(color, ps.value, size);
                          return (
                            <option
                              key={ps.value}
                              value={ps.value}
                              disabled={taken}
                            >
                              {taken
                                ? `${ps.label} (already exists)`
                                : ps.label}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  </div>

                  {/* Existing Variations — siblings sharing this product model */}
                  {siblingProducts.length > 0 && (
                    <div className="rounded-lg border border-doodle-text/15 bg-doodle-text/[0.03] p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-doodle text-xs font-semibold text-doodle-text/60 uppercase tracking-wide">
                          {siblingProducts.length} other variation
                          {siblingProducts.length !== 1 ? "s" : ""} in this
                          model
                        </p>
                        {product.ProductSubcategoryID && (
                          <button
                            type="button"
                            onClick={() => setIsVariationsOpen(true)}
                            className="inline-flex items-center gap-1 text-xs text-doodle-blue hover:underline font-medium"
                          >
                            + Add More Variations
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {siblingProducts.map((sib) => {
                          const styleLabel =
                            PRODUCT_STYLES.find(
                              (ps) => ps.value === (sib.Style ?? "").trim(),
                            )?.label ??
                            (sib.Style?.trim() || null);
                          const parts = [
                            sib.Color?.trim() || null,
                            styleLabel,
                            sib.Size?.trim() || null,
                          ]
                            .filter(Boolean)
                            .join(" / ");
                          return (
                            <Link
                              key={sib.ProductID}
                              to={`/product/${sib.ProductID}`}
                              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-doodle-text/20 bg-white dark:bg-doodle-text/5 text-doodle-text hover:border-doodle-blue hover:text-doodle-blue transition-colors"
                              title={sib.ProductNumber}
                            >
                              {sib.Name}
                              {parts && (
                                <span className="text-doodle-text/50">
                                  — {parts}
                                </span>
                              )}
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  )}

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

                  {/* Generate using AI */}
                  <div className="flex items-start gap-3 p-3 rounded border border-dashed border-doodle-blue bg-blue-50/50 dark:bg-blue-900/10">
                    <Sparkles className="w-5 h-5 text-doodle-blue mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-doodle text-sm font-semibold text-doodle-blue">
                        Generate using AI
                      </p>
                      <p className="text-xs text-doodle-text/60 mt-0.5">
                        Category and Subcategory are required. Product Line,
                        Class, and Style improve results. Overwrites name and
                        description.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleGenerateWithAI}
                      disabled={
                        isGenerating || !editCategoryId || !editSubcategoryId
                      }
                      className="doodle-button doodle-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm shrink-0 disabled:opacity-50"
                    >
                      {isGenerating ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4" />
                      )}
                      {isGenerating ? "Generating…" : "Generate"}
                    </button>
                  </div>

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
                      placeholder="Describe this Product or generate using AI (above). Use US English - other languages will be automatically translated from this text."
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
                <div className="flex flex-col gap-2 mt-2">
                  {reviewCount > 0 && (
                    <Link
                      to={`/reviews?productId=${product.ProductID}`}
                      className="inline-flex items-center gap-1 font-doodle text-xs text-doodle-blue hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Edit reviews for this product
                    </Link>
                  )}
                  <button
                    onClick={async () => {
                      setIsGeneratingReviews(true);
                      try {
                        await generateVerifiedReviewsForProduct(
                          product.ProductID,
                        );
                        toast({
                          title: "Review generation started",
                          description:
                            "A verified review is being generated using a real customer who purchased and received this product.",
                        });
                      } catch (err) {
                        const msg =
                          err instanceof Error
                            ? err.message
                            : "Failed to start review generation.";
                        toast({
                          title: "Error",
                          description: msg,
                          variant: "destructive",
                        });
                      } finally {
                        setIsGeneratingReviews(false);
                      }
                    }}
                    disabled={
                      isGeneratingReviews ||
                      eligibilityLoading ||
                      eligibleReviewerCount === 0
                    }
                    title={
                      eligibleReviewerCount === 0
                        ? "No eligible customers: reviews can only be generated for eshop customers who purchased and received this product but haven't yet written a review."
                        : eligibleReviewerCount !== null
                          ? `${eligibleReviewerCount} eligible customer${eligibleReviewerCount !== 1 ? "s" : ""} who purchased and received this product without yet reviewing it`
                          : "Generate a verified review from a real customer"
                    }
                    className="inline-flex items-center gap-1 font-doodle text-xs text-doodle-blue hover:underline disabled:opacity-40 disabled:cursor-not-allowed bg-transparent border-0 p-0 cursor-pointer"
                  >
                    {isGeneratingReviews ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : eligibilityLoading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3" />
                    )}
                    {eligibilityLoading
                      ? "Checking eligibility…"
                      : eligibleReviewerCount === 0
                        ? "No eligible customers for verified reviews"
                        : eligibleReviewerCount !== null
                          ? `Generate Verified Review (${eligibleReviewerCount} eligible customer${eligibleReviewerCount !== 1 ? "s" : ""})`
                          : "Generate Verified Review Using AI"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 pb-8">
          <TransactionHistorySection productId={prodIdNum} />
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
