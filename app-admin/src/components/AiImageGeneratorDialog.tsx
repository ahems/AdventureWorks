import React, { useState } from "react";
import { Wand2, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getFunctionsApiUrl } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

interface AiImageGeneratorDialogProps {
  productId: number;
  productName: string;
}

const AiImageGeneratorDialog: React.FC<AiImageGeneratorDialogProps> = ({
  productId,
  productName,
}) => {
  const [open, setOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [description, setDescription] = useState("");
  const [style, setStyle] = useState("photo");
  const [background, setBackground] = useState("white");

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/GenerateProductImages_HttpStart`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ProductIds: [productId] }),
        },
      );
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      toast({
        title: "Image generation queued",
        description: `AI image generation for "${productName}" has been queued. Check back in a few minutes — refresh the photo gallery to see the result.`,
      });
      setOpen(false);
      setDescription("");
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
      setIsGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Wand2 className="w-4 h-4" />
          Generate AI Image
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-doodle-accent" />
            AI Image Generator
          </DialogTitle>
          <DialogDescription>
            Generate a product image for <strong>{productName}</strong> using
            AI.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="description">Custom Description (optional)</Label>
            <Textarea
              id="description"
              placeholder={`Describe how you want the ${productName} to look...`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Style</Label>
              <Select value={style} onValueChange={setStyle}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="photo">📷 Photo</SelectItem>
                  <SelectItem value="illustration">🎨 Illustration</SelectItem>
                  <SelectItem value="3d-render">🧊 3D Render</SelectItem>
                  <SelectItem value="sketch">✏️ Sketch</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Background</Label>
              <Select value={background} onValueChange={setBackground}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="white">⬜ White</SelectItem>
                  <SelectItem value="gradient">🌈 Gradient</SelectItem>
                  <SelectItem value="studio">💡 Studio</SelectItem>
                  <SelectItem value="outdoor">🌿 Outdoor</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="w-full"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Queuing...
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4 mr-2" />
                Queue Image Generation
              </>
            )}
          </Button>

          <p className="text-xs text-muted-foreground pt-1">
            Images are generated asynchronously by Azure AI. Refresh the product
            photo gallery in a few minutes to see the result.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AiImageGeneratorDialog;
