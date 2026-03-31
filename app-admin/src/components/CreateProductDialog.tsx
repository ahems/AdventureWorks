import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate, Link } from "react-router-dom";
import { Plus, Globe, X, ExternalLink } from "lucide-react";
import {
  useCreateProduct,
  useAdminCategories,
  useAdminSubcategoriesByCategory,
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

/** Generate a short GUID-derived SKU safe for the 25-char DB column. */
const generateSku = (): string => {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
  return `${hex()}-${hex()}-${hex()}`;
};

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
  const [weightUnit, setWeightUnit] = useState<"lb" | "kg">("lb");

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

  const handleOpen = () => {
    setSelectedCategoryId(defaultCategoryId ?? "");
    setForm(emptyForm());
    setWeightUnit("lb");
    setIsOpen(true);
  };

  const handleClose = () => {
    if (!isSaving) setIsOpen(false);
  };

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
      });
      toast({
        title: "Product Created",
        description: `${form.Name} was created. Add images on the next page.`,
      });
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

  const currentSubcategory = filteredSubcategories.find(
    (s) => s.ProductSubcategoryID.toString() === form.ProductSubcategoryID,
  );
  const costNum = parseFloat(form.StandardCost);
  const priceNum = parseFloat(form.ListPrice);
  const costExceedsPrice =
    !isNaN(costNum) && !isNaN(priceNum) && costNum > priceNum;

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
              <div className="flex items-center justify-between mb-5">
                <h2 className="font-doodle text-xl font-bold text-doodle-text">
                  Create New Product
                </h2>
                <button onClick={handleClose} className="doodle-button p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
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

                {/* SKU */}
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

                {/* Standard Cost → List Price */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      Standard Cost ($) *
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
                        <option
                          key={cat.ProductCategoryID}
                          value={cat.ProductCategoryID}
                        >
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
                        <ExternalLink className="w-3 h-3" /> Manage
                        subcategories
                      </Link>
                    )}
                  </div>
                </div>

                {/* Color + Size */}
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
                        className="doodle-input flex-1"
                        placeholder={
                          weightUnit === "lb" ? "e.g. 14.3" : "e.g. 6.5"
                        }
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
                        const v = Math.max(
                          0,
                          Math.floor(Number(e.target.value) || 0),
                        );
                        setForm((prev) => ({
                          ...prev,
                          InitialQuantity: String(v),
                        }));
                      }}
                      min="0"
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

                {/* Actions */}
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
              </form>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

export default CreateProductDialog;
