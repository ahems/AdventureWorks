import React, { useEffect, useState } from "react";
import {
  Trash2,
  AlertTriangle,
  Loader2,
  CheckCircle,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Product, ProductModelGroup } from "@/types/product";
import {
  useDeleteProduct,
  useDeleteProductGroup,
} from "@/hooks/useAdminProducts";

interface DeleteProductDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pass for single-product deletion */
  product?: Product;
  /** Pass for group deletion (all variants + model) */
  group?: ProductModelGroup;
}

type Phase = "confirm" | "deleting" | "done" | "error";

const DeleteProductDialog: React.FC<DeleteProductDialogProps> = ({
  open,
  onClose,
  product,
  group,
}) => {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [errorMsg, setErrorMsg] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const deleteProduct = useDeleteProduct();
  const deleteGroup = useDeleteProductGroup();

  // Reset state each time dialog opens
  useEffect(() => {
    if (open) {
      setPhase("confirm");
      setErrorMsg("");
      setConfirmed(false);
    }
  }, [open]);

  const isGroup = !!group;
  const name = isGroup ? group!.modelName : (product?.Name ?? "");
  const variantCount = isGroup ? group!.variants.length : 1;

  const handleDelete = async () => {
    setPhase("deleting");
    try {
      if (isGroup && group) {
        await deleteGroup.mutateAsync({
          productModelId: group.ProductModelID,
          productIds: group.variants.map((v) => v.ProductID),
        });
      } else if (product) {
        await deleteProduct.mutateAsync(product.ProductID);
      }
      setPhase("done");
      setTimeout(() => onClose(), 1800);
    } catch (err) {
      setPhase("error");
      const raw = err instanceof Error ? err.message : String(err);
      // Try to surface the meaningful DB error text
      const match = raw.match(/"message"\s*:\s*"([^"]+)"/);
      setErrorMsg(match ? match[1] : raw.slice(0, 400));
    }
  };

  const hasFkHint =
    errorMsg.toLowerCase().includes("reference") ||
    errorMsg.toLowerCase().includes("foreign key") ||
    errorMsg.toLowerCase().includes("constraint");

  return (
    <Dialog
      open={open}
      onOpenChange={phase === "deleting" ? undefined : onClose}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-doodle text-xl flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-red-500" />
            {phase === "done"
              ? "Deleted!"
              : `Delete ${isGroup ? "Product Group" : "Product"}`}
          </DialogTitle>
        </DialogHeader>

        {/* ── Confirm phase ── */}
        {phase === "confirm" && (
          <div className="space-y-4 pt-1">
            {/* Warning banner */}
            <div className="bg-red-50 border-2 border-red-200 rounded p-3 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-doodle font-bold text-red-800 text-sm">
                  This cannot be undone
                </p>
                <p className="font-doodle text-red-700 text-sm mt-1">
                  {isGroup
                    ? `"${name}" and all ${variantCount} variants will be permanently deleted.`
                    : `"${name}" will be permanently deleted.`}
                </p>
              </div>
            </div>

            {/* What will be deleted */}
            <div>
              <p className="font-doodle text-sm font-bold text-doodle-text mb-2">
                The following will be removed:
              </p>
              <ul className="space-y-1 pl-1">
                {isGroup && (
                  <li className="font-doodle text-sm text-doodle-text/70">
                    • {variantCount} product variant
                    {variantCount !== 1 ? "s" : ""}
                  </li>
                )}
                <li className="font-doodle text-sm text-doodle-text/70">
                  • All product images
                </li>
                <li className="font-doodle text-sm text-doodle-text/70">
                  • All customer reviews &amp; replies
                </li>
                <li className="font-doodle text-sm text-doodle-text/70">
                  • Inventory records
                </li>
                <li className="font-doodle text-sm text-doodle-text/70">
                  • Price &amp; cost history
                </li>
                <li className="font-doodle text-sm text-doodle-text/70">
                  • Special offer links
                </li>
                {isGroup && (
                  <li className="font-doodle text-sm text-doodle-text/70">
                    • Product model &amp; translations
                  </li>
                )}
              </ul>
            </div>

            {/* Variant list (for groups ≤ 12 variants) */}
            {isGroup && group && group.variants.length <= 12 && (
              <div className="border-2 border-dashed border-doodle-text/20 rounded p-2 max-h-28 overflow-y-auto">
                {group.variants.map((v) => {
                  const detail = [v.Color, v.Size].filter(Boolean).join(" / ");
                  return (
                    <p
                      key={v.ProductID}
                      className="font-doodle text-xs text-doodle-text/60"
                    >
                      #{v.ProductID} — {v.Name}
                      {detail ? ` (${detail})` : ""}
                    </p>
                  );
                })}
              </div>
            )}

            {/* Confirm checkbox */}
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 accent-red-500"
              />
              <span className="font-doodle text-sm text-doodle-text">
                I understand this is permanent and cannot be reversed
              </span>
            </label>

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="flex-1 doodle-button">
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={!confirmed}
                className="flex-1 doodle-button flex items-center justify-center gap-2 bg-red-500 border-red-700 text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            </div>
          </div>
        )}

        {/* ── Deleting phase ── */}
        {phase === "deleting" && (
          <div className="py-10 flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 animate-spin text-red-500" />
            <p className="font-doodle text-doodle-text">
              Deleting
              {isGroup ? ` ${variantCount} products` : ""}…
            </p>
          </div>
        )}

        {/* ── Done phase ── */}
        {phase === "done" && (
          <div className="py-10 flex flex-col items-center gap-3">
            <CheckCircle className="w-10 h-10 text-doodle-green" />
            <p className="font-doodle text-doodle-text font-bold text-lg">
              Deleted successfully
            </p>
          </div>
        )}

        {/* ── Error phase ── */}
        {phase === "error" && (
          <div className="space-y-4 pt-1">
            <div className="flex flex-col items-center gap-2 py-3">
              <XCircle className="w-10 h-10 text-red-500" />
              <p className="font-doodle text-doodle-text font-bold text-center">
                Deletion failed
              </p>
            </div>
            <div className="bg-red-50 border-2 border-red-200 rounded p-3 space-y-2">
              <p className="font-doodle text-xs text-red-700 break-words">
                {errorMsg}
              </p>
              {hasFkHint && (
                <p className="font-doodle text-xs text-red-800 font-bold">
                  This product has existing sales or order history referencing
                  it and cannot be fully removed. Consider marking it as
                  discontinued (set a Sell End Date) instead.
                </p>
              )}
            </div>
            <button onClick={onClose} className="w-full doodle-button">
              Close
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DeleteProductDialog;
