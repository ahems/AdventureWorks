import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, X } from "lucide-react";
import { useRecentlyViewed } from "@/context/RecentlyViewedContext";
import { getSalePrice } from "@/types/product";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "react-i18next";
import { useCurrency } from "@/context/CurrencyContext";
import { trackError } from "@/lib/appInsights";

// Query to fetch thumbnail photos for recently viewed products
const GET_PRODUCT_THUMBNAILS = gql`
  query GetProductThumbnails($productIds: [Int!]!) {
    productProductPhotos(
      filter: { ProductID: { in: $productIds }, Primary: { eq: true } }
    ) {
      items {
        ProductID
        ProductPhotoID
        Primary
        productPhoto {
          ProductPhotoID
          ThumbNailPhoto
          ThumbnailPhotoFileName
        }
      }
    }
  }
`;

interface ProductThumbnail {
  ProductID: number;
  ThumbNailPhoto: string | null;
}

interface RecentlyViewedProps {
  currentProductId?: number;
}

const RecentlyViewed: React.FC<RecentlyViewedProps> = ({
  currentProductId,
}) => {
  const { recentlyViewed, clearRecentlyViewed } = useRecentlyViewed();
  const { t } = useTranslation("common");
  const { formatPrice } = useCurrency();
  const [thumbnails, setThumbnails] = useState<Map<number, string | null>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);

  // Filter out current product if viewing a product page and limit to 4 products
  const productsToShow = currentProductId
    ? recentlyViewed.filter((p) => p.ProductID !== currentProductId).slice(0, 4)
    : recentlyViewed.slice(0, 4);

  // Fetch thumbnails for recently viewed products
  const productIdsForDep = productsToShow.map((p) => p.ProductID).join(",");
  useEffect(() => {
    const fetchThumbnails = async () => {
      if (productsToShow.length === 0) return;

      const productIds = productsToShow.map((p) => p.ProductID);
      setLoading(true);
      try {
        const response = await graphqlClient.request<{
          productProductPhotos: {
            items: Array<{
              ProductID: number;
              productPhoto: {
                ThumbNailPhoto: string | null;
              };
            }>;
          };
        }>(GET_PRODUCT_THUMBNAILS, { productIds });

        const thumbnailMap = new Map<number, string | null>();
        response.productProductPhotos.items.forEach((item) => {
          thumbnailMap.set(item.ProductID, item.productPhoto.ThumbNailPhoto);
        });

        setThumbnails(thumbnailMap);
      } catch (error) {
        trackError(
          "Failed to fetch thumbnails for recently viewed products",
          error as Error,
          {
            component: "RecentlyViewed",
            productCount: productsToShow.length,
            productIds: productIds.join(","),
          },
        );
      } finally {
        setLoading(false);
      }
    };

    fetchThumbnails();
  }, [productIdsForDep]);

  if (productsToShow.length === 0) {
    return null;
  }

  return (
    <section className="container mx-auto px-4 py-8 md:py-12">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-doodle-accent" />
          <h2 className="font-doodle text-xl md:text-2xl font-bold text-doodle-text">
            {t("recentlyViewed.recentlyViewed")}
          </h2>
        </div>
        <button
          onClick={clearRecentlyViewed}
          className="font-doodle text-xs text-doodle-text/50 hover:text-doodle-accent transition-colors flex items-center gap-1"
        >
          <X className="w-3 h-3" />
          {t("recentlyViewed.clear")}
        </button>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin">
        {productsToShow.map((product) => {
          const salePrice = getSalePrice(product);
          const thumbnail = thumbnails.get(product.ProductID);

          return (
            <Link
              key={product.ProductID}
              to={`/product/${product.ProductID}`}
              className="flex-shrink-0 w-40 md:w-48 group"
            >
              <div className="doodle-card p-3 h-full hover:border-doodle-accent transition-colors">
                {/* Image */}
                <div className="aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text/30 flex items-center justify-center mb-2 group-hover:border-doodle-accent transition-colors overflow-hidden">
                  {loading ? (
                    <Skeleton className="w-full h-full rounded-none" />
                  ) : thumbnail ? (
                    <img
                      src={`data:image/gif;base64,${thumbnail}`}
                      alt={product.Name}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="text-center">
                      <span className="text-3xl">🚴</span>
                      {product.Color && (
                        <p className="text-xs text-doodle-text/60 mt-1">
                          {product.Color}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Info */}
                <h3 className="font-doodle text-sm font-bold text-doodle-text line-clamp-2 mb-1 group-hover:text-doodle-accent transition-colors">
                  {product.Name}
                </h3>

                {/* Price */}
                <div className="flex items-center gap-2">
                  {salePrice ? (
                    <>
                      <span className="font-doodle text-xs text-doodle-text/50 line-through">
                        {formatPrice(product.ListPrice)}
                      </span>
                      <span className="font-doodle text-sm font-bold text-doodle-accent">
                        {formatPrice(salePrice)}
                      </span>
                    </>
                  ) : (
                    <span className="font-doodle text-sm font-bold text-doodle-green">
                      {formatPrice(product.ListPrice)}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
};

export default RecentlyViewed;
