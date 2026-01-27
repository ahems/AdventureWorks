import React, { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, X } from "lucide-react";
import { ProductPhoto } from "@/types/product";
import { useTranslation } from "react-i18next";
import { getLargePhoto } from "@/data/apiService";

interface ProductImageGalleryProps {
  productName: string;
  color?: string | null;
  thumbnailPhoto?: string | null;
  productPhotos?: ProductPhoto[]; // Array of all photos for the product
}

// Note: Product photos have varying dimensions:
// - AI-generated: 1024x1024 PNG (stored as GIF)
// - Original: Various dimensions like 240x150 GIF

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
  thumbnailPhoto,
  productPhotos,
}) => {
  const { t } = useTranslation("common");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loadedLargePhoto, setLoadedLargePhoto] = useState<string | null>(null);
  const [isLoadingLargePhoto, setIsLoadingLargePhoto] = useState(false);

  // Use productPhotos array if available, otherwise use single photo or mock images
  const hasMultiplePhotos = productPhotos && productPhotos.length > 0;
  const mockImages = getMockImages(productName);
  const totalImages = hasMultiplePhotos
    ? productPhotos.length
    : mockImages.length;

  // Get current photo
  const currentPhoto = hasMultiplePhotos ? productPhotos[selectedIndex] : null;
  const currentPhotoId = currentPhoto?.ProductPhotoID;

  // Lazy-load large photo when fullscreen is opened
  useEffect(() => {
    if (
      isFullscreen &&
      currentPhotoId &&
      !loadedLargePhoto &&
      !isLoadingLargePhoto
    ) {
      setIsLoadingLargePhoto(true);
      getLargePhoto(currentPhotoId)
        .then((data) => {
          if (data?.LargePhoto) {
            setLoadedLargePhoto(data.LargePhoto);
          }
        })
        .catch((error) => {
          console.error("Failed to load large photo:", error);
        })
        .finally(() => {
          setIsLoadingLargePhoto(false);
        });
    }
  }, [isFullscreen, currentPhotoId, loadedLargePhoto, isLoadingLargePhoto]);

  // Clear loaded large photo when switching images or closing fullscreen
  useEffect(() => {
    setLoadedLargePhoto(null);
  }, [selectedIndex, isFullscreen]);

  const handlePrevious = () => {
    setSelectedIndex((prev) => (prev === 0 ? totalImages - 1 : prev - 1));
  };

  const handleNext = () => {
    setSelectedIndex((prev) => (prev === totalImages - 1 ? 0 : prev + 1));
  };

  const currentMockImage = !hasMultiplePhotos
    ? mockImages[selectedIndex]
    : null;

  // Main display uses ThumbNailPhoto. LargePhoto is loaded on-demand for fullscreen view.
  const displayPhoto = currentPhoto?.ThumbNailPhoto || thumbnailPhoto;

  return (
    <>
      <div className="space-y-4">
        {/* Main Image */}
        <div className="doodle-card p-4 md:p-6 relative group">
          <div
            className="aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text flex items-center justify-center cursor-pointer transition-transform hover:scale-[1.02]"
            onClick={() => setIsFullscreen(true)}
          >
            {displayPhoto ? (
              <img
                src={`data:image/gif;base64,${displayPhoto}`}
                alt={`${productName} - Image ${selectedIndex + 1}`}
                className="w-full h-full object-contain"
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
                aria-label={t("productImageGallery.previousImage")}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={handleNext}
                className="absolute right-2 top-1/2 -translate-y-1/2 doodle-button p-2 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={t("productImageGallery.nextImage")}
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          )}

          {/* Zoom Indicator */}
          <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="font-doodle text-xs text-doodle-text/50 flex items-center gap-1">
              <ZoomIn className="w-3 h-3" />
              Click to view full size
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

      {/* Fullscreen Modal */}
      {isFullscreen && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setIsFullscreen(false)}
        >
          <button
            className="absolute top-4 right-4 doodle-button p-2 bg-white"
            onClick={() => setIsFullscreen(false)}
            aria-label="Close fullscreen view"
          >
            <X className="w-6 h-6" />
          </button>

          <div className="relative max-w-full max-h-full flex items-center justify-center">
            {/* Show loading state while fetching large photo */}
            {isLoadingLargePhoto ? (
              <div className="text-white text-xl">
                Loading full resolution...
              </div>
            ) : loadedLargePhoto || displayPhoto ? (
              <>
                {/* Display large photo at native resolution (AI-generated: 1024x1024, Original: varies) */}
                <img
                  src={`data:image/gif;base64,${loadedLargePhoto || displayPhoto}`}
                  alt={`${productName} - Full size`}
                  className="max-w-full max-h-[90vh] object-contain"
                  onClick={(e) => e.stopPropagation()}
                />

                {/* Navigation arrows in fullscreen */}
                {totalImages > 1 && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePrevious();
                      }}
                      className="absolute left-4 doodle-button p-3 bg-white/90"
                      aria-label={t("productImageGallery.previousImage")}
                    >
                      <ChevronLeft className="w-6 h-6" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNext();
                      }}
                      className="absolute right-4 doodle-button p-3 bg-white/90"
                      aria-label={t("productImageGallery.nextImage")}
                    >
                      <ChevronRight className="w-6 h-6" />
                    </button>
                  </>
                )}

                {/* Image counter in fullscreen */}
                {totalImages > 1 && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
                    <span className="font-doodle text-sm bg-white px-3 py-1.5">
                      {selectedIndex + 1} / {totalImages}
                    </span>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
};

export default ProductImageGallery;
