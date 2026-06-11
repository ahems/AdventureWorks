import React, { useState } from "react";
import { Tag, Loader2, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useAdminSpecialOffers,
  useCreateSpecialOffer,
  useAssignSpecialOfferProducts,
} from "@/hooks/useAdminPromotions";

// ─── Helper ───────────────────────────────────────────────────────────────────

function toDateInputValue(d: Date) {
  return d.toISOString().slice(0, 10);
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ClearanceProduct {
  productID: number;
  productName: string;
}

interface Props {
  product: ClearanceProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

const ClearancePromotionDialog: React.FC<Props> = ({
  product,
  open,
  onOpenChange,
}) => {
  const today = new Date();
  const threeMonths = new Date(today);
  threeMonths.setMonth(threeMonths.getMonth() + 3);

  const [discountPct, setDiscountPct] = useState("20");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(toDateInputValue(today));
  const [endDate, setEndDate] = useState(toDateInputValue(threeMonths));
  const [minQty, setMinQty] = useState("1");
  const [saved, setSaved] = useState(false);

  const { data: existingOffers } = useAdminSpecialOffers();
  const { mutateAsync: createOffer, isPending: isCreating } =
    useCreateSpecialOffer();
  const { mutateAsync: assignProducts, isPending: isAssigning } =
    useAssignSpecialOfferProducts();

  const isPending = isCreating || isAssigning;

  // Reset form when product changes
  React.useEffect(() => {
    if (product) {
      setDescription(`Clearance: ${product.productName}`);
      setDiscountPct("20");
      setStartDate(toDateInputValue(new Date()));
      const end = new Date();
      end.setMonth(end.getMonth() + 3);
      setEndDate(toDateInputValue(end));
      setMinQty("1");
      setSaved(false);
    }
  }, [product]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product || !existingOffers) return;

    // Compute next SpecialOfferID
    const maxId =
      existingOffers.length > 0
        ? Math.max(...existingOffers.map((o) => o.SpecialOfferID))
        : 0;
    const newId = maxId + 1;

    const discount = parseFloat(discountPct) / 100;

    await createOffer({
      SpecialOfferID: newId,
      CultureID: "en",
      Description: description,
      DiscountPct: discount,
      Type: "Clearance Sale",
      Category: "Reseller",
      StartDate: new Date(startDate).toISOString(),
      EndDate: new Date(endDate).toISOString(),
      MinQty: parseInt(minQty, 10) || 1,
      MaxQty: null,
    });

    await assignProducts({
      offerId: newId,
      newProductIds: [product.productID],
      currentProductIds: [],
    });

    setSaved(true);
    setTimeout(() => {
      onOpenChange(false);
      setSaved(false);
    }, 1200);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-doodle">
            <Tag className="w-5 h-5 text-doodle-accent" />
            Add Clearance Promotion
          </DialogTitle>
          <DialogDescription className="font-doodle">
            {product ? (
              <>
                Create a clearance offer for{" "}
                <strong>{product.productName}</strong> to stimulate sales.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div>
            <label className="font-doodle text-xs text-doodle-text/70 uppercase tracking-wide block mb-1">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              className="w-full border-2 border-doodle-text/30 px-3 py-1.5 font-doodle text-sm focus:border-doodle-accent focus:outline-none bg-white"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-doodle text-xs text-doodle-text/70 uppercase tracking-wide block mb-1">
                Discount %
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  value={discountPct}
                  onChange={(e) => setDiscountPct(e.target.value)}
                  required
                  className="w-full border-2 border-doodle-text/30 px-3 py-1.5 font-doodle text-sm focus:border-doodle-accent focus:outline-none bg-white"
                />
                <span className="font-doodle text-sm text-doodle-text/60">
                  %
                </span>
              </div>
            </div>
            <div>
              <label className="font-doodle text-xs text-doodle-text/70 uppercase tracking-wide block mb-1">
                Min Qty
              </label>
              <input
                type="number"
                min="1"
                value={minQty}
                onChange={(e) => setMinQty(e.target.value)}
                required
                className="w-full border-2 border-doodle-text/30 px-3 py-1.5 font-doodle text-sm focus:border-doodle-accent focus:outline-none bg-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-doodle text-xs text-doodle-text/70 uppercase tracking-wide block mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className="w-full border-2 border-doodle-text/30 px-3 py-1.5 font-doodle text-sm focus:border-doodle-accent focus:outline-none bg-white"
              />
            </div>
            <div>
              <label className="font-doodle text-xs text-doodle-text/70 uppercase tracking-wide block mb-1">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="w-full border-2 border-doodle-text/30 px-3 py-1.5 font-doodle text-sm focus:border-doodle-accent focus:outline-none bg-white"
              />
            </div>
          </div>

          <div className="doodle-card p-3 flex items-center gap-2 bg-doodle-accent/5">
            <Tag className="w-4 h-4 text-doodle-accent shrink-0" />
            <p className="font-doodle text-xs text-doodle-text/70">
              Type: <strong>Clearance Sale</strong> · Category:{" "}
              <strong>Reseller</strong> · Product will be linked automatically.
            </p>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
              className="doodle-button font-doodle text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || saved}
              className="doodle-button doodle-button-primary font-doodle text-sm flex items-center gap-2"
            >
              {saved ? (
                <>
                  <Check className="w-4 h-4 text-green-500" />
                  Created!
                </>
              ) : isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <Tag className="w-4 h-4" />
                  Create Promotion
                </>
              )}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default ClearancePromotionDialog;
