import React, { useState, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  Upload,
  Trash2,
  Plus,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import {
  useProductPhotos,
  useAddProductPhoto,
  useDeleteProductPhoto,
} from "@/hooks/useAdminProducts";
import { generateThumbnail } from "@/lib/imageUtils";

interface ProductImageGalleryProps {
  productId: number;
  productName: string;
  color?: string | null;
}

/** Ensure base64 images are usable as img src regardless of how they were stored */
const toImgSrc = (value: string | null | undefined): string => {
  if (!value) return "";
  if (value.startsWith("data:")) return value;
  return `data:image/jpeg;base64,${value}`;
};

const ProductImageGallery: React.FC<ProductImageGalleryProps> = ({
  productId,
  productName,
  color,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: photoRecords = [], isLoading } = useProductPhotos(productId);
  const addPhoto = useAddProductPhoto();
  const deletePhoto = useDeleteProductPhoto();

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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    if (!file.type.startsWith("image/")) {
      toast({
        title: "Invalid file",
        description: "Please select an image file.",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please select an image under 5MB.",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    try {
      const largeBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target?.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { thumbBase64, thumbFilename } = await generateThumbnail(
        largeBase64,
        file.name,
      );

      await addPhoto.mutateAsync({
        productId,
        thumbNail: thumbBase64,
        thumbFilename,
        largePhoto: largeBase64,
        largeFilename: file.name,
        primary: photoRecords.length === 0,
      });

      setSelectedIndex(photoRecords.length); // new image will be appended
      toast({
        title: "Image added",
        description: "Product photo saved successfully.",
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
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

  const selectedRecord = photoRecords[selectedIndex];
  const selectedThumbSrc = toImgSrc(selectedRecord?.productPhoto?.LargePhoto);
  const isBusy = isUploading || addPhoto.isPending || deletePhoto.isPending;

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
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Main Image */}
      <div className="doodle-card p-4 md:p-6 relative group">
        <div
          className={`aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text flex items-center justify-center cursor-pointer transition-transform overflow-hidden ${
            isZoomed ? "scale-105" : ""
          }`}
          onClick={() => setIsZoomed(!isZoomed)}
        >
          {selectedThumbSrc ? (
            <img
              src={selectedThumbSrc}
              alt={
                selectedRecord?.productPhoto?.LargePhotoFileName || productName
              }
              className="w-full h-full object-contain"
            />
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
        {selectedThumbSrc && (
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
      </div>

      {/* Image Actions */}
      <div className="doodle-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 className="font-doodle font-bold text-doodle-text">
            Manage Images
          </h3>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            className="doodle-button doodle-button-primary text-sm py-2 px-3 flex items-center gap-2 disabled:opacity-50"
          >
            {isBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {isUploading ? "Uploading…" : "Add Image"}
          </button>
        </div>

        {/* Current image controls */}
        {selectedRecord && (
          <div className="flex flex-wrap items-center gap-3 p-3 bg-doodle-text/5 border-2 border-dashed border-doodle-text/20">
            <span className="font-doodle text-sm text-doodle-text/70 flex-1 truncate">
              {selectedRecord.productPhoto?.LargePhotoFileName ||
                `Photo ${selectedRecord.ProductPhotoID}`}
              {selectedRecord.Primary && (
                <span className="ml-2 text-xs text-doodle-green">
                  (Primary)
                </span>
              )}
            </span>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
              className="doodle-button text-sm py-2 px-3 flex items-center gap-2 disabled:opacity-50"
            >
              <Upload className="w-4 h-4" /> Add More
            </button>
            <button
              onClick={() => handleDeleteImage(selectedIndex)}
              disabled={isBusy}
              className="doodle-button text-sm py-2 px-3 flex items-center gap-2 text-doodle-accent hover:bg-doodle-accent hover:text-white disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          </div>
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

        {/* Add image button in thumbnails */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy}
          className="flex-shrink-0 w-16 h-16 md:w-20 md:h-20 border-2 border-dashed border-doodle-text/30 hover:border-doodle-accent flex items-center justify-center transition-all bg-doodle-bg disabled:opacity-50"
          aria-label="Add new image"
        >
          {isBusy ? (
            <Loader2 className="w-6 h-6 animate-spin text-doodle-text/50" />
          ) : (
            <Plus className="w-6 h-6 text-doodle-text/50" />
          )}
        </button>
      </div>
    </div>
  );
};

export default ProductImageGallery;
