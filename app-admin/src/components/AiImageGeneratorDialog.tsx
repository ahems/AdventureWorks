import React, { useState } from "react";
import { Images, Loader2, Sparkles, AlertCircle, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { getFunctionsApiUrl } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

interface AiImageGeneratorDialogProps {
  productId: number;
  productName: string;
  description?: string | null;
  categoryName?: string | null;
  subcategoryName?: string | null;
  color?: string | null;
  productLine?: string | null;
  style?: string | null;
}

interface AttributeRowProps {
  label: string;
  value?: string | null;
  required?: boolean;
}

const AttributeRow: React.FC<AttributeRowProps> = ({
  label,
  value,
  required,
}) => {
  const missing = !value;
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-doodle-text/10 last:border-0">
      <span className="font-doodle text-sm text-doodle-text/70 shrink-0 w-32">
        {label}
      </span>
      {missing ? (
        <span
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
            required
              ? "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
              : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
          }`}
        >
          <AlertCircle className="w-3 h-3" />
          {required ? "Missing — required" : "Missing — optional"}
        </span>
      ) : (
        <span className="text-sm text-doodle-text font-medium">{value}</span>
      )}
    </div>
  );
};

const AiImageGeneratorDialog: React.FC<AiImageGeneratorDialogProps> = ({
  productId,
  productName,
  description,
  categoryName,
  subcategoryName,
  color,
  productLine,
  style,
}) => {
  const [open, setOpen] = useState(false);
  const [isQueuing, setIsQueuing] = useState(false);

  const isUniversal = style?.toLowerCase() === "universal";
  const imageCount = isUniversal ? 5 : 4;

  const handleQueue = async () => {
    setIsQueuing(true);
    try {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/products/${productId}/generate-images`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      toast({
        title: "Image generation queued",
        description: `${imageCount} AI images for "${productName}" have been queued. Refresh the photo gallery in a few minutes to see them.`,
      });
      setOpen(false);
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to queue image generation",
        variant: "destructive",
      });
    } finally {
      setIsQueuing(false);
    }
  };

  const missingRequired = !description || !categoryName;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="doodle-button doodle-button-primary w-full py-3 flex items-center justify-center gap-2 text-base font-bold"
        >
          <Sparkles className="w-5 h-5" />
          Generate AI Images
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-doodle-accent" />
            Generate AI Images
          </DialogTitle>
          <DialogDescription>
            The following product attributes will be used to generate{" "}
            <strong>{imageCount} images</strong> for{" "}
            <strong>{productName}</strong>.{" "}
            {isUniversal && (
              <span>
                Universal style products get an extra image — both a male and
                female model are shown.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-1">
          <AttributeRow label="Product Name" value={productName} required />
          <AttributeRow label="Description" value={description} required />
          <AttributeRow label="Category" value={categoryName} required />
          <AttributeRow label="Subcategory" value={subcategoryName} />
          <AttributeRow label="Product Line" value={productLine} />
          <AttributeRow label="Color" value={color} />
          <AttributeRow label="Style" value={style} />
        </div>

        {missingRequired && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Required attributes are missing. Save the product with a
              description and category before generating images for best
              results.
            </span>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-700 dark:text-blue-400">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Images are generated and thumbnails created asynchronously by Azure
            AI. Refresh the photo gallery in a few minutes to see the results.
          </span>
        </div>

        <button
          type="button"
          onClick={handleQueue}
          disabled={isQueuing}
          className="doodle-button doodle-button-primary w-full py-2.5 flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {isQueuing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Queuing…
            </>
          ) : (
            <>
              <Images className="w-4 h-4" />
              Queue Image Generation
            </>
          )}
        </button>
      </DialogContent>
    </Dialog>
  );
};

export default AiImageGeneratorDialog;
