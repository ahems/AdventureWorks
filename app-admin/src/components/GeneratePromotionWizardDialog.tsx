import React, { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles,
  X,
  Loader2,
  CheckCircle,
  AlertCircle,
  Package,
  TrendingUp,
  ChevronDown,
} from "lucide-react";
import {
  useAdminCategories,
  useAdminSubcategoriesByCategory,
} from "@/hooks/useAdminProducts";
import {
  useCreateSpecialOffer,
  useAssignSpecialOfferProducts,
} from "@/hooks/useAdminPromotions";
import { toast } from "@/hooks/use-toast";
import {
  OFFER_TYPES,
  OFFER_CATEGORIES,
  DEFAULT_CULTURE_ID,
  SpecialOffer,
} from "@/types/promotion";
import {
  generatePromotionWithAI,
  translatePromotion,
  type PromotionSuggestion,
  type SuggestedProduct,
} from "@/services/utilityService";

const OFFER_TYPES_WITHOUT_NO_DISCOUNT = OFFER_TYPES.filter(
  (t) => t !== "No Discount",
);
const OFFER_CATEGORIES_WITHOUT_NO_DISCOUNT = OFFER_CATEGORIES.filter(
  (c) => c !== "No Discount",
);

interface GeneratePromotionWizardDialogProps {
  existingOffers: SpecialOffer[];
}

type Step = "configure" | "running" | "review";

const GeneratePromotionWizardDialog: React.FC<
  GeneratePromotionWizardDialogProps
