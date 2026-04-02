import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Star, Edit, ExternalLink, Trash2 } from "lucide-react";
import { Product, getSalePrice } from "@/types/product";
import { useReviews } from "@/hooks/useReviews";
import { getAppUrl } from "@/lib/utils";
import DeleteProductDialog from "@/components/DeleteProductDialog";

interface AdminProductCardProps {
  product: Product;
}

const AdminProductCard: React.FC<AdminProductCardProps> = ({ product }) => {
  const { averageRating, reviewCount } = useReviews(product.ProductID);
  const salePrice = getSalePrice(product);
  const appUrl = getAppUrl();
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <Link
        to={`/product/${product.ProductID}`}
        className="doodle-card group relative overflow-hidden hover:border-doodle-accent transition-all duration-200"
      >
        {/* Admin badges: Edit / Delete / External link */}
        <div className="absolute top-2 right-2 z-10 flex gap-1">
          <span className="bg-doodle-green text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text flex items-center gap-1">
            <Edit className="w-3 h-3" />
            Edit
          </span>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDeleteOpen(true);
            }}
            title="Delete product"
            className="bg-red-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-red-700 flex items-center hover:bg-red-600 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
          </button>
          {appUrl && (
            <a
              href={`${appUrl}/product/${product.ProductID}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="View in customer app"
              className="bg-doodle-blue text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text flex items-center"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        {/* Sale Badge */}
        {product.salePercent && (
          <div className="absolute top-2 left-2 z-10">
            <span className="bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-2deg] inline-block">
              {product.salePercent}% OFF
            </span>
          </div>
        )}

        {/* Product Image */}
        <div className="aspect-square bg-doodle-text/5 flex items-center justify-center overflow-hidden">
          <img
            src={product.ImageUrl || "/placeholder.svg"}
            alt={product.Name}
            className="w-full h-full object-contain p-4 group-hover:scale-105 transition-transform duration-300"
          />
        </div>

        {/* Product Info */}
        <div className="p-4">
          {/* SKU */}
          <p className="font-doodle text-xs text-doodle-text/50 mb-1">
            SKU: {product.ProductNumber}
          </p>

          {/* Name */}
          <h3 className="font-doodle text-lg font-bold text-doodle-text group-hover:text-doodle-accent transition-colors line-clamp-2">
            {product.Name}
          </h3>

          {/* Rating */}
          <div className="flex items-center gap-1 mt-2">
            <div className="flex items-center">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-3 h-3 ${
                    i < Math.round(averageRating)
                      ? "fill-doodle-accent text-doodle-accent"
                      : "text-doodle-text/20"
                  }`}
                />
              ))}
            </div>
            <span className="font-doodle text-xs text-doodle-text/60">
              ({reviewCount})
            </span>
          </div>

          {/* Price */}
          <div className="mt-3 flex items-center gap-2">
            {salePrice ? (
              <>
                <span className="font-doodle text-sm text-doodle-text/50 line-through">
                  ${product.ListPrice.toFixed(2)}
                </span>
                <span className="font-doodle text-xl font-bold text-doodle-accent">
                  ${salePrice.toFixed(2)}
                </span>
              </>
            ) : (
              <span className="font-doodle text-xl font-bold text-doodle-green">
                ${product.ListPrice.toFixed(2)}
              </span>
            )}
          </div>

          {/* Quick Info */}
          <div className="mt-3 pt-3 border-t-2 border-dashed border-doodle-text/20 space-y-1">
            {product.availableSizes && (
              <p className="font-doodle text-xs text-doodle-text/60">
                Sizes: {product.availableSizes.join(", ")}
              </p>
            )}
            {product.availableColors && (
              <p className="font-doodle text-xs text-doodle-text/60">
                Colors: {product.availableColors.join(", ")}
              </p>
            )}
            {product.Weight && (
              <p className="font-doodle text-xs text-doodle-text/60">
                Weight: {product.Weight} lbs
              </p>
            )}
          </div>
        </div>
      </Link>
      <DeleteProductDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        product={product}
      />
    </>
  );
};

export default AdminProductCard;
