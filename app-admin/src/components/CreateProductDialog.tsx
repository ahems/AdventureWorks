import React, { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate, Link } from "react-router-dom";
import {
  Plus,
  Globe,
  X,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Layers,
  Sparkles,
  Loader2,
} from "lucide-react";
import {
  useCreateProduct,
  useCreateProductBatch,
  useAdminCategories,
  useAdminSubcategoriesByCategory,
  type BatchProgress,
} from "@/hooks/useAdminProducts";
import { ProductSubcategory } from "@/types/product";
import { toast } from "@/hooks/use-toast";
import {
  PRODUCT_COLORS,
  PRODUCT_LINES,
  PRODUCT_CLASSES,
  PRODUCT_STYLES,
  PRODUCT_SIZES,
} from "@/lib/product-constants";
import {
  generateVariations,
  type VariationRow,
} from "@/lib/variation-generator";
import { generateProductContent } from "@/services/utilityService";
import { getFunctionsApiUrl } from "@/lib/utils";
import { translateProductContent } from "@/services/utilityService";

/** Generate a short GUID-derived SKU safe for the 25-char DB column. */
const generateSku = (): string => {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
  return `${hex()}-${hex()}-${hex()}`;
};

const STYLE_LABEL: Record<string, string> = Object.fromEntries(
  PRODUCT_STYLES.map((s) => [s.value, s.label]),
);

interface CreateProductDialogProps {
  defaultCategoryId?: number;
  defaultSubcategoryId?: number;
  subcategories?: ProductSubcategory[]; // kept for backwards compat
}

