import { useState, useMemo } from "react";
import { Search, Plus, Trash2, FileText, Package, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { Culture } from "@/types/culture";
import {
  ProductDescription,
  ProductModel,
  ProductModelProductDescriptionCulture,
} from "@/types/productLocalization";
import {
  productModels,
  productDescriptions as initialDescriptions,
  productModelDescriptionCultures as initialLinks,
} from "@/data/mockProductLocalizations";

interface LocalizationDialogProps {
  culture: Culture;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const LocalizationDialog = ({
  culture,
  open,
  onOpenChange,
}: LocalizationDialogProps) => {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [links, setLinks] = useState<ProductModelProductDescriptionCulture[]>(initialLinks);
  const [descriptions, setDescriptions] = useState<ProductDescription[]>(initialDescriptions);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [newDescription, setNewDescription] = useState("");
  const [editingDescriptionId, setEditingDescriptionId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");

  // Get localizations for this culture
  const cultureLinks = useMemo(() => {
    return links.filter((link) => link.CultureID === culture.CultureID);
  }, [links, culture.CultureID]);

  // Enrich with model and description data
  const enrichedLocalizations = useMemo(() => {
    return cultureLinks.map((link) => {
      const model = productModels.find((m) => m.ProductModelID === link.ProductModelID);
      const description = descriptions.find(
        (d) => d.ProductDescriptionID === link.ProductDescriptionID
      );
      return { ...link, model, description };
    });
  }, [cultureLinks, descriptions]);

  const filteredLocalizations = enrichedLocalizations.filter(
    (loc) =>
      loc.model?.Name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      loc.description?.Description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Get models not yet localized for this culture
  const availableModels = useMemo(() => {
    const localizedModelIds = cultureLinks.map((l) => l.ProductModelID);
    return productModels.filter((m) => !localizedModelIds.includes(m.ProductModelID));
  }, [cultureLinks]);

  const handleAddLocalization = () => {
    if (!selectedModelId || !newDescription.trim()) {
      toast({
        title: "Validation Error",
        description: "Please select a product model and enter a description.",
        variant: "destructive",
      });
      return;
    }

    const modelId = parseInt(selectedModelId);
    
    // Create new description
    const newDescriptionId = Math.max(...descriptions.map((d) => d.ProductDescriptionID)) + 1;
    const newDesc: ProductDescription = {
      ProductDescriptionID: newDescriptionId,
      Description: newDescription.trim(),
      rowguid: crypto.randomUUID(),
      ModifiedDate: new Date().toISOString(),
    };
    setDescriptions((prev) => [...prev, newDesc]);

    // Create the link
    const newLink: ProductModelProductDescriptionCulture = {
      ProductModelID: modelId,
      ProductDescriptionID: newDescriptionId,
      CultureID: culture.CultureID,
      ModifiedDate: new Date().toISOString(),
    };
    setLinks((prev) => [...prev, newLink]);

    const model = productModels.find((m) => m.ProductModelID === modelId);
    toast({
      title: "Localization Added",
      description: `Added ${culture.Name} description for "${model?.Name}".`,
    });

    setIsAddingNew(false);
    setSelectedModelId("");
    setNewDescription("");
  };

  const handleRemoveLocalization = (link: ProductModelProductDescriptionCulture) => {
    setLinks((prev) =>
      prev.filter(
        (l) =>
          !(
            l.ProductModelID === link.ProductModelID &&
            l.ProductDescriptionID === link.ProductDescriptionID &&
            l.CultureID === link.CultureID
          )
      )
    );
    const model = productModels.find((m) => m.ProductModelID === link.ProductModelID);
    toast({
      title: "Localization Removed",
      description: `Removed ${culture.Name} description from "${model?.Name}".`,
    });
  };

  const handleStartEdit = (descriptionId: number, currentText: string) => {
    setEditingDescriptionId(descriptionId);
    setEditingText(currentText);
  };

  const handleCancelEdit = () => {
    setEditingDescriptionId(null);
    setEditingText("");
  };

  const handleSaveEdit = (descriptionId: number) => {
    if (!editingText.trim()) {
      toast({
        title: "Validation Error",
        description: "Description cannot be empty.",
        variant: "destructive",
      });
      return;
    }

    setDescriptions((prev) =>
      prev.map((desc) =>
        desc.ProductDescriptionID === descriptionId
          ? { ...desc, Description: editingText.trim(), ModifiedDate: new Date().toISOString() }
          : desc
      )
    );

    toast({
      title: "Description Updated",
      description: "Product description has been saved.",
    });

    setEditingDescriptionId(null);
    setEditingText("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Product Localizations - {culture.Name}
          </DialogTitle>
          <DialogDescription>
            Manage product descriptions translated into {culture.Name} ({culture.CultureID})
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 overflow-hidden">
          {/* Stats */}
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="text-sm">
              {cultureLinks.length} localized products
            </Badge>
            <Button
              size="sm"
              onClick={() => setIsAddingNew(true)}
              disabled={availableModels.length === 0}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Localization
            </Button>
          </div>

          {/* Add New Form */}
          {isAddingNew && (
            <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <Label>Product Model</Label>
                  <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a product model..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((model) => (
                        <SelectItem
                          key={model.ProductModelID}
                          value={model.ProductModelID.toString()}
                        >
                          <span className="flex items-center gap-2">
                            <Package className="h-4 w-4" />
                            {model.Name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Description ({culture.Name})</Label>
                  <Textarea
                    placeholder={`Enter the product description in ${culture.Name}...`}
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsAddingNew(false);
                    setSelectedModelId("");
                    setNewDescription("");
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={handleAddLocalization}>
                  Add Localization
                </Button>
              </div>
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search product models or descriptions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Table */}
          <ScrollArea className="flex-1 border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Product Model</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[80px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLocalizations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                      {cultureLinks.length === 0
                        ? `No product descriptions localized for ${culture.Name} yet.`
                        : "No matching localizations found."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLocalizations.map((loc) => {
                    const isEditing = editingDescriptionId === loc.ProductDescriptionID;
                    return (
                      <TableRow
                        key={`${loc.ProductModelID}-${loc.ProductDescriptionID}`}
                      >
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <Package className="h-4 w-4 text-muted-foreground" />
                            {loc.model?.Name || `Model ${loc.ProductModelID}`}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <Textarea
                                value={editingText}
                                onChange={(e) => setEditingText(e.target.value)}
                                className="min-h-[60px] text-sm"
                                autoFocus
                              />
                              <div className="flex flex-col gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleSaveEdit(loc.ProductDescriptionID)}
                                  className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-100"
                                >
                                  <Check className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={handleCancelEdit}
                                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div
                              className="group cursor-pointer flex items-start gap-2 text-muted-foreground hover:text-foreground"
                              onClick={() => handleStartEdit(loc.ProductDescriptionID, loc.description?.Description || "")}
                            >
                              <span className="flex-1">{loc.description?.Description || "—"}</span>
                              <Pencil className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5 shrink-0" />
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveLocalization(loc)}
                            className="text-destructive hover:text-destructive"
                            disabled={isEditing}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default LocalizationDialog;
