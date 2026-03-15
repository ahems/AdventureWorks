import React, { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, Upload, Trash2, Plus, Image as ImageIcon } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface ProductImage {
  id: string;
  url: string;
  label: string;
}

interface ProductImageGalleryProps {
  productId: number;
  productName: string;
  color?: string | null;
}

const STORAGE_KEY_PREFIX = 'aw_product_images_';

const getDefaultImages = (productName: string): ProductImage[] => [
  { id: 'default-1', url: '', label: 'Main View' },
  { id: 'default-2', url: '', label: 'Side View' },
  { id: 'default-3', url: '', label: 'Detail View' },
];

const ProductImageGallery: React.FC<ProductImageGalleryProps> = ({ productId, productName, color }) => {
  const [images, setImages] = useState<ProductImage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Load images from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${productId}`);
    if (stored) {
      setImages(JSON.parse(stored));
    } else {
      setImages(getDefaultImages(productName));
    }
  }, [productId, productName]);

  // Save images to localStorage
  const saveImages = (newImages: ProductImage[]) => {
    setImages(newImages);
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${productId}`, JSON.stringify(newImages));
  };

  const handlePrevious = () => {
    setSelectedIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  };

  const handleNext = () => {
    setSelectedIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, replaceIndex?: number) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid file', description: 'Please select an image file.', variant: 'destructive' });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'File too large', description: 'Please select an image under 5MB.', variant: 'destructive' });
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      
      if (replaceIndex !== undefined) {
        // Replace existing image
        const newImages = [...images];
        newImages[replaceIndex] = {
          ...newImages[replaceIndex],
          url: base64,
        };
        saveImages(newImages);
        toast({ title: 'Image updated', description: `${newImages[replaceIndex].label} has been replaced.` });
      } else {
        // Add new image
        const newImage: ProductImage = {
          id: `custom-${Date.now()}`,
          url: base64,
          label: `Image ${images.length + 1}`,
        };
        saveImages([...images, newImage]);
        setSelectedIndex(images.length);
        toast({ title: 'Image added', description: 'New product image has been added.' });
      }
    };
    reader.readAsDataURL(file);
    
    // Reset file input
    e.target.value = '';
  };

  const handleDeleteImage = (index: number) => {
    if (images.length <= 1) {
      toast({ title: 'Cannot delete', description: 'Product must have at least one image.', variant: 'destructive' });
      return;
    }

    const newImages = images.filter((_, i) => i !== index);
    saveImages(newImages);
    
    if (selectedIndex >= newImages.length) {
      setSelectedIndex(newImages.length - 1);
    }
    
    toast({ title: 'Image deleted', description: 'Product image has been removed.' });
  };

  const handleLabelChange = (index: number, newLabel: string) => {
    const newImages = [...images];
    newImages[index] = { ...newImages[index], label: newLabel };
    saveImages(newImages);
  };

  const selectedImage = images[selectedIndex];

  if (images.length === 0) return null;

  return (
    <div className="space-y-4">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFileSelect(e)}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFileSelect(e, selectedIndex)}
      />

      {/* Main Image */}
      <div className="doodle-card p-4 md:p-6 relative group">
        <div 
          className={`aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text flex items-center justify-center cursor-pointer transition-transform overflow-hidden ${
            isZoomed ? 'scale-105' : ''
          }`}
          onClick={() => setIsZoomed(!isZoomed)}
        >
          {selectedImage?.url ? (
            <img 
              src={selectedImage.url} 
              alt={selectedImage.label}
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="text-center p-8">
              <ImageIcon className="w-24 h-24 mx-auto mb-4 text-doodle-text/30" />
              <p className="font-doodle text-lg text-doodle-text/60">
                {productName}
              </p>
              <p className="font-doodle text-sm text-doodle-text/40 mt-1">
                {selectedImage?.label || 'No image'}
              </p>
              {color && (
                <p className="font-doodle text-sm text-doodle-accent mt-2">
                  Color: {color}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Navigation Arrows */}
        {images.length > 1 && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); handlePrevious(); }}
              className="absolute left-2 top-1/2 -translate-y-1/2 doodle-button p-2 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Previous image"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleNext(); }}
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

      {/* Image Actions */}
      <div className="doodle-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 className="font-doodle font-bold text-doodle-text">Manage Images</h3>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="doodle-button doodle-button-primary text-sm py-2 px-3 flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Add Image
          </button>
        </div>

        {/* Current image controls */}
        <div className="flex flex-wrap items-center gap-3 p-3 bg-doodle-text/5 border-2 border-dashed border-doodle-text/20">
          <input
            type="text"
            value={selectedImage?.label || ''}
            onChange={(e) => handleLabelChange(selectedIndex, e.target.value)}
            className="doodle-input flex-1 min-w-[120px] text-sm py-1"
            placeholder="Image label"
          />
          <button
            onClick={() => replaceInputRef.current?.click()}
            className="doodle-button text-sm py-2 px-3 flex items-center gap-2"
          >
            <Upload className="w-4 h-4" /> Replace
          </button>
          <button
            onClick={() => handleDeleteImage(selectedIndex)}
            className="doodle-button text-sm py-2 px-3 flex items-center gap-2 text-doodle-accent hover:bg-doodle-accent hover:text-white"
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>
      </div>

      {/* Thumbnails */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {images.map((image, index) => (
          <button
            key={image.id}
            onClick={() => setSelectedIndex(index)}
            className={`flex-shrink-0 w-16 h-16 md:w-20 md:h-20 border-2 flex items-center justify-center transition-all overflow-hidden ${
              index === selectedIndex
                ? 'border-doodle-accent bg-doodle-accent/10'
                : 'border-doodle-text/30 hover:border-doodle-accent/50 bg-doodle-bg'
            }`}
            aria-label={`View ${image.label}`}
          >
            {image.url ? (
              <img src={image.url} alt={image.label} className="w-full h-full object-cover" />
            ) : (
              <ImageIcon className="w-6 h-6 text-doodle-text/30" />
            )}
          </button>
        ))}
        
        {/* Add image button in thumbnails */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex-shrink-0 w-16 h-16 md:w-20 md:h-20 border-2 border-dashed border-doodle-text/30 hover:border-doodle-accent flex items-center justify-center transition-all bg-doodle-bg"
          aria-label="Add new image"
        >
          <Plus className="w-6 h-6 text-doodle-text/50" />
        </button>
      </div>
    </div>
  );
};

export default ProductImageGallery;
