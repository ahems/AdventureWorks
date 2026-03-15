import React, { useState } from 'react';
import { Wand2, Sparkles, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { executeRpc } from '@/services/mockRpcServer';
import { toast } from '@/hooks/use-toast';

interface AiImageGeneratorDialogProps {
  productId: number;
  productName: string;
  onImageGenerated: (imageUrl: string, label: string) => void;
}

const AiImageGeneratorDialog: React.FC<AiImageGeneratorDialogProps> = ({
  productId,
  productName,
  onImageGenerated,
}) => {
  const [open, setOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [description, setDescription] = useState('');
  const [style, setStyle] = useState('photo');
  const [background, setBackground] = useState('white');
  const [generatedImage, setGeneratedImage] = useState<{ url: string; prompt: string } | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setGeneratedImage(null);

    try {
      const result = await executeRpc('generateProductImage', {
        productId,
        description: description || undefined,
        style,
        background,
      });

      if (result.success && result.data) {
        const data = result.data as { imageUrl: string; prompt: string };
        setGeneratedImage({ url: data.imageUrl, prompt: data.prompt });
        toast({ title: 'Image Generated', description: 'AI image has been created successfully.' });
      } else {
        toast({ title: 'Generation Failed', description: result.error || 'Failed to generate image', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Error', description: 'An error occurred while generating the image', variant: 'destructive' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddToGallery = () => {
    if (generatedImage) {
      const styleLabels: Record<string, string> = {
        photo: 'Photo',
        illustration: 'Illustration',
        '3d-render': '3D Render',
        sketch: 'Sketch',
      };
      onImageGenerated(generatedImage.url, `AI ${styleLabels[style] || style}`);
      setOpen(false);
      setGeneratedImage(null);
      setDescription('');
      toast({ title: 'Image Added', description: 'AI-generated image has been added to the product gallery.' });
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
            Generate a product image for <strong>{productName}</strong> using AI.
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
                Generating...
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4 mr-2" />
                Generate Image
              </>
            )}
          </Button>

          {generatedImage && (
            <div className="space-y-3 pt-4 border-t">
              <div className="aspect-square rounded-lg overflow-hidden border bg-muted">
                <img
                  src={generatedImage.url}
                  alt="AI Generated"
                  className="w-full h-full object-cover"
                />
              </div>
              <p className="text-xs text-muted-foreground italic">
                "{generatedImage.prompt}"
              </p>
              <Button onClick={handleAddToGallery} className="w-full gap-2">
                <Sparkles className="w-4 h-4" />
                Add to Product Gallery
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AiImageGeneratorDialog;
