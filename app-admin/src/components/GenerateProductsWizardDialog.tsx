import React, { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles,
  X,
  ChevronRight,
  Loader2,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import {
  useAdminCategories,
  useAdminSubcategoriesByCategory,
  useCreateProduct,
  useCreateProductBatch,
} from "@/hooks/useAdminProducts";
import { toast } from "@/hooks/use-toast";
import {
  PRODUCT_COLORS,
  PRODUCT_LINES,
  PRODUCT_CLASSES,
  PRODUCT_STYLES,
  PRODUCT_SIZES,
} from "@/lib/product-constants";
import { generateVariations } from "@/lib/variation-generator";
import {
  generateProductContent,
  translateProductContent,
  generateReviewsWithReplies,
} from "@/services/utilityService";
import { getFunctionsApiUrl } from "@/lib/utils";

/** Generate a short GUID-derived SKU safe for the 25-char DB column. */
const generateSku = (): string => {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
  return `${hex()}-${hex()}-${hex()}`;
};

/** Pick a random element from an array. */
const pickRandom = <T,>(arr: T[]): T =>
  arr[Math.floor(Math.random() * arr.length)];

/** Pick a random element or null (50/50). */
const pickRandomOrNull = <T,>(arr: T[]): T | null =>
  Math.random() > 0.5 ? pickRandom(arr) : null;

interface LogEntry {
  message: string;
  type: "info" | "success" | "error" | "dim";
}

interface GenerateProductsWizardDialogProps {
  defaultCategoryId?: number;
  defaultSubcategoryId?: number;
  /** When true, hides the category/subcategory selectors and shows a count dropdown only. */
  lockSelection?: boolean;
  /** Display name for the locked category (avoids waiting for data load). */
  defaultCategoryName?: string;
  /** Display name for the locked subcategory (avoids waiting for data load). */
  defaultSubcategoryName?: string;
}

const GenerateProductsWizardDialog: React.FC<
  GenerateProductsWizardDialogProps
> = ({
  defaultCategoryId,
  defaultSubcategoryId,
  lockSelection = false,
  defaultCategoryName,
  defaultSubcategoryName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<"configure" | "running" | "done">(
    "configure",
  );
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | "">(
    defaultCategoryId ?? "",
  );
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<
    number | ""
  >(defaultSubcategoryId ?? "");
  const [productCount, setProductCount] = useState(3);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const logEndRef = useRef<HTMLDivElement>(null);
  const isRunning = useRef(false);

  const { data: categories = [] } = useAdminCategories();
  const { data: subcategories = [] } = useAdminSubcategoriesByCategory(
    selectedCategoryId as number,
  );

  const createProduct = useCreateProduct();
  const createBatch = useCreateProductBatch();

  const addLog = useCallback(
    (message: string, type: LogEntry["type"] = "info") => {
      setLog((prev) => [...prev, { message, type }]);
      setTimeout(
        () => logEndRef.current?.scrollIntoView({ behavior: "smooth" }),
        50,
      );
    },
    [],
  );

  const handleOpen = () => {
    setStep("configure");
    setLog([]);
    setProgress({ done: 0, total: 0 });
    setSelectedCategoryId(defaultCategoryId ?? "");
    setSelectedSubcategoryId(defaultSubcategoryId ?? "");
    setProductCount(3);
    setIsOpen(true);
  };

  const handleClose = () => {
    if (isRunning.current) return; // prevent close while generating
    setIsOpen(false);
  };

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedCategoryId(val === "" ? "" : parseInt(val));
    setSelectedSubcategoryId("");
  };

  const handleGenerate = async () => {
    if (!selectedCategoryId || !selectedSubcategoryId) return;

    const category = categories.find(
      (c) => c.ProductCategoryID === selectedCategoryId,
    )?.Name;
    const subcategory = subcategories.find(
      (s) => s.ProductSubcategoryID === selectedSubcategoryId,
    )?.Name;
    if (!category || !subcategory) return;

    setStep("running");
    setProgress({ done: 0, total: productCount });
    isRunning.current = true;
    setLog([]);

    addLog(
      `Starting AI generation of ${productCount} product(s) in "${category} > ${subcategory}"`,
      "info",
    );
    addLog(
      "Background tasks (images, translations, reviews) will continue after this wizard closes.",
      "dim",
    );

    let successCount = 0;

    for (let i = 0; i < productCount; i++) {
      addLog(`\n─── Product ${i + 1} of ${productCount} ───`, "info");

      try {
        // ── 1. Pick random attributes ────────────────────────────────────────
        const pickedColor = pickRandom(PRODUCT_COLORS);
        const pickedStyle = pickRandom(PRODUCT_STYLES);
        const pickedClass = pickRandomOrNull(PRODUCT_CLASSES);
        const pickedLine = pickRandomOrNull(PRODUCT_LINES);

        addLog(
          `Asking AI to design a ${pickedStyle.label} ${subcategory} [${pickedClass?.label ?? "no class"} / ${pickedLine?.label ?? "no line"}]…`,
          "dim",
        );

        // ── 2. Call AI generate-content (extended, with one retry) ──────────
        const aiParams = {
          category,
          subcategory,
          productLine: pickedLine?.label ?? null,
          class_: pickedClass?.label ?? null,
          style: pickedStyle.label,
          availableSizes: PRODUCT_SIZES,
          availableColors: PRODUCT_COLORS,
          availableStyles: PRODUCT_STYLES.map((s) => s.label),
        };
        let content = await generateProductContent(aiParams);

        if (!content.productName) {
          addLog("AI did not return a product name — retrying once…", "dim");
          content = await generateProductContent(aiParams);
        }

        if (!content.productName) {
          addLog(
            "AI did not return a product name after retry — skipping.",
            "error",
          );
          continue;
        }

        addLog(`AI created: "${content.productName}"`, "success");

        // ── 3. Determine variation dimensions ────────────────────────────────
        // Map AI-suggested style labels back to values
        const styleValueMap = Object.fromEntries(
          PRODUCT_STYLES.map((s) => [s.label.toLowerCase(), s.value]),
        );
        const suggestedStyleValues = content.suggestedStyles
          .map((lbl) => styleValueMap[lbl.toLowerCase()])
          .filter(Boolean) as string[];

        const hasSizeVariation = content.suggestedSizes.length > 1;
        const hasColorVariation = content.suggestedColors.length > 1;
        const hasStyleVariation = suggestedStyleValues.length > 1;
        const hasAnyVariation =
          hasSizeVariation || hasColorVariation || hasStyleVariation;

        const initialQty = Math.floor(Math.random() * 50) + 1;
        const weightLb =
          content.estimatedWeightLb > 0 ? content.estimatedWeightLb : null;
        const standardCost =
          content.suggestedStandardCost > 0
            ? content.suggestedStandardCost
            : parseFloat((Math.random() * 90 + 10).toFixed(2));
        const listPrice =
          content.suggestedListPrice >= standardCost
            ? content.suggestedListPrice
            : parseFloat((standardCost * 1.3).toFixed(2));

        // ── 4a. Batch with variations ─────────────────────────────────────────
        if (hasAnyVariation) {
          const variationRows = generateVariations({
            baseName: content.productName,
            baseStandardCost: standardCost,
            baseListPrice: listPrice,
            productSubcategoryID: selectedSubcategoryId as number,
            description: content.productDescription,
            weight: weightLb,
            productLine: pickedLine?.value ?? null,
            class_: pickedClass?.value ?? null,
            baseStyle: pickedStyle.value,
            initialQuantity: initialQty,
            colors: hasColorVariation ? content.suggestedColors : [pickedColor],
            sizes: hasSizeVariation ? content.suggestedSizes : [],
            styles: hasStyleVariation ? suggestedStyleValues : [],
          });

          if (variationRows.length === 0) {
            // Fallback to single
            addLog(
              "Variation generator returned 0 rows — creating single product.",
              "dim",
            );
            await createSingleProduct();
            continue;
          }

          addLog(
            `Creating ${variationRows.length} variation(s) (${content.suggestedSizes.length} sizes × ${hasColorVariation ? content.suggestedColors.length : 1} colours × ${hasStyleVariation ? suggestedStyleValues.length : 1} styles)…`,
            "dim",
          );

          const batchResult = await createBatch.mutateAsync({
            items: variationRows,
          });

          addLog(
            `Created ${batchResult.results.length} product variation(s).`,
            "success",
          );

          // Fire imagery for each unique colour+style pair
          const seenVisualKeys = new Set<string>();
          for (const p of batchResult.results) {
            const vk = `${(p as { Color?: string | null }).Color ?? "none"}:${(p as { Style?: string | null }).Style ?? "none"}`;
            if (!seenVisualKeys.has(vk)) {
              seenVisualKeys.add(vk);
              fetch(
                `${getFunctionsApiUrl()}/api/products/${p.ProductID}/generate-images`,
                { method: "POST" },
              ).catch(() => {});
            }
          }

          // Translations
          if (batchResult.sharedModelId) {
            translateProductContent([batchResult.sharedModelId]).catch(
              () => {},
            );
          }

          // Reviews + replies for the primary product
          const primaryId = batchResult.results[0]?.ProductID;
          if (primaryId) {
            generateReviewsWithReplies(primaryId);
          }
        } else {
          // ── 4b. Single product ───────────────────────────────────────────────
          await createSingleProduct();
        }

        async function createSingleProduct() {
          addLog("Creating single product…", "dim");
          const newProduct = await createProduct.mutateAsync({
            Name: content.productName,
            ProductNumber: generateSku(),
            StandardCost: standardCost,
            ListPrice: listPrice,
            ProductSubcategoryID: selectedSubcategoryId as number,
            Description: content.productDescription,
            Color: pickedColor,
            Style: pickedStyle.value,
            Class: pickedClass?.value ?? null,
            ProductLine: pickedLine?.value ?? null,
            Weight: weightLb,
            InitialQuantity: initialQty,
          });

          addLog(
            `Created "${newProduct.Name}" (ID ${newProduct.ProductID}).`,
            "success",
          );

          // Images
          fetch(
            `${getFunctionsApiUrl()}/api/products/${newProduct.ProductID}/generate-images`,
            { method: "POST" },
          ).catch(() => {});

          // Translations
          if (newProduct.ProductModelID) {
            translateProductContent([newProduct.ProductModelID]).catch(
              () => {},
            );
          }

          // Reviews + replies
          generateReviewsWithReplies(newProduct.ProductID);
        }

        successCount++;
      } catch (err) {
        addLog(
          `Error creating product ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }

      setProgress({ done: i + 1, total: productCount });
    }

    addLog(
      `\n✓ Done! ${successCount} of ${productCount} product(s) created. Images, translations, and reviews are being generated in the background.`,
      "success",
    );
    setStep("done");
    isRunning.current = false;

    toast({
      title: "AI Product Generation Complete",
      description: `${successCount} product(s) created in ${category} > ${subcategory}. Background tasks are running.`,
    });
  };

  // Resolved names for display in locked mode
  const lockedCategoryName =
    defaultCategoryName ??
    categories.find((c) => c.ProductCategoryID === defaultCategoryId)?.Name ??
    "";
  const lockedSubcategoryName =
    defaultSubcategoryName ??
    subcategories.find((s) => s.ProductSubcategoryID === defaultSubcategoryId)
      ?.Name ??
    "";

  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className="doodle-button doodle-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm shrink-0"
      >
        <Sparkles className="w-4 h-4" />
        {lockSelection ? "Generate Products with AI" : "Generate with AI"}
      </button>
    );
  }

  const canStart =
    selectedCategoryId !== "" &&
    selectedSubcategoryId !== "" &&
    productCount >= 1 &&
    productCount <= 10;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative bg-doodle-bg border-2 border-doodle-border shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b-2 border-doodle-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-doodle-blue" />
            <h2 className="font-doodle text-lg font-bold text-doodle-text">
              Generate Products with AI
            </h2>
          </div>
          {!isRunning.current && (
            <button
              onClick={handleClose}
              className="text-doodle-text/50 hover:text-doodle-text transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {step === "configure" && (
            <div className="space-y-4">
              <p className="font-doodle text-sm text-doodle-text/70">
                {lockSelection
                  ? "Choose how many products to generate. The wizard will use AI to design each one — complete with pricing, imagery, translations, and reviews — all automatically."
                  : "Tell the wizard which category and how many products to create. It will use AI to design each product — complete with pricing, imagery, translations, and reviews — all automatically."}
              </p>

              {lockSelection ? (
                /* Locked mode: show category/subcategory as read-only */
                <div className="bg-doodle-text/5 border border-doodle-border p-3 font-doodle text-sm space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-doodle-text/60">Category</span>
                    <span className="font-semibold text-doodle-text">
                      {lockedCategoryName}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-doodle-text/60">Subcategory</span>
                    <span className="font-semibold text-doodle-text">
                      {lockedSubcategoryName}
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  {/* Category */}
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      Category <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={selectedCategoryId}
                      onChange={handleCategoryChange}
                      className="doodle-input w-full"
                    >
                      <option value="">Select a category…</option>
                      {categories.map((cat) => (
                        <option
                          key={cat.ProductCategoryID}
                          value={cat.ProductCategoryID}
                        >
                          {cat.Name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Subcategory */}
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      Subcategory <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={selectedSubcategoryId}
                      onChange={(e) =>
                        setSelectedSubcategoryId(
                          e.target.value === "" ? "" : parseInt(e.target.value),
                        )
                      }
                      disabled={selectedCategoryId === ""}
                      className="doodle-input w-full disabled:opacity-50"
                    >
                      <option value="">Select a subcategory…</option>
                      {subcategories.map((sub) => (
                        <option
                          key={sub.ProductSubcategoryID}
                          value={sub.ProductSubcategoryID}
                        >
                          {sub.Name}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {/* Product count */}
              <div>
                <label className="font-doodle text-sm text-doodle-text block mb-1">
                  Number of products to generate{" "}
                  <span className="text-doodle-text/50">(1 – 10)</span>
                </label>
                {lockSelection ? (
                  <select
                    value={productCount}
                    onChange={(e) => setProductCount(parseInt(e.target.value))}
                    className="doodle-input w-full"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                      <option key={n} value={n}>
                        {n} product{n !== 1 ? "s" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={productCount}
                    onChange={(e) =>
                      setProductCount(
                        Math.max(
                          1,
                          Math.min(10, parseInt(e.target.value) || 1),
                        ),
                      )
                    }
                    className="doodle-input w-24"
                  />
                )}
              </div>

              {/* What happens info */}
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-3 text-xs font-doodle text-doodle-text/70 space-y-1">
                <p className="font-semibold text-doodle-text">
                  For each product, the wizard will:
                </p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>Ask AI to design name, description, price, and weight</li>
                  <li>Ask AI which sizes, colours, and styles make sense</li>
                  <li>Create the product with random initial stock (1–50)</li>
                  <li>Create variations if the AI recommends them</li>
                  <li>Generate product images in the background</li>
                  <li>Translate content to all supported languages</li>
                  <li>
                    Generate 1–10 AI customer reviews with selected replies
                  </li>
                </ul>
              </div>
            </div>
          )}

          {(step === "running" || step === "done") && (
            <div className="space-y-3">
              {/* Progress bar */}
              {step === "running" && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-doodle text-doodle-text/60">
                    <span>
                      Product {Math.min(progress.done + 1, progress.total)} of{" "}
                      {progress.total}
                    </span>
                    <span>
                      {Math.round((progress.done / progress.total) * 100)}%
                    </span>
                  </div>
                  <div className="h-2 bg-doodle-text/10 border border-doodle-border">
                    <div
                      className="h-full bg-doodle-blue transition-all duration-500"
                      style={{
                        width: `${(progress.done / progress.total) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {step === "done" && (
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                  <CheckCircle className="w-5 h-5 flex-shrink-0" />
                  <span className="font-doodle text-sm font-bold">
                    Generation complete! Background tasks are still running.
                  </span>
                </div>
              )}

              {/* Log */}
              <div className="bg-doodle-text/5 border border-doodle-border p-3 font-mono text-xs space-y-0.5 max-h-64 overflow-y-auto">
                {log.map((entry, idx) => (
                  <p
                    key={idx}
                    className={
                      entry.type === "success"
                        ? "text-green-600 dark:text-green-400"
                        : entry.type === "error"
                          ? "text-red-600 dark:text-red-400"
                          : entry.type === "dim"
                            ? "text-doodle-text/40"
                            : "text-doodle-text/80"
                    }
                  >
                    {entry.message}
                  </p>
                ))}
                {step === "running" && (
                  <p className="flex items-center gap-1 text-doodle-blue">
                    <Loader2 className="w-3 h-3 animate-spin inline" /> Working…
                  </p>
                )}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t-2 border-doodle-border flex-shrink-0 gap-3">
          {step === "configure" && (
            <>
              <button
                onClick={handleClose}
                className="doodle-button-secondary text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={!canStart}
                className="doodle-button flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-4 h-4" />
                Generate {productCount} Product{productCount !== 1 ? "s" : ""}
                <ChevronRight className="w-4 h-4" />
              </button>
            </>
          )}

          {step === "running" && (
            <div className="flex items-center gap-2 text-doodle-text/60 font-doodle text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating… please wait
            </div>
          )}

          {step === "done" && (
            <button
              onClick={handleClose}
              className="doodle-button ml-auto text-sm"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default GenerateProductsWizardDialog;
