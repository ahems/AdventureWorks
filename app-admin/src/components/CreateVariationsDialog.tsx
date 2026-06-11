import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  Sparkles,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  useCreateProductBatch,
  type BatchProgress,
} from "@/hooks/useAdminProducts";
import type { SiblingProduct } from "@/hooks/useAdminProducts";
import {
  PRODUCT_COLORS,
  PRODUCT_SIZES,
  PRODUCT_STYLES,
} from "@/lib/product-constants";
import {
  generateVariations,
  type VariationRow,
} from "@/lib/variation-generator";
import { getFunctionsApiUrl } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { translateProductContent } from "@/services/utilityService";

const STYLE_LABEL: Record<string, string> = Object.fromEntries(
  PRODUCT_STYLES.map((s) => [s.value, s.label]),
);

interface CreateVariationsDialogProps {
  /** Allow the parent to control open state (e.g. from a separate link) */
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
  product: {
    ProductID: number;
    Name: string;
    ListPrice: number;
    StandardCost: number;
    Color: string | null;
    Size: string | null;
    Weight: number | null;
    ProductLine: string | null;
    Class: string | null;
    Style: string | null;
    ProductSubcategoryID: number | null;
    ProductModelID: number | null;
  };
  description: string;
  /** Already-existing sibling products — used to filter out taken combos */
  siblingProducts: SiblingProduct[];
}

