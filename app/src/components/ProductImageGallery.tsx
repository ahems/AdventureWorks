import React, { useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn } from "lucide-react";
import { ProductPhoto } from "@/types/product";

interface ProductImageGalleryProps {
  productName: string;
  color?: string | null;
  largePhoto?: string | null;
  thumbnailPhoto?: string | null;
  productPhotos?: ProductPhoto[]; // Array of all photos for the product
}

// Fallback mock images when no photos are available
const getMockImages = (productName: string) => {
  return [
    { id: 1, label: "Main View", emoji: "🚴" },
    { id: 2, label: "Side View", emoji: "🚲" },
    { id: 3, label: "Detail View", emoji: "⚙️" },
    { id: 4, label: "In Action", emoji: "🏔️" },
  ];
};

const ProductImageGallery: React.FC<ProductImageGalleryProps> = ({
  productName,
  color,
  largePhoto,
  thumbnailPhoto,
  productPhotos,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);

  // Use productPhotos array if available, otherwise use single photo or mock images
  const hasMultiplePhotos = productPhotos && productPhotos.length > 0;
  const mockImages = getMockImages(productName);
  const totalImages = hasMultiplePhotos
    ? productPhotos.length
    : mockImages.length;

  const handlePrevious = () => {
    setSelectedIndex((prev) => (prev === 0 ? totalImages - 1 : prev - 1));
  };

  const handleNext = () => {
    setSelectedIndex((prev) => (prev === totalImages - 1 ? 0 : prev + 1));
  };

  // Get current photo
  const currentPhoto = hasMultiplePhotos ? productPhotos[selectedIndex] : null;
  const currentMockImage = !hasMultiplePhotos
    ? mockImages[selectedIndex]
    : null;
  const displayPhoto =
    currentPhoto?.LargePhoto ||
    currentPhoto?.ThumbNailPhoto ||
    largePhoto ||
    thumbnailPhoto;

  return (
    <div className="space-y-4">
      {/* Main Image */}
      <div className="doodle-card p-4 md:p-6 relative group">
        <div
          className={`aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text flex items-center justify-center cursor-pointer transition-transform ${
            isZoomed ? "scale-105" : ""
          }`}
          onClick={() => setIsZoomed(!isZoomed)}
        >
          {displayPhoto ? (
            <img
              src={`data:image/gif;base64,${displayPhoto}`}
              alt={`${productName} - Image ${selectedIndex + 1}`}
              className={`w-full h-full object-contain transition-transform ${
                isZoomed ? "scale-110" : ""
              }`}
            />
          ) : (
            <div className="text-center p-8">
              <span className="text-8xl block mb-4">
                {currentMockImage?.emoji}
              </span>
              <p className="font-doodle text-lg text-doodle-text/60">
                {productName}
              </p>
              <p className="font-doodle text-sm text-doodle-text/40 mt-1">
                {currentMockImage?.label}
              </p>
              {color && (
                <p className="font-doodle text-sm text-doodle-accent mt-2">
                  Color: {color}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Navigation Arrows - only show if multiple images */}
        {totalImages > 1 && (
          <>
            <button
              onClick={handlePrevious}
              className="absolute left-2 top-1/2 -translate-y-1/2 doodle-button p-2 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Previous image"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={handleNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 doodle-button p-2 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Next image"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}

        {/* Zoom Indicator */}
        <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="font-doodle text-xs text-doodle-text/50 flex items-center gap-1">
            <ZoomIn className="w-3 h-3" />
            Click to {isZoomed ? "zoom out" : "zoom in"}
          </span>
        </div>

        {/* Image Counter - only show if multiple images */}
        {totalImages > 1 && (
          <div className="absolute bottom-4 left-4">
            <span className="font-doodle text-xs bg-doodle-text/80 text-white px-2 py-1">
              {selectedIndex + 1} / {totalImages}
            </span>
          </div>
        )}
      </div>

      {/* Thumbnails - only show if multiple images */}
      {totalImages > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {hasMultiplePhotos
            ? // Real photos from API
              productPhotos.map((photo, index) => (
                <button
                  key={photo.ProductPhotoID}
                  onClick={() => setSelectedIndex(index)}
                  className={`flex-shrink-0 w-16 h-16 md:w-20 md:h-20 border-2 flex items-center justify-center transition-all overflow-hidden ${
                    index === selectedIndex
                      ? "border-doodle-accent bg-doodle-accent/10"
                      : "border-doodle-text/30 hover:border-doodle-accent/50 bg-doodle-bg"
                  }`}
                  aria-label={`View image ${index + 1}`}
                >
                  {photo.ThumbNailPhoto || photo.LargePhoto ? (
                    <img
                      src={`data:image/gif;base64,${
                        photo.ThumbNailPhoto || photo.LargePhoto
                      }`}
                      alt={`Thumbnail ${index + 1}`}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <span className="text-2xl">📷</span>
                  )}
                </button>
              ))
            : // Mock emoji thumbnails
              mockImages.map((image, index) => (
                <button
                  key={image.id}
                  onClick={() => setSelectedIndex(index)}
                  className={`flex-shrink-0 w-16 h-16 md:w-20 md:h-20 border-2 flex items-center justify-center transition-all ${
                    index === selectedIndex
                      ? "border-doodle-accent bg-doodle-accent/10"
                      : "border-doodle-text/30 hover:border-doodle-accent/50 bg-doodle-bg"
                  }`}
                  aria-label={`View ${image.label}`}
                >
                  <span className="text-2xl">{image.emoji}</span>
                </button>
              ))}
        </div>
      )}
    </div>
  );
};

export default ProductImageGallery;
