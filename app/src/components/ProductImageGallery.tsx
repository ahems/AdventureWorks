import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';

interface ProductImageGalleryProps {
  productName: string;
  color?: string | null;
}

// Mock image data - in a real app these would come from the product
const getProductImages = (productName: string) => {
  return [
    { id: 1, label: 'Main View', emoji: '🚴' },
    { id: 2, label: 'Side View', emoji: '🚲' },
    { id: 3, label: 'Detail View', emoji: '⚙️' },
    { id: 4, label: 'In Action', emoji: '🏔️' },
  ];
};

const ProductImageGallery: React.FC<ProductImageGalleryProps> = ({ productName, color }) => {
  const images = getProductImages(productName);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);

  const handlePrevious = () => {
    setSelectedIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  };

  const handleNext = () => {
    setSelectedIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  };

  const selectedImage = images[selectedIndex];

  return (
    <div className="space-y-4">
      {/* Main Image */}
      <div className="doodle-card p-4 md:p-6 relative group">
        <div 
          className={`aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text flex items-center justify-center cursor-pointer transition-transform ${
            isZoomed ? 'scale-105' : ''
          }`}
          onClick={() => setIsZoomed(!isZoomed)}
        >
          <div className="text-center p-8">
            <span className="text-8xl block mb-4">{selectedImage.emoji}</span>
            <p className="font-doodle text-lg text-doodle-text/60">
              {productName}
            </p>
            <p className="font-doodle text-sm text-doodle-text/40 mt-1">
              {selectedImage.label}
            </p>
            {color && (
              <p className="font-doodle text-sm text-doodle-accent mt-2">
                Color: {color}
              </p>
            )}
          </div>
        </div>

        {/* Navigation Arrows */}
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

        {/* Zoom Indicator */}
        <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="font-doodle text-xs text-doodle-text/50 flex items-center gap-1">
            <ZoomIn className="w-3 h-3" />
            Click to {isZoomed ? 'zoom out' : 'zoom in'}
          </span>
        </div>

        {/* Image Counter */}
        <div className="absolute bottom-4 left-4">
          <span className="font-doodle text-xs bg-doodle-text/80 text-white px-2 py-1">
            {selectedIndex + 1} / {images.length}
          </span>
        </div>
      </div>

      {/* Thumbnails */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {images.map((image, index) => (
          <button
            key={image.id}
            onClick={() => setSelectedIndex(index)}
            className={`flex-shrink-0 w-16 h-16 md:w-20 md:h-20 border-2 flex items-center justify-center transition-all ${
              index === selectedIndex
                ? 'border-doodle-accent bg-doodle-accent/10'
                : 'border-doodle-text/30 hover:border-doodle-accent/50 bg-doodle-bg'
            }`}
            aria-label={`View ${image.label}`}
          >
            <span className="text-2xl">{image.emoji}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ProductImageGallery;