const CreateProductDialog: React.FC<CreateProductDialogProps> = ({
  defaultCategoryId,
  defaultSubcategoryId,
}) => {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [weightUnit, setWeightUnit] = useState<"lb" | "kg">("lb");

  // ── Variation wizard state ────────────────────────────────────────────────
  const [variationMode, setVariationMode] = useState(false);
  const [wizardStep, setWizardStep] = useState(1); // 1=base, 2=dimensions, 3=preview
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(
    null,
  );

  const { data: categories = [] } = useAdminCategories();
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | "">(
    defaultCategoryId ?? "",
  );
  const { data: filteredSubcategories = [] } = useAdminSubcategoriesByCategory(
    selectedCategoryId as number,
  );

  const emptyForm = () => ({
    Name: "",
    ProductNumber: generateSku(),
    StandardCost: "",
    ListPrice: "",
    ProductSubcategoryID: defaultSubcategoryId?.toString() ?? "",
    Description: "",
    Color: "",
    Size: "",
    Weight: "",
    ProductLine: "",
    Class: "",
    Style: "",
    InitialQuantity: "0",
  });

  const [form, setForm] = useState(emptyForm);

  const handleStandardCostChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setForm((prev) => {
        const cost = parseFloat(raw);
        const suggested =
          !isNaN(cost) && cost > 0 ? (cost * 1.2).toFixed(2) : prev.ListPrice;
        return { ...prev, StandardCost: raw, ListPrice: suggested };
      });
    },
    [],
  );

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedCategoryId(val === "" ? "" : parseInt(val));
    setForm((prev) => ({ ...prev, ProductSubcategoryID: "" }));
  };

  const handleWeightUnitChange = (newUnit: "lb" | "kg") => {
    const cur = parseFloat(form.Weight);
    if (!isNaN(cur) && cur > 0) {
      if (newUnit === "kg" && weightUnit === "lb") {
        setForm((prev) => ({ ...prev, Weight: (cur * 0.453592).toFixed(2) }));
      } else if (newUnit === "lb" && weightUnit === "kg") {
        setForm((prev) => ({ ...prev, Weight: (cur * 2.20462).toFixed(4) }));
      }
    }
    setWeightUnit(newUnit);
  };

  useEffect(() => {
    if (filteredSubcategories.length > 0 && !form.ProductSubcategoryID) {
      setForm((prev) => ({
        ...prev,
        ProductSubcategoryID:
          filteredSubcategories[0].ProductSubcategoryID.toString(),
      }));
    }
  }, [filteredSubcategories]); // eslint-disable-line react-hooks/exhaustive-deps

  const createProduct = useCreateProduct();
  const createBatch = useCreateProductBatch();

  const handleGenerateWithAI = async () => {
    const category = categories.find(
      (c) => c.ProductCategoryID === selectedCategoryId,
    )?.Name;
    const subcategory = filteredSubcategories.find(
      (s) => s.ProductSubcategoryID.toString() === form.ProductSubcategoryID,
    )?.Name;
    if (!category || !subcategory) return;

    const productLineLabel =
      PRODUCT_LINES.find((pl) => pl.value === form.ProductLine)?.label ||
      form.ProductLine ||
      undefined;
    const classLabel =
      PRODUCT_CLASSES.find((pc) => pc.value === form.Class)?.label ||
      form.Class ||
      undefined;
    const styleLabel =
      PRODUCT_STYLES.find((ps) => ps.value === form.Style)?.label ||
      form.Style ||
      undefined;

    setIsGenerating(true);
    try {
      const result = await generateProductContent({
        category,
        subcategory,
        productLine: productLineLabel ?? null,
        class_: classLabel ?? null,
        style: styleLabel ?? null,
      });
      setForm((prev) => ({
        ...prev,
        Name: result.productName,
        Description: result.productDescription,
      }));
      toast({
        title: "AI Content Generated",
        description:
          "Product name and description have been filled in. Feel free to edit them.",
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

  const handleOpen = () => {
    setSelectedCategoryId(defaultCategoryId ?? "");
    setForm(emptyForm());
    setWeightUnit("lb");
    setVariationMode(false);
    setWizardStep(1);
    setSelectedColors([]);
    setSelectedSizes([]);
    setSelectedStyles([]);
    setBatchProgress(null);
    setIsOpen(true);
  };

  const handleClose = () => {
    if (!isSaving) setIsOpen(false);
  };

  // ── Variation preview rows ────────────────────────────────────────────────
  const variationRows: VariationRow[] = useMemo(() => {
    if (!variationMode) return [];
    const cost = parseFloat(form.StandardCost);
    if (isNaN(cost) || cost <= 0) return [];
    return generateVariations({
      baseName: form.Name,
      baseStandardCost: cost,
      baseListPrice: parseFloat(form.ListPrice) || cost * 1.2,
      productSubcategoryID: parseInt(form.ProductSubcategoryID) || 0,
      description: form.Description,
      weight: form.Weight
        ? weightUnit === "lb"
          ? parseFloat(form.Weight)
          : parseFloat(form.Weight) * 2.20462
        : null,
      productLine: form.ProductLine || null,
      class_: form.Class || null,
      baseStyle: form.Style || null,
      initialQuantity: parseInt(form.InitialQuantity) || 0,
      colors: selectedColors,
      sizes: selectedSizes,
      styles: selectedStyles,
    });
  }, [
    variationMode,
    form,
    weightUnit,
    selectedColors,
    selectedSizes,
    selectedStyles,
  ]);

  // ── Validate Step 1 (base product fields) ────────────────────────────────
  const isStep1Valid = () => {
    const cost = parseFloat(form.StandardCost);
    const price = parseFloat(form.ListPrice);
    return (
      form.Name.trim().length > 0 &&
      form.Description.trim().length > 0 &&
      !isNaN(cost) &&
      !isNaN(price) &&
      cost <= price &&
      !!form.ProductSubcategoryID
    );
  };

  // ── Validate Step 2 (at least one color and one size) ────────────────────
  const isStep2Valid = () =>
    selectedColors.length > 0 && selectedSizes.length > 0;

  // ── handle single-product submit (non-variation mode) ─────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cost = parseFloat(form.StandardCost);
    const price = parseFloat(form.ListPrice);

    if (
      !form.Name.trim() ||
      !form.ProductNumber.trim() ||
      !form.Description.trim()
    ) {
      toast({
        title: "Validation Error",
        description: "Name, SKU and Description are required.",
        variant: "destructive",
      });
      return;
    }
    if (isNaN(cost) || isNaN(price)) {
      toast({
        title: "Validation Error",
        description: "Standard Cost and List Price must be valid numbers.",
        variant: "destructive",
      });
      return;
    }
    if (cost > price) {
      toast({
        title: "Validation Error",
        description: "Standard Cost cannot be greater than List Price.",
        variant: "destructive",
      });
      return;
    }
    if (!form.ProductSubcategoryID) {
      toast({
        title: "Validation Error",
        description: "Please select a Category and Subcategory.",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const newProduct = await createProduct.mutateAsync({
        Name: form.Name.trim(),
        ProductNumber: form.ProductNumber.trim(),
        ListPrice: price,
        StandardCost: cost,
        ProductSubcategoryID: parseInt(form.ProductSubcategoryID),
        Color: form.Color || null,
        Size: form.Size || null,
        Weight: form.Weight
          ? weightUnit === "lb"
            ? parseFloat(form.Weight)
            : parseFloat(form.Weight) * 2.20462
          : null,
        ProductLine: form.ProductLine || null,
        Class: form.Class || null,
        Style: form.Style || null,
        InitialQuantity: parseInt(form.InitialQuantity) || 0,
        Description: form.Description.trim() || undefined,
      });
      toast({
        title: "Product Created",
        description: `${form.Name} was created. AI images are being generated in the background.`,
      });
      // Silently trigger AI image generation in the background
      fetch(
        `${getFunctionsApiUrl()}/api/products/${newProduct.ProductID}/generate-images`,
        { method: "POST" },
      ).catch(() => {});
      // Silently trigger translations (and then embeddings) for all cultures
      if (newProduct.ProductModelID) {
        translateProductContent([newProduct.ProductModelID]).catch(() => {});
      }
      setIsOpen(false);
      navigate(`/product/${newProduct.ProductID}`);
    } catch {
      toast({
        title: "Create Failed",
        description: "An error occurred while creating the product.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // ── handle batch submit (variation mode step 3) ───────────────────────────
  const handleBatchSubmit = async () => {
    if (variationRows.length === 0) return;
    setIsSaving(true);
    setBatchProgress({ completed: 0, total: variationRows.length });
    try {
      const batchResult = await createBatch.mutateAsync({
        items: variationRows,
        onProgress: setBatchProgress,
      });
      toast({
        title: "Variations Created",
        description: `Created ${variationRows.length} product variation(s) for "${form.Name}". AI images and translations are being generated in the background.`,
      });
      // Silently trigger translations (and then embeddings) for the shared model
      if (batchResult.sharedModelId) {
        translateProductContent([batchResult.sharedModelId]).catch(() => {});
      }
      // Trigger AI image generation for the first product in each unique Color+Style pair.
      // Same Color+Style across sizes = visually identical → backend will reuse the photos.
      const seenVisualKeys = new Set<string>();
      for (const p of batchResult.results) {
        const visualKey = `${p.Color ?? "none"}:${(p as { Style?: string | null }).Style ?? "none"}`;
        if (!seenVisualKeys.has(visualKey)) {
          seenVisualKeys.add(visualKey);
          fetch(
            `${getFunctionsApiUrl()}/api/products/${p.ProductID}/generate-images`,
            { method: "POST" },
          ).catch(() => {});
        }
      }
      setIsOpen(false);
      navigate(`/category/${selectedCategoryId}`);
    } catch {
      toast({
        title: "Batch Create Failed",
        description:
          "An error occurred while creating product variations. Some may have been created.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
      setBatchProgress(null);
    }
  };

  const currentSubcategory = filteredSubcategories.find(
    (s) => s.ProductSubcategoryID.toString() === form.ProductSubcategoryID,
  );
  const costNum = parseFloat(form.StandardCost);
  const priceNum = parseFloat(form.ListPrice);
  const costExceedsPrice =
    !isNaN(costNum) && !isNaN(priceNum) && costNum > priceNum;

  // ── Toggle a value in a set ───────────────────────────────────────────────
  const toggle = (
    arr: string[],
    val: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>,
  ) => {
    setter(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);
  };

  // ── Step indicator ────────────────────────────────────────────────────────
  const StepIndicator = () =>
    variationMode ? (
      <div
        className="flex items-center gap-2 mb-4"
        data-testid="wizard-step-indicator"
      >
        {[1, 2, 3].map((s) => (
          <React.Fragment key={s}>
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 ${
                s === wizardStep
                  ? "border-doodle-blue bg-doodle-blue text-white"
                  : s < wizardStep
                    ? "border-green-500 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300"
                    : "border-doodle-border text-doodle-text/50"
              }`}
            >
              {s}
            </div>
            {s < 3 && (
              <div
                className={`flex-1 h-0.5 ${s < wizardStep ? "bg-green-500" : "bg-doodle-border"}`}
              />
            )}
          </React.Fragment>
        ))}
        <span className="ml-2 text-xs text-doodle-text/60 font-doodle">
          {wizardStep === 1
            ? "Base Product"
            : wizardStep === 2
              ? "Select Variations"
              : "Preview & Create"}
        </span>
      </div>
    ) : null;

  // ── Render: Step 1 — Base Product Form ────────────────────────────────────
  const renderStep1 = () => (
    <>
      {/* Name */}
      <div>
        <label className="font-doodle text-sm text-doodle-text flex items-center gap-2 mb-1">
          Product Name *
          <span className="inline-flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
            <Globe className="w-3 h-3" /> US English
          </span>
        </label>
        <input
          type="text"
          name="Name"
          value={form.Name}
          onChange={handleChange}
          required
          maxLength={50}
          className="doodle-input w-full"
          placeholder="e.g. Mountain Bike Pro 500"
        />
      </div>

      {/* SKU — only for single mode */}
      {!variationMode && (
        <div>
          <label className="font-doodle text-sm text-doodle-text block mb-1">
            Product Number (SKU) *
          </label>
          <input
            type="text"
            name="ProductNumber"
            value={form.ProductNumber}
            onChange={handleChange}
            required
            maxLength={25}
            className="doodle-input w-full font-mono"
            placeholder="e.g. MB-5000-BK"
          />
        </div>
      )}

      {/* Standard Cost → List Price */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm text-doodle-text block mb-1">
            Standard Cost ($) *
            {variationMode && (
              <span className="ml-1 text-xs text-doodle-text/50 font-normal">
                (base — +5% per size step)
              </span>
            )}
          </label>
          <input
            type="number"
            name="StandardCost"
            value={form.StandardCost}
            onChange={handleStandardCostChange}
            required
            min="0"
            step="0.01"
            className="doodle-input w-full"
            placeholder="0.00"
          />
        </div>
        <div>
          <label className="font-doodle text-sm text-doodle-text block mb-1">
            List Price ($) *
            <span className="ml-1 text-xs text-doodle-text/50 font-normal">
              (≥ cost, auto-fills +20%)
            </span>
          </label>
          <input
            type="number"
            name="ListPrice"
            value={form.ListPrice}
            onChange={handleChange}
            required
            min={form.StandardCost || "0"}
            step="0.01"
            className="doodle-input w-full"
            placeholder="0.00"
          />
        </div>
      </div>
      {costExceedsPrice && (
        <p className="text-xs text-red-600 dark:text-red-400 -mt-2">
          Standard Cost cannot exceed List Price.
        </p>
      )}

      {/* Category + Subcategory */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm text-doodle-text block mb-1">
            Category *
          </label>
          <select
            value={selectedCategoryId}
            onChange={handleCategoryChange}
            required
            className="doodle-input w-full"
          >
            <option value="">Select a category…</option>
            {categories.map((cat) => (
              <option key={cat.ProductCategoryID} value={cat.ProductCategoryID}>
                {cat.Name}
              </option>
            ))}
          </select>
          {selectedCategoryId !== "" && (
            <Link
              to={`/category/${selectedCategoryId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-doodle-blue hover:underline mt-1"
            >
              <ExternalLink className="w-3 h-3" /> Edit this category
            </Link>
          )}
        </div>

        <div>
          <label className="font-doodle text-sm text-doodle-text block mb-1">
            Subcategory *
          </label>
          <select
            name="ProductSubcategoryID"
            value={form.ProductSubcategoryID}
            onChange={handleChange}
            required
            disabled={!selectedCategoryId}
            className="doodle-input w-full disabled:opacity-50"
          >
            <option value="">
              {selectedCategoryId
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
          {currentSubcategory && (
            <Link
              to="/categories"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-doodle-blue hover:underline mt-1"
            >
              <ExternalLink className="w-3 h-3" /> Manage subcategories
            </Link>
          )}
        </div>
      </div>

      {/* Color + Size — only in single mode; wizard picks these in step 2 */}
      {!variationMode && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="font-doodle text-sm text-doodle-text block mb-1">
              Color
            </label>
            <select
              name="Color"
              value={form.Color}
              onChange={handleChange}
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
              name="Size"
              value={form.Size}
              onChange={handleChange}
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
      )}

      {/* Weight + Initial Stock */}
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
              name="Weight"
              value={form.Weight}
              onChange={handleChange}
              min="0"
              step="0.01"
              className="doodle-input flex-1 min-w-0"
              placeholder={weightUnit === "lb" ? "e.g. 14.3" : "e.g. 6.5"}
            />
            <select
              value={weightUnit}
              onChange={(e) =>
                handleWeightUnitChange(e.target.value as "lb" | "kg")
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
            Initial Stock
            <span className="ml-1 text-xs text-doodle-text/50 font-normal">
              (units)
            </span>
          </label>
          <input
            type="number"
            name="InitialQuantity"
            value={form.InitialQuantity}
            onChange={(e) => {
              const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
              setForm((prev) => ({
                ...prev,
                InitialQuantity: String(v),
              }));
            }}
            min="0"
            max="32767"
            step="1"
            className="doodle-input w-full"
            placeholder="0"
          />
        </div>
      </div>

      {/* Product Line / Class / Style */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="font-doodle text-sm text-doodle-text block mb-1">
            Product Line
          </label>
          <select
            name="ProductLine"
            value={form.ProductLine}
            onChange={handleChange}
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
            name="Class"
            value={form.Class}
            onChange={handleChange}
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
            {variationMode && (
              <span className="ml-1 text-xs text-doodle-text/50 font-normal">
                (default)
              </span>
            )}
          </label>
          <select
            name="Style"
            value={form.Style}
            onChange={handleChange}
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

      {/* Generate using AI */}
      <div className="flex items-start gap-3 p-3 rounded border border-dashed border-doodle-blue bg-blue-50/50 dark:bg-blue-900/10">
        <Sparkles className="w-5 h-5 text-doodle-blue mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-doodle text-sm font-semibold text-doodle-blue">
            Generate using AI
          </p>
          <p className="text-xs text-doodle-text/60 mt-0.5">
            Category and Subcategory are required. Product Line, Class, and
            Style improve results.
          </p>
        </div>
        <button
          type="button"
          onClick={handleGenerateWithAI}
          disabled={
            isGenerating || !selectedCategoryId || !form.ProductSubcategoryID
          }
          className="doodle-button doodle-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm shrink-0 disabled:opacity-50"
          data-testid="generate-ai-btn"
        >
          {isGenerating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          {isGenerating ? "Generating…" : "Generate"}
        </button>
      </div>

      {/* Description */}
      <div>
        <label className="font-doodle text-sm text-doodle-text flex items-center gap-2 mb-1">
          Description *
          <span className="inline-flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
            <Globe className="w-3 h-3" /> US English
          </span>
        </label>
        <textarea
          name="Description"
          value={form.Description}
          onChange={handleChange}
          required
          maxLength={400}
          rows={3}
          className="doodle-input w-full"
          placeholder="Describe this product — other languages auto-translated after creation"
        />
      </div>
    </>
  );

  // ── Render: Step 2 — Select Variation Dimensions ──────────────────────────
  const renderStep2 = () => (
    <div className="space-y-5" data-testid="wizard-step-2">
      {/* Colors */}
      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
          Colors *{" "}
          <span className="font-normal text-xs text-doodle-text/50">
            ({selectedColors.length} selected)
          </span>
        </label>
        <div className="flex flex-wrap gap-2" data-testid="variation-colors">
          {PRODUCT_COLORS.map((c) => (
            <label
              key={c}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border cursor-pointer text-sm transition-colors ${
                selectedColors.includes(c)
                  ? "bg-doodle-blue/10 border-doodle-blue text-doodle-blue font-semibold"
                  : "border-doodle-border text-doodle-text hover:bg-doodle-bg/50"
              }`}
            >
              <input
                type="checkbox"
                checked={selectedColors.includes(c)}
                onChange={() => toggle(selectedColors, c, setSelectedColors)}
                className="sr-only"
                data-testid={`color-checkbox-${c}`}
              />
              {c}
            </label>
          ))}
        </div>
        {selectedColors.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            Select at least one color.
          </p>
        )}
      </div>

      {/* Sizes */}
      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
          Sizes *{" "}
          <span className="font-normal text-xs text-doodle-text/50">
            ({selectedSizes.length} selected)
          </span>
        </label>
        <div className="flex flex-wrap gap-2" data-testid="variation-sizes">
          {PRODUCT_SIZES.map((s) => (
            <label
              key={s}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border cursor-pointer text-sm transition-colors ${
                selectedSizes.includes(s)
                  ? "bg-doodle-blue/10 border-doodle-blue text-doodle-blue font-semibold"
                  : "border-doodle-border text-doodle-text hover:bg-doodle-bg/50"
              }`}
            >
              <input
                type="checkbox"
                checked={selectedSizes.includes(s)}
                onChange={() => toggle(selectedSizes, s, setSelectedSizes)}
                className="sr-only"
                data-testid={`size-checkbox-${s}`}
              />
              {s}
            </label>
          ))}
        </div>
        {selectedSizes.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            Select at least one size.
          </p>
        )}
      </div>

      {/* Styles (optional) */}
      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
          Styles{" "}
          <span className="font-normal text-xs text-doodle-text/50">
            (optional — {selectedStyles.length} selected, otherwise uses base
            style)
          </span>
        </label>
        <div className="flex flex-wrap gap-2" data-testid="variation-styles">
          {PRODUCT_STYLES.map((ps) => (
            <label
              key={ps.value}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border cursor-pointer text-sm transition-colors ${
                selectedStyles.includes(ps.value)
                  ? "bg-doodle-blue/10 border-doodle-blue text-doodle-blue font-semibold"
                  : "border-doodle-border text-doodle-text hover:bg-doodle-bg/50"
              }`}
            >
              <input
                type="checkbox"
                checked={selectedStyles.includes(ps.value)}
                onChange={() =>
                  toggle(selectedStyles, ps.value, setSelectedStyles)
                }
                className="sr-only"
                data-testid={`style-checkbox-${ps.value}`}
              />
              {ps.label}
            </label>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="p-3 bg-doodle-bg/50 rounded border border-doodle-border text-sm">
        <strong>Total variations:</strong>{" "}
        <span data-testid="variation-total-count">
          {selectedColors.length} color(s) × {selectedSizes.length} size(s)
          {selectedStyles.length > 0
            ? ` × ${selectedStyles.length} style(s)`
            : ""}{" "}
          ={" "}
          <strong>
            {selectedColors.length *
              selectedSizes.length *
              Math.max(selectedStyles.length, 1)}
          </strong>
        </span>
      </div>

      {/* Image generation info */}
      <div className="flex items-start gap-2 p-3 rounded border border-doodle-blue/40 bg-blue-50/50 dark:bg-blue-900/10 text-xs text-doodle-text/70">
        <Sparkles className="w-4 h-4 text-doodle-blue shrink-0 mt-0.5" />
        <span>
          <strong className="text-doodle-blue">
            AI images are shared within each Color + Style group.
          </strong>{" "}
          One set of 4 images will be generated per unique Color/Style
          combination and reused across all sizes — keeping costs low without
          sacrificing visual quality.
        </span>
      </div>
    </div>
  );

  // ── Render: Step 3 — Preview & Confirm ────────────────────────────────────
  const renderStep3 = () => {
    // Compute which rows are the "image representative" for their Color+Style group
    const seenVisualKeys = new Set<string>();
    const rowImageRole = variationRows.map((row) => {
      const key = `${row.Color ?? "none"}:${row.Style ?? "none"}`;
      if (!seenVisualKeys.has(key)) {
        seenVisualKeys.add(key);
        return "generate"; // This row triggers new AI image generation
      }
      return "reuse"; // This row will reuse images from the representative above
    });

    return (
      <div className="space-y-4" data-testid="wizard-step-3">
        <p className="font-doodle text-sm text-doodle-text">
          Review the <strong>{variationRows.length}</strong> variation(s) below.
          Cost escalation: +5% per size step from smallest selected.
        </p>

        <div className="flex items-start gap-2 p-2.5 rounded border border-doodle-blue/40 bg-blue-50/40 dark:bg-blue-900/10 text-xs text-doodle-text/70">
          <Sparkles className="w-3.5 h-3.5 text-doodle-blue shrink-0 mt-0.5" />
          <span>
            <strong className="text-doodle-blue">
              {seenVisualKeys.size} image set
              {seenVisualKeys.size !== 1 ? "s" : ""} will be generated
            </strong>{" "}
            (one per Color + Style). Rows marked{" "}
            <span className="text-doodle-text/50 italic">shared</span> reuse
            images from the same visual group.
          </span>
        </div>

        <div className="max-h-[35vh] overflow-auto border border-doodle-border rounded">
          <table
            className="w-full text-sm"
            data-testid="variation-preview-table"
          >
            <thead className="bg-doodle-bg/60 sticky top-0">
              <tr className="text-left">
                <th className="px-2 py-1.5 font-doodle">#</th>
                <th className="px-2 py-1.5 font-doodle">Color</th>
                <th className="px-2 py-1.5 font-doodle">Size</th>
                <th className="px-2 py-1.5 font-doodle">Style</th>
                <th className="px-2 py-1.5 font-doodle">Images</th>
                <th className="px-2 py-1.5 font-doodle text-right">Cost</th>
                <th className="px-2 py-1.5 font-doodle text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {variationRows.map((row, i) => (
                <tr
                  key={row.ProductNumber}
                  className="border-t border-doodle-border/50 hover:bg-doodle-bg/30"
                >
                  <td className="px-2 py-1">{i + 1}</td>
                  <td className="px-2 py-1">{row.Color ?? "—"}</td>
                  <td className="px-2 py-1">{row.Size ?? "—"}</td>
                  <td className="px-2 py-1">
                    {row.Style ? (STYLE_LABEL[row.Style] ?? row.Style) : "—"}
                  </td>
                  <td className="px-2 py-1">
                    {rowImageRole[i] === "generate" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-doodle-blue">
                        <Sparkles className="w-3 h-3" /> AI
                      </span>
                    ) : (
                      <span className="text-xs text-doodle-text/40 italic">
                        shared
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right">
                    ${row.StandardCost.toFixed(2)}
                  </td>
                  <td className="px-2 py-1 text-right">
                    ${row.ListPrice.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {batchProgress && (
          <div className="space-y-1" data-testid="batch-progress">
            <div className="w-full bg-doodle-border rounded-full h-2.5">
              <div
                className="bg-doodle-blue h-2.5 rounded-full transition-all"
                style={{
                  width: `${(batchProgress.completed / batchProgress.total) * 100}%`,
                }}
              />
            </div>
            <p className="text-xs text-doodle-text/60 font-doodle text-center">
              Creating {batchProgress.completed} / {batchProgress.total}…
            </p>
          </div>
        )}
      </div>
    );
  };

  // ── Footer buttons (contextual) ──────────────────────────────────────────
  const renderActions = () => {
    // Single-product mode
    if (!variationMode) {
      return (
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSaving}
            className="doodle-button flex-1 py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="doodle-button doodle-button-primary flex-1 py-2 flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <Plus className="w-4 h-4" />
            {isSaving ? "Creating…" : "Create Product"}
          </button>
        </div>
      );
    }

    // Wizard mode
    return (
      <div className="flex gap-3 pt-2">
        {wizardStep > 1 && (
          <button
            type="button"
            onClick={() => setWizardStep((s) => s - 1)}
            disabled={isSaving}
            className="doodle-button py-2 px-4 flex items-center gap-1"
            data-testid="wizard-back-btn"
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
        )}
        <button
          type="button"
          onClick={handleClose}
          disabled={isSaving}
          className="doodle-button flex-1 py-2"
        >
          Cancel
        </button>
        {wizardStep < 3 && (
          <button
            type="button"
            onClick={() => setWizardStep((s) => s + 1)}
            disabled={
              (wizardStep === 1 && !isStep1Valid()) ||
              (wizardStep === 2 && !isStep2Valid())
            }
            className="doodle-button doodle-button-primary py-2 px-4 flex items-center gap-1 disabled:opacity-60"
            data-testid="wizard-next-btn"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        )}
        {wizardStep === 3 && (
          <button
            type="button"
            onClick={handleBatchSubmit}
            disabled={isSaving || variationRows.length === 0}
            className="doodle-button doodle-button-primary flex-1 py-2 flex items-center justify-center gap-2 disabled:opacity-60"
            data-testid="wizard-create-all-btn"
          >
            <Layers className="w-4 h-4" />
            {isSaving
              ? "Creating…"
              : `Create ${variationRows.length} Variation(s)`}
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <button
        onClick={handleOpen}
        className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
        data-testid="create-product-btn"
      >
        <Plus className="w-4 h-4" />
        Create Product
      </button>

      {isOpen &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="doodle-card w-full max-w-2xl p-6 max-h-[92vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-doodle text-xl font-bold text-doodle-text">
                  {variationMode
                    ? "Create Product Variations"
                    : "Create New Product"}
                </h2>
                <button onClick={handleClose} className="doodle-button p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Variation mode toggle */}
              <label
                className="inline-flex items-center gap-2 mb-4 cursor-pointer select-none"
                data-testid="variation-mode-toggle"
              >
                <input
                  type="checkbox"
                  checked={variationMode}
                  onChange={(e) => {
                    setVariationMode(e.target.checked);
                    setWizardStep(1);
                    setSelectedColors([]);
                    setSelectedSizes([]);
                    setSelectedStyles([]);
                  }}
                  disabled={isSaving}
                  className="w-4 h-4 rounded border-doodle-border text-doodle-blue focus:ring-doodle-blue"
                />
                <span className="font-doodle text-sm text-doodle-text">
                  Create multiple variations
                </span>
              </label>

              <StepIndicator />

              <form
                onSubmit={
                  variationMode ? (e) => e.preventDefault() : handleSubmit
                }
                className="space-y-4"
              >
                {/* Step content */}
                {wizardStep === 1 && renderStep1()}
                {variationMode && wizardStep === 2 && renderStep2()}
                {variationMode && wizardStep === 3 && renderStep3()}

                {/* Actions */}
                {renderActions()}
              </form>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

export default CreateProductDialog;
