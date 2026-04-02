import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Edit, ExternalLink, Layers, Trash2 } from "lucide-react";
import { ProductModelGroup } from "@/types/product";
import { useAdminProductPhotoBatch } from "@/hooks/useAdminProducts";
import { getAppUrl } from "@/lib/utils";
import DeleteProductDialog from "@/components/DeleteProductDialog";

interface AdminProductModelGroupCardProps {
  group: ProductModelGroup;
}

/** Base64 prefix → mime type detection */
const toImgSrc = (value: string | null | undefined): string => {
  if (!value) return "";
  if (value.startsWith("data:")) return value;
  if (value.startsWith("iVBOR")) return `data:image/png;base64,${value}`;
  if (value.startsWith("R0lG")) return `data:image/gif;base64,${value}`;
  if (value.startsWith("UklG")) return `data:image/webp;base64,${value}`;
  return `data:image/jpeg;base64,${value}`;
};

const AdminProductModelGroupCard: React.FC<AdminProductModelGroupCardProps> = ({
  group,
}) => {
  const appUrl = getAppUrl();
  const variantCount = group.variants.length;
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Fetch thumbnails for all variants
  const variantIds = group.variants.map((v) => v.ProductID);
  const { data: photoMap = new Map<number, string>() } =
    useAdminProductPhotoBatch(variantIds);

  // Use the primary image from the first variant that has one
  const primaryImage =
    photoMap.get(group.baseProduct.ProductID) ||
    [...photoMap.values()][0] ||
    null;

  const priceLabel =
    group.priceRange.min === group.priceRange.max
      ? `$${group.priceRange.min.toFixed(2)}`
      : `$${group.priceRange.min.toFixed(2)} – $${group.priceRange.max.toFixed(2)}`;

  return (
    <>
      <div className="doodle-card relative overflow-hidden">
        {/* Variants badge (top-left) */}
        <div className="absolute top-2 left-2 z-10">
          <span className="bg-doodle-blue text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text flex items-center gap-1">
            <Layers className="w-3 h-3" />
            {variantCount} variant{variantCount !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Delete button (top-right) */}
        <div className="absolute top-2 right-2 z-10">
          <button
            onClick={() => setDeleteOpen(true)}
            title="Delete product group"
            className="bg-red-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-red-700 flex items-center gap-1 hover:bg-red-600 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>

        {/* Product image */}
        <div className="aspect-square bg-doodle-text/5 flex items-center justify-center overflow-hidden">
          <img
            src={toImgSrc(primaryImage) || "/placeholder.svg"}
            alt={group.modelName}
            className="w-full h-full object-contain p-4"
          />
        </div>

        {/* Info */}
        <div className="p-4">
          <h3 className="font-doodle text-lg font-bold text-doodle-text line-clamp-2 mb-1">
            {group.modelName}
          </h3>

          {/* Colors */}
          {group.colors.length > 0 && (
            <p className="font-doodle text-xs text-doodle-text/60 mb-1">
              Colors: {group.colors.join(", ")}
            </p>
          )}

          {/* Sizes */}
          {group.sizes.length > 0 && (
            <p className="font-doodle text-xs text-doodle-text/60 mb-2">
              Sizes: {group.sizes.join(", ")}
            </p>
          )}

          {/* Price range */}
          <p className="font-doodle text-xl font-bold text-doodle-green mb-3">
            {priceLabel}
          </p>

          {/* Variant links */}
          <div className="border-t-2 border-dashed border-doodle-text/20 pt-3 space-y-1">
            {group.variants.map((v) => (
              <div
                key={v.ProductID}
                className="flex items-center justify-between gap-2"
              >
                <Link
                  to={`/product/${v.ProductID}`}
                  className="flex items-center gap-1 font-doodle text-xs text-doodle-blue hover:underline flex-1 min-w-0"
                >
                  <Edit className="w-3 h-3 shrink-0" />
                  <span className="truncate">
                    {[v.Color, v.Size].filter(Boolean).join(" / ") ||
                      `#${v.ProductID}`}
                  </span>
                </Link>
                {appUrl && (
                  <a
                    href={`${appUrl}/product/${v.ProductID}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View in customer app"
                    className="text-doodle-text/40 hover:text-doodle-blue shrink-0"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <DeleteProductDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        group={group}
      />
    </>
  );
};

export default AdminProductModelGroupCard;
