import React, { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  Trash2,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import {
  useProductPhotos,
  useProductLargePhoto,
  useDeleteProductPhoto,
} from "@/hooks/useAdminProducts";

interface ProductImageGalleryProps {
  productId: number;
  productName: string;
  color?: string | null;
}

/** Detect image type from base64 content and return a valid data URL */
const toImgSrc = (value: string | null | undefined): string => {
  if (!value) return "";
  if (value.startsWith("data:")) return value;
  // Detect format from base64 prefix
  if (value.startsWith("iVBOR")) return `data:image/png;base64,${value}`;
  if (value.startsWith("R0lG")) return `data:image/gif;base64,${value}`;
  if (value.startsWith("UklG")) return `data:image/webp;base64,${value}`;
  return `data:image/jpeg;base64,${value}`;
};

const ProductImageGallery: React.FC<ProductImageGalleryProps> = ({
  productId,
  productName,
  color,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);

  const { data: photoRecords = [], isLoading } = useProductPhotos(productId);
  const deletePhoto = useDeleteProductPhoto();

  const selectedRecord = photoRecords[selectedIndex];
  const selectedPhotoId = selectedRecord?.productPhoto?.ProductPhotoID ?? null;

  // Lazy-load the large photo only for the currently selected image
  const { data: largePhotoData, isLoading: largeLoading } =
    useProductLargePhoto(selectedPhotoId);

  const handlePrevious = () => {
    setSelectedIndex((prev) =>
      prev === 0 ? photoRecords.length - 1 : prev - 1,
    );
  };

  const handleNext = () => {
    setSelectedIndex((prev) =>
      prev === photoRecords.length - 1 ? 0 : prev + 1,
    );
  };

  const handleDeleteImage = (index: number) => {
    const record = photoRecords[index];
    if (!record) return;

    deletePhoto.mutate(
      { productId, productPhotoId: record.ProductPhotoID },
      {
        onSuccess: () => {
          if (selectedIndex >= photoRecords.length - 1) {
            setSelectedIndex(Math.max(0, photoRecords.length - 2));
          }
          toast({
            title: "Image deleted",
            description: "Product photo has been removed.",
          });
        },
        onError: (err) => {
          toast({
            title: "Delete failed",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          });
        },
      },
    );
  };

  // Show large photo when loaded, fall back to thumbnail while loading
  const mainSrc =
    toImgSrc(largePhotoData) ||
    toImgSrc(selectedRecord?.productPhoto?.ThumbNailPhoto);
  const isDeleting = deletePhoto.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-doodle-text/50">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        <span className="font-doodle">Loading photos…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Main Image */}
      <div className="doodle-card p-4 md:p-6 relative group">
        <div
          className={`aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text flex items-center justify-center cursor-pointer transition-transform overflow-hidden ${
            isZoomed ? "scale-105" : ""
          }`}
          onClick={() => setIsZoomed(!isZoomed)}
        >
          {mainSrc ? (
            <div className="relative w-full h-full">
              <img
                src={mainSrc}
                alt={
                  selectedRecord?.productPhoto?.LargePhotoFileName ||
                  productName
                }
                className="w-full h-full object-contain"
              />
              {largeLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-doodle-bg/40">
                  <Loader2 className="w-8 h-8 animate-spin text-doodle-text/40" />
                </div>
              )}
            </div>
          ) : largeLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-12 h-12 animate-spin text-doodle-text/30" />
            </div>
          ) : (
            <div className="text-center p-8">
              <ImageIcon className="w-24 h-24 mx-auto mb-4 text-doodle-text/30" />
              <p className="font-doodle text-lg text-doodle-text/60">
                {productName}
              </p>
              {color && (
                <p className="font-doodle text-sm text-doodle-accent mt-2">
                  Color: {color}
                </p>
              )}
              <p className="font-doodle text-sm text-doodle-text/40 mt-2">
                No images yet
              </p>
            </div>
          )}
        </div>

        {/* Navigation Arrows */}
        {photoRecords.length > 1 && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handlePrevious();
              }}
              className="absolute left-2 top-1/2 -translate-y-1/2 doodle-button p-2 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Previous image"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleNext();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 doodle-button p-2 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Next image"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}

        {/* Zoom Indicator */}
        {mainSrc && (
          <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="font-doodle text-xs text-doodle-text/50 flex items-center gap-1">
              <ZoomIn className="w-3 h-3" />
              Click to {isZoomed ? "zoom out" : "zoom in"}
            </span>
          </div>
        )}

        {/* Image Counter */}
        {photoRecords.length > 0 && (
          <div className="absolute bottom-4 left-4">
            <span className="font-doodle text-xs bg-doodle-text/80 text-white px-2 py-1">
              {selectedIndex + 1} / {photoRecords.length}
            </span>
          </div>
        )}

        {/* Delete overlay — shown on hover when a photo is selected */}
        {selectedRecord && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteImage(selectedIndex);
            }}
            disabled={isDeleting}
            className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity doodle-button p-2 text-doodle-accent hover:bg-doodle-accent hover:text-white disabled:opacity-50"
            title="Delete this image"
            aria-label="Delete image"
          >
            {isDeleting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
          </button>
        )}
      </div>

      {/* Thumbnails */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {photoRecords.map((record, index) => {
          const thumbSrc = toImgSrc(record.productPhoto?.ThumbNailPhoto);
          return (
            <button
              key={record.ProductPhotoID}
              onClick={() => setSelectedIndex(index)}
              className={`flex-shrink-0 w-16 h-16 md:w-20 md:h-20 border-2 flex items-center justify-center transition-all overflow-hidden ${
                index === selectedIndex
                  ? "border-doodle-accent bg-doodle-accent/10"
                  : "border-doodle-text/30 hover:border-doodle-accent/50 bg-doodle-bg"
              }`}
              aria-label={`View photo ${index + 1}`}
            >
              {thumbSrc ? (
                <img
                  src={thumbSrc}
                  alt={`Photo ${index + 1}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImageIcon className="w-6 h-6 text-doodle-text/30" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ProductImageGallery;