> = ({ existingOffers }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("configure");

  // Configure step state
  const [selectedType, setSelectedType] = useState<string>("Clearance");
  const [selectedOfferCategory, setSelectedOfferCategory] =
    useState<string>("Customer");
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | "">("");
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<
    number | ""
  >("");

  // Review step state
  const [suggestion, setSuggestion] = useState<PromotionSuggestion | null>(
    null,
  );
  const [editDescription, setEditDescription] = useState("");
  const [editDiscountPct, setEditDiscountPct] = useState(10);
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editMinQty, setEditMinQty] = useState(1);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(
    new Set(),
  );
  const [reasoningExpanded, setReasoningExpanded] = useState(false);

  // Error state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isRunning = useRef(false);
  const [isCreating, setIsCreating] = useState(false);

  const { data: categories = [] } = useAdminCategories();
  const { data: subcategories = [] } = useAdminSubcategoriesByCategory(
    selectedCategoryId as number,
  );

  const createOffer = useCreateSpecialOffer();
  const assignProducts = useAssignSpecialOfferProducts();

  const selectedCategory = categories.find(
    (c) => c.ProductCategoryID === selectedCategoryId,
  );
  const selectedSubcategory = subcategories.find(
    (s) => s.ProductSubcategoryID === selectedSubcategoryId,
  );

  const handleOpen = () => {
    setStep("configure");
    setErrorMessage(null);
    setSuggestion(null);
    setSelectedType("Clearance");
    setSelectedOfferCategory("Customer");
    setSelectedCategoryId("");
    setSelectedSubcategoryId("");
    isRunning.current = false;
    setIsOpen(true);
  };

  const handleClose = () => {
    if (isRunning.current || isCreating) return;
    setIsOpen(false);
  };

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setSelectedCategoryId(v === "" ? "" : parseInt(v));
    setSelectedSubcategoryId("");
  };

  const handleGenerate = async () => {
    setStep("running");
    setErrorMessage(null);
    isRunning.current = true;

    try {
      const result = await generatePromotionWithAI({
        promotionType: selectedType,
        offerCategory: selectedOfferCategory,
        categoryId:
          selectedCategoryId !== ""
            ? (selectedCategoryId as number)
            : undefined,
        categoryName: selectedCategory?.Name,
        subcategoryId:
          selectedSubcategoryId !== ""
            ? (selectedSubcategoryId as number)
            : undefined,
        subcategoryName: selectedSubcategory?.Name,
      });

      setSuggestion(result);
      setEditDescription(result.description);
      setEditDiscountPct(Math.round(result.discountPct * 100));
      setEditStartDate(result.startDate);
      setEditEndDate(result.endDate);
      setEditMinQty(result.minQty ?? 1);
      setSelectedProductIds(
        new Set(result.suggestedProducts.map((p) => p.productId)),
      );
      setStep("review");
    } catch (err) {
      setErrorMessage(
        String(err).replace(/^Error:\s*/i, "") || "AI generation failed",
      );
      setStep("configure");
    } finally {
      isRunning.current = false;
    }
  };

  const toggleProduct = useCallback((productId: number) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }, []);

  const handleCreate = async () => {
    if (!suggestion) return;
    setIsCreating(true);

    const englishPromotions = existingOffers.filter(
      (p) => p.CultureID === DEFAULT_CULTURE_ID,
    );
    const nextId =
      englishPromotions.length > 0
        ? Math.max(...englishPromotions.map((p) => p.SpecialOfferID)) + 1
        : 2;

    const discountDecimal = editDiscountPct / 100;
    const startIso = `${editStartDate}T00:00:00`;
    const endIso = `${editEndDate}T00:00:00`;

    try {
      await new Promise<void>((resolve, reject) => {
        createOffer.mutate(
          {
            SpecialOfferID: nextId,
            CultureID: DEFAULT_CULTURE_ID,
            Description: editDescription,
            DiscountPct: discountDecimal,
            Type: suggestion.type,
            Category: suggestion.category,
            StartDate: startIso,
            EndDate: endIso,
            MinQty: editMinQty,
            MaxQty: null,
          },
          { onSuccess: () => resolve(), onError: (e) => reject(e) },
        );
      });

      const chosenProductIds = Array.from(selectedProductIds);
      if (chosenProductIds.length > 0) {
        await new Promise<void>((resolve, reject) => {
          assignProducts.mutate(
            {
              offerId: nextId,
              newProductIds: chosenProductIds,
              currentProductIds: [],
            },
            { onSuccess: () => resolve(), onError: (e) => reject(e) },
          );
        });
      }

      // Fire-and-forget translation
      translatePromotion({
        specialOfferID: nextId,
        description: editDescription,
        discountPct: discountDecimal,
        type: suggestion.type,
        category: suggestion.category,
        startDate: startIso,
        endDate: endIso,
        minQty: editMinQty,
        maxQty: null,
      }).catch(() => {
        /* swallow — non-blocking */
      });

      toast({
        title: "Promotion Created",
        description: `"${editDescription}" was created with ${chosenProductIds.length} product(s) and queued for translation.`,
      });

      setIsOpen(false);
    } catch (err) {
      toast({
        title: "Create Failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  // ── Closed state: just the trigger button ────────────────────────────────
  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className="doodle-button doodle-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm shrink-0"
      >
        <Sparkles className="w-4 h-4" />
        Generate with AI
      </button>
    );
  }

  // ── Open: render via portal ───────────────────────────────────────────────
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative bg-doodle-bg border-2 border-doodle-border shadow-xl w-full max-w-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b-2 border-doodle-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-doodle-blue" />
            <h2 className="font-doodle text-lg font-bold text-doodle-text">
              {step === "review"
                ? "Review AI Promotion Suggestion"
                : "Generate Promotion with AI"}
            </h2>
          </div>
          {step !== "running" && (
            <button
              onClick={handleClose}
              className="text-doodle-text/50 hover:text-doodle-text transition-colors"
              disabled={isCreating}
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* ── Step: configure ── */}
          {step === "configure" && (
            <div className="space-y-4">
              <p className="font-doodle text-sm text-doodle-text/70">
                Select a promotion type and optional product scope, then let the
                AI analyse live inventory and sales data to suggest the best
                products and discount.
              </p>

              {errorMessage && (
                <div className="flex items-start gap-2 bg-red-50 border-2 border-red-200 rounded p-3">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="font-doodle text-sm text-red-700">
                    {errorMessage}
                  </p>
                </div>
              )}

              {/* Promotion type */}
              <div>
                <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                  Promotion Type
                </label>
                <select
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                  className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                >
                  {OFFER_TYPES_WITHOUT_NO_DISCOUNT.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {selectedType === "Clearance" && (
                  <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                    AI will prioritise high-inventory, slow-moving products.
                  </p>
                )}
                {selectedType === "Volume Discount" && (
                  <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                    AI will prioritise popular products to amplify sales volume.
                  </p>
                )}
              </div>

              {/* Offer category */}
              <div>
                <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                  Offer Category
                </label>
                <select
                  value={selectedOfferCategory}
                  onChange={(e) => setSelectedOfferCategory(e.target.value)}
                  className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                >
                  {OFFER_CATEGORIES_WITHOUT_NO_DISCOUNT.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {/* Optional category filter */}
              <div>
                <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                  Product Category{" "}
                  <span className="font-normal text-doodle-text/50">
                    (optional)
                  </span>
                </label>
                <select
                  value={selectedCategoryId}
                  onChange={handleCategoryChange}
                  className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                >
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option
                      key={c.ProductCategoryID}
                      value={c.ProductCategoryID}
                    >
                      {c.Name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Optional subcategory filter (only shown when a category is selected) */}
              {selectedCategoryId !== "" && subcategories.length > 0 && (
                <div>
                  <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                    Subcategory{" "}
                    <span className="font-normal text-doodle-text/50">
                      (optional)
                    </span>
                  </label>
                  <select
                    value={selectedSubcategoryId}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSelectedSubcategoryId(v === "" ? "" : parseInt(v));
                    }}
                    className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                  >
                    <option value="">All subcategories</option>
                    {subcategories.map((s) => (
                      <option
                        key={s.ProductSubcategoryID}
                        value={s.ProductSubcategoryID}
                      >
                        {s.Name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* ── Step: running ── */}
          {step === "running" && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-10 h-10 animate-spin text-doodle-accent" />
              <div className="text-center space-y-1">
                <p className="font-doodle font-bold text-doodle-text">
                  AI is analysing your catalogue…
                </p>
                <p className="font-doodle text-sm text-doodle-text/60">
                  Checking inventory levels and 90-day sales data via the MCP
                  server, then selecting the best products and discount for a{" "}
                  <em>{selectedType}</em> promotion.
                </p>
              </div>
            </div>
          )}

          {/* ── Step: review ── */}
          {step === "review" && suggestion && (
            <div className="space-y-5">
              {/* AI Reasoning */}
              {suggestion.aiReasoning && (
                <div className="bg-doodle-blue/10 border-2 border-doodle-blue/30 rounded p-3">
                  <button
                    onClick={() => setReasoningExpanded((v) => !v)}
                    className="w-full flex items-center justify-between gap-2 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-doodle-blue flex-shrink-0" />
                      <span className="font-doodle text-sm font-bold text-doodle-blue">
                        AI Strategy
                      </span>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 text-doodle-blue transition-transform ${reasoningExpanded ? "rotate-180" : ""}`}
                    />
                  </button>
                  {reasoningExpanded && (
                    <p className="font-doodle text-sm text-doodle-text/80 mt-2">
                      {suggestion.aiReasoning}
                    </p>
                  )}
                </div>
              )}

              {/* Description */}
              <div>
                <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                  Description
                </label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={2}
                  maxLength={255}
                  className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent resize-none"
                />
              </div>

              {/* Discount % + Dates row */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                    Discount %
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={editDiscountPct}
                    onChange={(e) =>
                      setEditDiscountPct(parseInt(e.target.value) || 1)
                    }
                    className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                  />
                </div>
                <div>
                  <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={editStartDate}
                    onChange={(e) => setEditStartDate(e.target.value)}
                    className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                  />
                </div>
                <div>
                  <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                    End Date
                  </label>
                  <input
                    type="date"
                    value={editEndDate}
                    onChange={(e) => setEditEndDate(e.target.value)}
                    className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                  />
                </div>
              </div>

              {/* Min Qty */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-doodle text-sm font-bold text-doodle-text mb-1">
                    Min Qty
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={editMinQty}
                    onChange={(e) =>
                      setEditMinQty(parseInt(e.target.value) || 0)
                    }
                    className="w-full border-2 border-doodle-border bg-doodle-bg font-doodle text-sm px-3 py-2 focus:outline-none focus:border-doodle-accent"
                  />
                </div>
                <div className="flex flex-col justify-end">
                  <span className="font-doodle text-xs text-doodle-text/50 pb-2">
                    Type: <strong>{suggestion.type}</strong> · Category:{" "}
                    <strong>{suggestion.category}</strong>
                  </span>
                </div>
              </div>

              {/* Suggested products */}
              <div>
                <label className="block font-doodle text-sm font-bold text-doodle-text mb-2">
                  Suggested Products{" "}
                  <span className="font-normal text-doodle-text/50">
                    ({selectedProductIds.size} of{" "}
                    {suggestion.suggestedProducts.length} selected)
                  </span>
                </label>
                <div className="border-2 border-doodle-border divide-y-2 divide-doodle-border max-h-64 overflow-y-auto">
                  {suggestion.suggestedProducts.map((product) => (
                    <ProductRow
                      key={product.productId}
                      product={product}
                      checked={selectedProductIds.has(product.productId)}
                      onToggle={toggleProduct}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t-2 border-doodle-border flex-shrink-0 flex gap-3 justify-end">
          {step === "configure" && (
            <>
              <button
                onClick={handleClose}
                className="doodle-button px-4 py-2 font-doodle text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                className="doodle-button doodle-button-primary flex items-center gap-2 px-4 py-2 font-doodle text-sm"
              >
                <Sparkles className="w-4 h-4" />
                Analyse &amp; Generate
              </button>
            </>
          )}

          {step === "review" && (
            <>
              <button
                onClick={() => {
                  setStep("configure");
                  setSuggestion(null);
                }}
                disabled={isCreating}
                className="doodle-button px-4 py-2 font-doodle text-sm"
              >
                ← Back
              </button>
              <button
                onClick={handleCreate}
                disabled={
                  isCreating ||
                  !editDescription.trim() ||
                  !editStartDate ||
                  !editEndDate
                }
                className="doodle-button doodle-button-primary flex items-center gap-2 px-4 py-2 font-doodle text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    Create Promotion
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

// ── Product row sub-component ────────────────────────────────────────────────

interface ProductRowProps {
  product: SuggestedProduct;
  checked: boolean;
  onToggle: (id: number) => void;
}

const ProductRow: React.FC<ProductRowProps> = ({
  product,
  checked,
  onToggle,
}) => (
  <label className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-doodle-accent/5 transition-colors">
    <input
      type="checkbox"
      checked={checked}
      onChange={() => onToggle(product.productId)}
      className="mt-1 accent-doodle-accent"
    />
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-doodle text-sm font-bold text-doodle-text truncate">
          {product.productName}
        </span>
        <span className="font-doodle text-sm text-doodle-text/70 shrink-0">
          ${product.currentPrice?.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-0.5">
        <span className="flex items-center gap-1 font-doodle text-xs text-doodle-text/50">
          <Package className="w-3 h-3" />
          {product.inventoryLevel} in stock
        </span>
        <span className="flex items-center gap-1 font-doodle text-xs text-doodle-text/50">
          <TrendingUp className="w-3 h-3" />
          {product.recentSalesCount} sales (90d)
        </span>
      </div>
      {product.reason && (
        <p className="font-doodle text-xs text-doodle-text/40 mt-0.5 italic">
          {product.reason}
        </p>
      )}
    </div>
  </label>
);

export default GeneratePromotionWizardDialog;