const CreateVariationsDialog: React.FC<CreateVariationsDialogProps> = ({
  product,
  description,
  siblingProducts,
  externalOpen,
  onExternalOpenChange,
}) => {
  const navigate = useNavigate();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = externalOpen !== undefined ? externalOpen : internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    onExternalOpenChange?.(v);
  };
  const [wizardStep, setWizardStep] = useState(1); // 1=dimensions, 2=preview
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);

  const createBatch = useCreateProductBatch();

  // Build the set of already-taken Color|Style|Size combinations from siblings
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

  const isTaken = (c: string | null, st: string | null, sz: string | null) =>
    takenSet.has(`${c ?? ""}|${st ?? ""}|${sz ?? ""}`);

  // Generate all candidate rows, then filter out already-existing combinations.
  // The base product's own Color|Style|Size is implicitly excluded via siblings;
  // generateVariations ignores the current product since siblings don't include it.
  const allVariationRows: VariationRow[] = useMemo(() => {
    if (selectedColors.length === 0 || selectedSizes.length === 0) return [];
    const cost = product.StandardCost;
    if (!cost || cost <= 0) return [];
    return generateVariations({
      baseName: product.Name,
      baseStandardCost: cost,
      baseListPrice: product.ListPrice || cost * 1.2,
      productSubcategoryID: product.ProductSubcategoryID ?? 0,
      description,
      weight: product.Weight,
      productLine: product.ProductLine,
      class_: product.Class,
      baseStyle: product.Style,
      initialQuantity: 0,
      colors: selectedColors,
      sizes: selectedSizes,
      styles: selectedStyles,
    });
  }, [product, description, selectedColors, selectedSizes, selectedStyles]);

  // Filter out already-taken combinations (including the product itself)
  const newVariationRows = useMemo(() => {
    // Also exclude the current product's own combination
    const currentKey = `${((product.Color as string | null | undefined) ?? "").trim()}|${(product.Style ?? "").trim()}|${((product.Size as string | null | undefined) ?? "").trim()}`;
    return allVariationRows.filter((row) => {
      const key = `${row.Color ?? ""}|${row.Style ?? ""}|${row.Size ?? ""}`;
      return key !== currentKey && !isTaken(row.Color, row.Style, row.Size);
    });
  }, [allVariationRows, takenSet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Count how many of the selected combos already exist (taken + current)
  const skippedCount = allVariationRows.length - newVariationRows.length;

  const toggle = (
    arr: string[],
    val: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>,
  ) => setter(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  const isStep1Valid = () =>
    selectedColors.length > 0 &&
    selectedSizes.length > 0 &&
    newVariationRows.length > 0;

  const handleOpen = () => {
    setWizardStep(1);
    setSelectedColors([]);
    setSelectedSizes([]);
    setSelectedStyles([]);
    setBatchProgress(null);
    setOpen(true);
  };

  const handleClose = () => {
    if (!isSaving) setOpen(false);
  };

  const handleCreate = async () => {
    if (newVariationRows.length === 0) return;
    setIsSaving(true);
    setBatchProgress({ completed: 0, total: newVariationRows.length });

    try {
      // Attach the existing ProductModelID so all new variations join the same model
      const itemsWithModel = newVariationRows.map((row) => ({
        ...row,
        ProductModelID: product.ProductModelID ?? null,
        // If no model yet, pass the description so the batch hook creates one
        Description: product.ProductModelID ? undefined : description,
      }));

      const batchResult = await createBatch.mutateAsync({
        items: itemsWithModel,
        onProgress: setBatchProgress,
      });

      toast({
        title: "Variations Created",
        description: `Created ${newVariationRows.length} new variation(s) for "${product.Name}". AI images and translations are generating in the background.`,
      });

      // Trigger translations for the shared model
      const modelId = batchResult.sharedModelId ?? product.ProductModelID;
      if (modelId) {
        translateProductContent([modelId]).catch(() => {});
      }

      // Trigger AI image generation for first product in each unique Color+Style group
      const seenVisualKeys = new Set<string>();
      for (const p of batchResult.results) {
        const styleVal = (p as { Style?: string | null }).Style ?? "none";
        const visualKey = `${(p as { Color?: string | null }).Color ?? "none"}:${styleVal}`;
        if (!seenVisualKeys.has(visualKey)) {
          seenVisualKeys.add(visualKey);
          fetch(
            `${getFunctionsApiUrl()}/api/products/${p.ProductID}/generate-images`,
            { method: "POST" },
          ).catch(() => {});
        }
      }

      setOpen(false);
      // Navigate to the first newly created product
      if (batchResult.results[0]) {
        navigate(`/product/${batchResult.results[0].ProductID}`);
      }
    } catch {
      toast({
        title: "Create Failed",
        description:
          "An error occurred while creating variations. Some may have been created.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
      setBatchProgress(null);
    }
  };

  // ── Step 1 — Select Dimensions ───────────────────────────────────────────
  const renderStep1 = () => (
    <div className="space-y-5">
      {/* Colors */}
      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
          Colors *{" "}
          <span className="font-normal text-xs text-doodle-text/50">
            ({selectedColors.length} selected)
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
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
        <div className="flex flex-wrap gap-2">
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

      {/* Styles */}
      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
          Styles{" "}
          <span className="font-normal text-xs text-doodle-text/50">
            (optional — {selectedStyles.length} selected, otherwise uses current
            style:{" "}
            {STYLE_LABEL[product.Style?.trim() ?? ""] ??
              product.Style?.trim() ??
              "None"}
            )
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
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
              />
              {ps.label}
            </label>
          ))}
        </div>
      </div>

      {/* Summary */}
      {selectedColors.length > 0 && selectedSizes.length > 0 && (
        <div className="p-3 bg-doodle-bg/50 rounded border border-doodle-border text-sm space-y-1">
          <div>
            <strong>Total selected combinations:</strong>{" "}
            {selectedColors.length} × {selectedSizes.length}
            {selectedStyles.length > 0
              ? ` × ${selectedStyles.length}`
              : ""} ={" "}
            <strong>
              {selectedColors.length *
                selectedSizes.length *
                Math.max(selectedStyles.length, 1)}
            </strong>
          </div>
          {skippedCount > 0 && (
            <div className="text-amber-700 dark:text-amber-400 text-xs">
              ⚠ {skippedCount} combination{skippedCount !== 1 ? "s" : ""}{" "}
              already exist and will be skipped.
            </div>
          )}
          <div className="text-green-700 dark:text-green-400 font-semibold">
            {newVariationRows.length} new variation
            {newVariationRows.length !== 1 ? "s" : ""} will be created.
          </div>
          {newVariationRows.length === 0 && (
            <div className="text-amber-600 dark:text-amber-400 text-xs">
              All selected combinations already exist. Choose different colors,
              sizes, or styles.
            </div>
          )}
        </div>
      )}

      <div className="flex items-start gap-2 p-3 rounded border border-doodle-blue/40 bg-blue-50/50 dark:bg-blue-900/10 text-xs text-doodle-text/70">
        <Sparkles className="w-4 h-4 text-doodle-blue shrink-0 mt-0.5" />
        <span>
          <strong className="text-doodle-blue">
            AI images are shared within each Color + Style group.
          </strong>{" "}
          One set of 4 images will be generated per unique Color/Style
          combination and reused across sizes.
        </span>
      </div>
    </div>
  );

  // ── Step 2 — Preview & Confirm ───────────────────────────────────────────
  const renderStep2 = () => {
    const seenVisualKeys = new Set<string>();
    const rowImageRole = newVariationRows.map((row) => {
      const key = `${row.Color ?? "none"}:${row.Style ?? "none"}`;
      if (!seenVisualKeys.has(key)) {
        seenVisualKeys.add(key);
        return "generate";
      }
      return "reuse";
    });

    return (
      <div className="space-y-4">
        <p className="font-doodle text-sm text-doodle-text">
          Review the <strong>{newVariationRows.length}</strong> new variation(s)
          to create. Cost escalation: +5% per size step from smallest selected.
        </p>

        <div className="flex items-start gap-2 p-2.5 rounded border border-doodle-blue/40 bg-blue-50/40 dark:bg-blue-900/10 text-xs text-doodle-text/70">
          <Sparkles className="w-3.5 h-3.5 text-doodle-blue shrink-0 mt-0.5" />
          <span>
            <strong className="text-doodle-blue">
              {seenVisualKeys.size} image set
              {seenVisualKeys.size !== 1 ? "s" : ""} will be generated
            </strong>{" "}
            (one per Color + Style). Rows marked{" "}
            <span className="italic text-doodle-text/50">shared</span> reuse
            images from the same visual group.
          </span>
        </div>

        <div className="max-h-[35vh] overflow-auto border border-doodle-border rounded">
          <table className="w-full text-sm">
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
              {newVariationRows.map((row, i) => (
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
          <div className="space-y-1">
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

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!isSaving) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          onClick={handleOpen}
          className="doodle-button w-full py-3 flex items-center justify-center gap-2 text-base font-bold border-doodle-blue text-doodle-blue hover:bg-doodle-blue/10"
        >
          <Layers className="w-5 h-5" />
          Add Additional Variations
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-doodle-blue" />
            Add Additional Variations
          </DialogTitle>
          <DialogDescription>
            Select dimensions to generate new variations of{" "}
            <strong>{product.Name}</strong>. Already-existing combinations are
            automatically excluded.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-2">
          {[1, 2].map((s) => (
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
              {s < 2 && (
                <div
                  className={`flex-1 h-0.5 ${s < wizardStep ? "bg-green-500" : "bg-doodle-border"}`}
                />
              )}
            </React.Fragment>
          ))}
          <span className="ml-2 text-xs text-doodle-text/60 font-doodle">
            {wizardStep === 1 ? "Select Dimensions" : "Preview & Create"}
          </span>
        </div>

        <div className="py-2">
          {wizardStep === 1 ? renderStep1() : renderStep2()}
        </div>

        {/* Footer buttons */}
        <div className="flex gap-3 pt-2">
          {wizardStep > 1 && (
            <button
              type="button"
              onClick={() => setWizardStep(1)}
              disabled={isSaving}
              className="doodle-button py-2 px-4 flex items-center gap-1"
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
          {wizardStep === 1 ? (
            <button
              type="button"
              onClick={() => setWizardStep(2)}
              disabled={!isStep1Valid()}
              className="doodle-button doodle-button-primary py-2 px-4 flex items-center gap-1 disabled:opacity-60"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={isSaving || newVariationRows.length === 0}
              className="doodle-button doodle-button-primary flex-1 py-2 flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <Layers className="w-4 h-4" />
                  Create {newVariationRows.length} Variation
                  {newVariationRows.length !== 1 ? "s" : ""}
                </>
              )}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CreateVariationsDialog;
