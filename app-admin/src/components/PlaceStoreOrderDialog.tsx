import React, { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Plus,
  Minus,
  Trash2,
  Store,
  ShoppingCart,
  ChevronRight,
  CheckCircle,
  Loader2,
  Package,
  ExternalLink,
  ChevronLeft,
  AlertTriangle,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import {
  useShipMethods,
  usePlaceStoreOrder,
  useStoreProducts,
  useProductCatalog,
} from "@/hooks/useAdminStores";
import { StoreListItem, StoreOrderLineItem, StoreProductInfo } from "@/types/store";

interface PlaceStoreOrderDialogProps {
  store: StoreListItem;
  onClose: () => void;
  onSuccess?: (salesOrderId: number) => void;
  /** If provided, the cart is pre-populated (Reorder flow) */
  initialItems?: StoreOrderLineItem[];
}

type WizardStep = "products" | "details" | "review" | "done";

const STEP_LABELS: Record<WizardStep, string> = {
  products: "1. Select Products",
  details:  "2. Order Details",
  review:   "3. Review & Submit",
  done:     "Complete",
};

// Category emoji icons
const CAT_ICONS: Record<string, string> = {
  Bikes:        "🚲",
  Components:   "⚙️",
  Clothing:     "👕",
  Accessories:  "🎒",
};

// ── Stock warning helper ──────────────────────────────────────────────────────
function stockColor(stock: number) {
  if (stock <= 0)   return "text-red-600 bg-red-50 border-red-300";
  if (stock <= 10)  return "text-orange-600 bg-orange-50 border-orange-300";
  return "text-green-700 bg-green-50 border-green-300";
}

// ── Category nav (replaces search bar) ───────────────────────────────────────
const CategoryNav: React.FC<{
  selectedCategoryId: number | null;
  selectedSubcategoryId: number | null;
  onSelectCategory: (id: number | null) => void;
  onSelectSubcategory: (id: number | null) => void;
}> = ({ selectedCategoryId, selectedSubcategoryId, onSelectCategory, onSelectSubcategory }) => {
  const { data: catalog = [], isLoading } = useProductCatalog();

  const selectedCategory = catalog.find((c) => c.categoryID === selectedCategoryId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 font-doodle text-doodle-text/60 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading catalog…
      </div>
    );
  }

  // Category cards
  if (!selectedCategoryId) {
    return (
      <div>
        <p className="font-doodle text-sm text-doodle-text/50 mb-3">Select a category to browse products:</p>
        <div className="grid grid-cols-2 gap-3">
          {catalog.map((cat) => (
            <button
              key={cat.categoryID}
              onClick={() => onSelectCategory(cat.categoryID)}
              className="flex flex-col items-center justify-center p-4 border-2 border-doodle-text/30 hover:border-doodle-accent hover:bg-doodle-accent/5 transition-colors text-center"
            >
              <span className="text-3xl mb-2">{CAT_ICONS[cat.categoryName] ?? "📦"}</span>
              <span className="font-doodle font-bold text-doodle-text">{cat.categoryName}</span>
              <span className="font-doodle text-xs text-doodle-text/50 mt-1">{cat.productCount} products</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Subcategory pills
  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <button
          onClick={() => { onSelectCategory(null); onSelectSubcategory(null); }}
          className="flex items-center gap-1 font-doodle text-sm text-doodle-accent hover:underline"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> {selectedCategory?.categoryName}
        </button>
        <span className="text-doodle-text/30">/</span>
        {selectedSubcategoryId ? (
          <button
            onClick={() => onSelectSubcategory(null)}
            className="font-doodle text-sm text-doodle-text/60 hover:text-doodle-accent hover:underline"
          >
            All {selectedCategory?.categoryName}
          </button>
        ) : (
          <span className="font-doodle text-sm font-bold text-doodle-text">All</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onSelectSubcategory(null)}
          className={`font-doodle text-xs px-3 py-1.5 border-2 transition-colors ${
            !selectedSubcategoryId
              ? "border-doodle-accent bg-doodle-accent text-white"
              : "border-doodle-text/30 text-doodle-text hover:border-doodle-accent"
          }`}
        >
          All {selectedCategory?.categoryName}
        </button>
        {selectedCategory?.subcategories.map((sub) => (
          <button
            key={sub.subcategoryID}
            onClick={() => onSelectSubcategory(sub.subcategoryID)}
            className={`font-doodle text-xs px-3 py-1.5 border-2 transition-colors ${
              selectedSubcategoryId === sub.subcategoryID
                ? "border-doodle-accent bg-doodle-accent text-white"
                : "border-doodle-text/30 text-doodle-text hover:border-doodle-accent"
            }`}
          >
            {sub.subcategoryName}
            <span className="ml-1 opacity-60">({sub.productCount})</span>
          </button>
        ))}
      </div>
    </div>
  );
};

// ── Main dialog ───────────────────────────────────────────────────────────────
const PlaceStoreOrderDialog: React.FC<PlaceStoreOrderDialogProps> = ({
  store,
  onClose,
  onSuccess,
  initialItems,
}) => {
  const [step, setStep] = useState<WizardStep>(initialItems && initialItems.length > 0 ? "details" : "products");
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<number | null>(null);
  const [lineItems, setLineItems] = useState<StoreOrderLineItem[]>(initialItems ?? []);
  const [shipMethodId, setShipMethodId] = useState(0);
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState("");
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().split("T")[0];
  });
  const [comment, setComment] = useState(initialItems && initialItems.length > 0 ? "Reorder" : "");
  const [createdOrderId, setCreatedOrderId] = useState<number | null>(null);

  const { data: shipMethods = [] } = useShipMethods();
  const { data: products = [], isLoading: productsLoading } = useStoreProducts(
    undefined,
    selectedCategoryId,
    selectedSubcategoryId,
  );
  const placeOrder = usePlaceStoreOrder();

  // Build a map of productId → available stock to enforce limits
  const stockMap = useMemo(() => {
    const m: Record<number, number> = {};
    products.forEach((p) => { m[p.productID] = p.stockQty; });
    return m;
  }, [products]);

  const handleAddProduct = (product: StoreProductInfo) => {
    if (product.stockQty <= 0) return;
    setLineItems((prev) => {
      const existing = prev.find((i) => i.productId === product.productID);
      if (existing) {
        const newQty = Math.min(existing.quantity + 1, product.stockQty);
        return prev.map((i) =>
          i.productId === product.productID
            ? { ...i, quantity: newQty, lineTotal: newQty * i.unitPrice * (1 - i.discountPct) }
            : i,
        );
      }
      return [
        ...prev,
        {
          productId:     product.productID,
          productName:   product.productName,
          productNumber: product.productNumber,
          unitPrice:     product.unitPrice,
          quantity:      1,
          discountPct:   0,
          lineTotal:     product.unitPrice,
        },
      ];
    });
  };

  const handleQtyChange = (productId: number, delta: number) => {
    setLineItems((prev) =>
      prev
        .map((i) => {
          if (i.productId !== productId) return i;
          const maxStock = stockMap[productId] ?? 9999;
          const newQty = Math.min(Math.max(0, i.quantity + delta), maxStock);
          return { ...i, quantity: newQty, lineTotal: newQty * i.unitPrice * (1 - i.discountPct) };
        })
        .filter((i) => i.quantity > 0),
    );
  };

  const handleQtyInput = (productId: number, val: string) => {
    const maxStock = stockMap[productId] ?? 9999;
    const qty = Math.min(parseInt(val) || 0, maxStock);
    setLineItems((prev) =>
      prev
        .map((i) =>
          i.productId === productId
            ? { ...i, quantity: qty, lineTotal: qty * i.unitPrice * (1 - i.discountPct) }
            : i,
        )
        .filter((i) => i.quantity > 0),
    );
  };

  const handleDiscountChange = (productId: number, discountStr: string) => {
    const pct = Math.min(100, Math.max(0, parseFloat(discountStr) || 0)) / 100;
    setLineItems((prev) =>
      prev.map((i) =>
        i.productId === productId
          ? { ...i, discountPct: pct, lineTotal: i.quantity * i.unitPrice * (1 - pct) }
          : i,
      ),
    );
  };

  const handleRemove = (productId: number) => setLineItems((prev) => prev.filter((i) => i.productId !== productId));

  const subTotal = useMemo(() => lineItems.reduce((s, i) => s + i.lineTotal, 0), [lineItems]);
  const taxAmt   = subTotal * 0.0875;
  const freight  = lineItems.length === 0 ? 0 : lineItems.length <= 5 ? 15 : lineItems.length <= 20 ? 25 : 50;
  const totalDue = subTotal + taxAmt + freight;

  const handleSubmit = async () => {
    if (lineItems.length === 0) return;
    try {
      const result = await placeOrder.mutateAsync({
        storeBusinessEntityId: store.storeBusinessEntityId,
        items: lineItems.map((i) => ({
          productId:    i.productId,
          quantity:     i.quantity,
          unitPrice:    i.unitPrice,
          discountPct:  i.discountPct,
        })),
        shipMethodId,
        purchaseOrderNumber: purchaseOrderNumber.trim() || undefined,
        dueDate: dueDate || undefined,
        comment: comment.trim() || undefined,
      });
      setCreatedOrderId(result.salesOrderId);
      setStep("done");
      toast({ title: "Order placed!", description: result.message });
      onSuccess?.(result.salesOrderId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Failed to place order", description: msg, variant: "destructive" });
    }
  };

  const selectedShipMethod = shipMethods.find((m) => m.ShipMethodID === shipMethodId);

  const content = (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-4xl my-8 bg-doodle-bg border-4 border-doodle-text shadow-[8px_8px_0px_rgba(0,0,0,0.3)]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b-4 border-doodle-text bg-doodle-accent/10">
          <div>
            <h2 className="font-doodle font-bold text-2xl text-doodle-text flex items-center gap-2">
              <Store className="w-6 h-6" />
              {initialItems ? "Reorder" : "Place B2B Order"} — {store.storeName}
            </h2>
            <p className="font-doodle text-sm text-doodle-text/60 mt-1">
              {store.city && store.stateProvince ? `${store.city}, ${store.stateProvince}` : ""}
              {store.salesRepFirstName ? ` · Rep: ${store.salesRepFirstName} ${store.salesRepLastName}` : ""}
              {initialItems ? ` · ${initialItems.length} items pre-loaded from previous order` : ""}
            </p>
          </div>
          <button onClick={onClose} className="doodle-button p-2 hover:bg-red-100"><X className="w-5 h-5" /></button>
        </div>

        {/* Wizard steps tabs */}
        {step !== "done" && (
          <div className="flex border-b-4 border-doodle-text">
            {(["products", "details", "review"] as WizardStep[]).map((s, idx) => (
              <button
                key={s}
                onClick={() => {
                  const steps = ["products", "details", "review"];
                  const cur   = steps.indexOf(step);
                  const clicked = steps.indexOf(s);
                  if (clicked <= cur || lineItems.length > 0) setStep(s);
                }}
                className={`flex-1 py-3 font-doodle text-sm font-bold border-r-4 last:border-r-0 border-doodle-text transition-colors ${
                  step === s ? "bg-doodle-accent text-white" : "text-doodle-text/60 hover:bg-doodle-accent/10"
                }`}
              >
                {STEP_LABELS[s]}
              </button>
            ))}
          </div>
        )}

        <div className="p-6">
          {/* ── Step 1: Select Products ── */}
          {step === "products" && (
            <div className="flex gap-4">
              {/* Left: category nav + product grid */}
              <div className="flex-1 min-w-0">
                <CategoryNav
                  selectedCategoryId={selectedCategoryId}
                  selectedSubcategoryId={selectedSubcategoryId}
                  onSelectCategory={(id) => { setSelectedCategoryId(id); setSelectedSubcategoryId(null); }}
                  onSelectSubcategory={setSelectedSubcategoryId}
                />

                {/* Products table — only when a category is selected */}
                {selectedCategoryId !== null && (
                  <div className="mt-4 border-2 border-doodle-text max-h-72 overflow-y-auto">
                    {productsLoading ? (
                      <div className="flex items-center justify-center p-6 gap-2 text-doodle-text/60 font-doodle text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading products…
                      </div>
                    ) : products.length === 0 ? (
                      <div className="p-6 text-center font-doodle text-doodle-text/40 text-sm">No products found.</div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b-2 border-doodle-text bg-doodle-text/5 text-left">
                            <th className="font-doodle font-bold py-2 px-3">Product</th>
                            <th className="font-doodle font-bold py-2 px-3 text-right">Price</th>
                            <th className="font-doodle font-bold py-2 px-3 text-right">Stock</th>
                            <th className="py-2 px-3 w-8"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {products.map((p) => {
                            const inCart     = lineItems.find((i) => i.productId === p.productID);
                            const cartQty    = inCart?.quantity ?? 0;
                            const atMax      = cartQty >= p.stockQty;
                            const outOfStock = p.stockQty <= 0;
                            return (
                              <tr
                                key={p.productID}
                                className={`border-b border-doodle-text/20 ${outOfStock ? "opacity-50" : "hover:bg-doodle-accent/5"}`}
                              >
                                <td className="py-2 px-3">
                                  <div className="font-doodle font-medium text-doodle-text leading-tight">{p.productName}</div>
                                  <div className="font-doodle text-xs text-doodle-text/50">
                                    {p.productNumber}
                                    {p.color ? ` · ${p.color}` : ""}
                                    {p.size  ? ` · Sz ${p.size}` : ""}
                                    {p.subcategoryName ? ` · ${p.subcategoryName}` : ""}
                                  </div>
                                </td>
                                <td className="py-2 px-3 font-doodle font-bold text-right text-doodle-accent">
                                  ${p.unitPrice.toFixed(2)}
                                </td>
                                <td className="py-2 px-3 text-right">
                                  <span className={`font-doodle text-xs font-bold px-1.5 py-0.5 border ${stockColor(p.stockQty)}`}>
                                    {p.stockQty} {outOfStock ? "— out of stock" : cartQty > 0 ? `(${cartQty} in cart)` : ""}
                                  </span>
                                </td>
                                <td className="py-2 px-3">
                                  <button
                                    onClick={() => handleAddProduct(p)}
                                    disabled={outOfStock || atMax}
                                    title={outOfStock ? "Out of stock" : atMax ? "Cart qty = available stock" : "Add to order"}
                                    className="p-1.5 border border-doodle-text/40 hover:bg-doodle-accent hover:text-white hover:border-doodle-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>

              {/* Right: order cart sidebar */}
              <div className="w-72 shrink-0">
                <h3 className="font-doodle font-bold text-doodle-text mb-2 flex items-center gap-2">
                  <ShoppingCart className="w-4 h-4" />
                  Cart ({lineItems.length} line{lineItems.length !== 1 ? "s" : ""})
                </h3>
                {lineItems.length === 0 ? (
                  <div className="border-2 border-dashed border-doodle-text/30 p-6 text-center font-doodle text-doodle-text/40 text-sm">
                    Select a category and add products
                  </div>
                ) : (
                  <div className="border-2 border-doodle-text max-h-60 overflow-y-auto">
                    {lineItems.map((item) => {
                      const stockAvail = stockMap[item.productId];
                      const overStock  = stockAvail !== undefined && item.quantity > stockAvail;
                      return (
                        <div key={item.productId} className="flex items-center gap-2 p-2 border-b border-doodle-text/20 last:border-b-0">
                          <div className="flex-1 min-w-0">
                            <p className="font-doodle text-xs font-bold text-doodle-text truncate">{item.productName}</p>
                            <p className="font-doodle text-xs text-doodle-accent">${item.lineTotal.toFixed(2)}</p>
                            {overStock && (
                              <p className="font-doodle text-xs text-orange-600 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> Exceeds stock ({stockAvail})
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => handleQtyChange(item.productId, -1)} className="p-0.5 border border-doodle-text/30 hover:bg-doodle-accent/10"><Minus className="w-3 h-3" /></button>
                            <input
                              type="number"
                              min={1}
                              value={item.quantity}
                              onChange={(e) => handleQtyInput(item.productId, e.target.value)}
                              className="w-10 text-center border-2 border-doodle-text font-doodle text-xs py-0.5"
                            />
                            <button onClick={() => handleQtyChange(item.productId, 1)} className="p-0.5 border border-doodle-text/30 hover:bg-doodle-accent/10"><Plus className="w-3 h-3" /></button>
                            <button onClick={() => handleRemove(item.productId)} className="p-0.5 border border-red-300 hover:bg-red-50 text-red-600"><Trash2 className="w-3 h-3" /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {lineItems.length > 0 && (
                  <div className="mt-2 p-2 border-2 border-doodle-text bg-doodle-text/5">
                    <div className="flex justify-between font-doodle text-xs text-doodle-text/70"><span>Subtotal</span><span>${subTotal.toFixed(2)}</span></div>
                    <div className="flex justify-between font-doodle text-xs text-doodle-text/70"><span>Est. Tax (8.75%)</span><span>${taxAmt.toFixed(2)}</span></div>
                    <div className="flex justify-between font-doodle text-xs text-doodle-text/70"><span>Est. Freight</span><span>${freight.toFixed(2)}</span></div>
                    <div className="flex justify-between font-doodle text-sm font-bold text-doodle-text border-t-2 border-doodle-text mt-1 pt-1">
                      <span>Est. Total</span><span>${totalDue.toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 1 footer ── */}
          {step === "products" && (
            <div className="flex justify-end gap-3 pt-4 mt-4 border-t-2 border-doodle-text/20">
              <button onClick={onClose} className="doodle-button px-6 py-2">Cancel</button>
              <button
                disabled={lineItems.length === 0}
                onClick={() => setStep("details")}
                className="doodle-button doodle-button-primary px-6 py-2 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                Next: Order Details <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── Step 2: Order Details ── */}
          {step === "details" && (
            <div className="space-y-6 max-w-2xl">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="font-doodle font-bold text-doodle-text text-sm block mb-1">Shipping Method</label>
                  <select value={shipMethodId} onChange={(e) => setShipMethodId(Number(e.target.value))} className="doodle-input w-full">
                    <option value={0}>Cheapest available</option>
                    {shipMethods.map((m) => (
                      <option key={m.ShipMethodID} value={m.ShipMethodID}>{m.Name} (base ${m.ShipBase.toFixed(2)})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="font-doodle font-bold text-doodle-text text-sm block mb-1">Due Date (B2B Net Terms)</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="doodle-input w-full" />
                </div>
              </div>

              <div>
                <label className="font-doodle font-bold text-doodle-text text-sm block mb-1">Purchase Order Number (optional)</label>
                <input
                  type="text"
                  value={purchaseOrderNumber}
                  onChange={(e) => setPurchaseOrderNumber(e.target.value)}
                  placeholder="e.g. PO-2026-0042"
                  className="doodle-input w-full"
                  maxLength={25}
                />
                <p className="font-doodle text-xs text-doodle-text/50 mt-1">The store's PO number for their records</p>
              </div>

              <div>
                <label className="font-doodle font-bold text-doodle-text text-sm block mb-1">Internal Comment / Notes (optional)</label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="e.g. Urgent shipment — store called in. Contact: Jane Smith, ext 240."
                  className="doodle-input w-full h-24 resize-none"
                  maxLength={250}
                />
              </div>

              <div className="flex justify-between gap-3 pt-2 border-t-2 border-doodle-text/20">
                <button onClick={() => setStep("products")} className="doodle-button px-6 py-2">← Back</button>
                <button onClick={() => setStep("review")} className="doodle-button doodle-button-primary px-6 py-2 flex items-center gap-2">
                  Review Order <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Review ── */}
          {step === "review" && (
            <div className="space-y-6">
              <div className="doodle-card p-4">
                <h3 className="font-doodle font-bold text-doodle-text mb-2 flex items-center gap-2">
                  <Store className="w-4 h-4 text-doodle-accent" />
                  Store Account
                </h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="font-doodle text-doodle-text/60">Store:</span> <span className="font-doodle font-bold text-doodle-text">{store.storeName}</span></div>
                  <div><span className="font-doodle text-doodle-text/60">Territory:</span> <span className="font-doodle text-doodle-text">{store.territoryName ?? "—"}</span></div>
                  <div><span className="font-doodle text-doodle-text/60">Location:</span> <span className="font-doodle text-doodle-text">{[store.city, store.stateProvince].filter(Boolean).join(", ") || "—"}</span></div>
                  <div><span className="font-doodle text-doodle-text/60">Rep:</span> <span className="font-doodle text-doodle-text">{store.salesRepFirstName ? `${store.salesRepFirstName} ${store.salesRepLastName}` : "—"}</span></div>
                  {purchaseOrderNumber && <div><span className="font-doodle text-doodle-text/60">PO #:</span> <span className="font-doodle font-bold text-doodle-accent">{purchaseOrderNumber}</span></div>}
                  <div><span className="font-doodle text-doodle-text/60">Due Date:</span> <span className="font-doodle text-doodle-text">{dueDate}</span></div>
                  {selectedShipMethod && <div><span className="font-doodle text-doodle-text/60">Ship Via:</span> <span className="font-doodle text-doodle-text">{selectedShipMethod.Name}</span></div>}
                  {comment && <div className="col-span-2"><span className="font-doodle text-doodle-text/60">Notes:</span> <span className="font-doodle text-doodle-text italic">{comment}</span></div>}
                </div>
              </div>

              <div>
                <h3 className="font-doodle font-bold text-doodle-text mb-2 flex items-center gap-2">
                  <Package className="w-4 h-4 text-doodle-accent" />
                  Order Lines ({lineItems.length})
                </h3>
                <table className="w-full border-2 border-doodle-text text-sm">
                  <thead className="bg-doodle-text/5 border-b-2 border-doodle-text">
                    <tr>
                      <th className="font-doodle font-bold text-left py-2 px-3">Product</th>
                      <th className="font-doodle font-bold text-right py-2 px-3">Unit Price</th>
                      <th className="font-doodle font-bold text-right py-2 px-3">Disc.</th>
                      <th className="font-doodle font-bold text-right py-2 px-3">Qty</th>
                      <th className="font-doodle font-bold text-right py-2 px-3">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((item) => (
                      <tr key={item.productId} className="border-b border-doodle-text/20 last:border-b-0">
                        <td className="py-2 px-3">
                          <span className="font-doodle font-medium text-doodle-text">{item.productName}</span>
                          {item.productNumber && <span className="font-doodle text-xs text-doodle-text/50 ml-2">{item.productNumber}</span>}
                        </td>
                        <td className="py-2 px-3 font-doodle text-right text-doodle-text">${item.unitPrice.toFixed(2)}</td>
                        <td className="py-2 px-3 font-doodle text-right text-doodle-text/70">{(item.discountPct * 100).toFixed(0)}%</td>
                        <td className="py-2 px-3 font-doodle text-right text-doodle-text">{item.quantity}</td>
                        <td className="py-2 px-3 font-doodle font-bold text-right text-doodle-accent">${item.lineTotal.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-doodle-text bg-doodle-text/5">
                    <tr><td colSpan={4} className="py-2 px-3 font-doodle text-right text-doodle-text/70">Subtotal</td><td className="py-2 px-3 font-doodle font-bold text-right text-doodle-text">${subTotal.toFixed(2)}</td></tr>
                    <tr><td colSpan={4} className="py-2 px-3 font-doodle text-right text-doodle-text/70">Tax (8.75%)</td><td className="py-2 px-3 font-doodle text-right text-doodle-text/70">${taxAmt.toFixed(2)}</td></tr>
                    <tr><td colSpan={4} className="py-2 px-3 font-doodle text-right text-doodle-text/70">Freight</td><td className="py-2 px-3 font-doodle text-right text-doodle-text/70">${freight.toFixed(2)}</td></tr>
                    <tr><td colSpan={4} className="py-2 px-3 font-doodle text-right font-bold text-doodle-text text-base">Total Due</td><td className="py-2 px-3 font-doodle font-bold text-right text-doodle-accent text-base">${totalDue.toFixed(2)}</td></tr>
                  </tfoot>
                </table>
              </div>

              <div className="flex justify-between gap-3 pt-2 border-t-2 border-doodle-text/20">
                <button onClick={() => setStep("details")} className="doodle-button px-6 py-2">← Back</button>
                <button
                  disabled={placeOrder.isPending}
                  onClick={handleSubmit}
                  className="doodle-button doodle-button-primary px-8 py-2 flex items-center gap-2 disabled:opacity-60"
                >
                  {placeOrder.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Placing Order…</> : "✅ Confirm & Place Order"}
                </button>
              </div>
            </div>
          )}

          {/* ── Done ── */}
          {step === "done" && createdOrderId !== null && (
            <div className="text-center py-8">
              <CheckCircle className="w-16 h-16 text-doodle-green mx-auto mb-4" />
              <h3 className="font-doodle text-2xl font-bold text-doodle-text mb-2">Order Placed!</h3>
              <p className="font-doodle text-doodle-text/70 mb-2">
                Order <span className="font-bold text-doodle-accent">#{createdOrderId}</span> has been created for{" "}
                <span className="font-bold">{store.storeName}</span>.
              </p>
              {purchaseOrderNumber && (
                <p className="font-doodle text-sm text-doodle-text/60 mb-2">PO Reference: <span className="font-bold">{purchaseOrderNumber}</span></p>
              )}
              <p className="font-doodle text-sm text-doodle-text/60 mb-6">
                Total: <span className="font-bold text-doodle-accent">${totalDue.toFixed(2)}</span> · Stock decremented for {lineItems.length} product{lineItems.length !== 1 ? "s" : ""}.
              </p>
              <div className="flex justify-center gap-4">
                <a href={`/orders/${createdOrderId}`} className="doodle-button doodle-button-primary flex items-center gap-2 px-6 py-2">
                  <ExternalLink className="w-4 h-4" /> View Order
                </a>
                <button onClick={onClose} className="doodle-button px-6 py-2">Close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
};

export default PlaceStoreOrderDialog;
