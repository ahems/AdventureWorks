import { useState, useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Plus,
  Trash2,
  Tag,
  FileText,
  Package,
  Pencil,
  Check,
  X,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Filter,
} from "lucide-react";
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
  useAdminLocalizationsForCulture,
  useAdminProductModels,
  useCreateLocalization,
  useDeleteLocalizationLink,
  useUpdateProductDescription,
  useAdminProductNamesForCulture,
  useCreateProductName,
  useUpdateProductName,
  useDeleteProductName,
} from "@/hooks/useAdminCatalog";
import {
  useAdminCategories,
  useAdminAllSubcategories,
  useAdminAllProducts,
} from "@/hooks/useAdminProducts";

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

  // ── shared filter state ──────────────────────────────────────────────────────
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [subcategoryFilter, setSubcategoryFilter] = useState<number | null>(
    null,
  );

  // ── description tab state ────────────────────────────────────────────────────
  const [descSearch, setDescSearch] = useState("");
  const [descPage, setDescPage] = useState(1);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [newDescription, setNewDescription] = useState("");
  const [editingDescriptionId, setEditingDescriptionId] = useState<
    number | null
  >(null);
  const [editingDescText, setEditingDescText] = useState("");

  // ── product name tab state ──────────────────────────────────────────────────
  const [nameSearch, setNameSearch] = useState("");
  const [namePage, setNamePage] = useState(1);
  const [addingName, setAddingName] = useState(false);
  const [newNameProductId, setNewNameProductId] = useState<string>("");
  const [newNameText, setNewNameText] = useState("");
  const [editingNameProductId, setEditingNameProductId] = useState<
    number | null
  >(null);
  const [editingNameText, setEditingNameText] = useState("");

  // Pagination
  const ITEMS_PER_PAGE = 20;

  const { data: cultureLinks = [], isLoading: isLoadingLinks } =
    useAdminLocalizationsForCulture(open ? culture.CultureID : null);
  const { data: allModels = [], isLoading: isLoadingModels } =
    useAdminProductModels();
  const { data: productNames = [], isLoading: isLoadingNames } =
    useAdminProductNamesForCulture(open ? culture.CultureID : null);
  const { data: categories = [] } = useAdminCategories();
  const { data: allSubcategories = [] } = useAdminAllSubcategories();
  const { data: allProducts = [] } = useAdminAllProducts();

  const createLocalization = useCreateLocalization(culture.CultureID);
  const deleteLink = useDeleteLocalizationLink(culture.CultureID);
  const updateDescription = useUpdateProductDescription();
  const createProductName = useCreateProductName(culture.CultureID);
  const updateProductName = useUpdateProductName(culture.CultureID);
  const deleteProductName = useDeleteProductName(culture.CultureID);

  // ── derived lookups ──────────────────────────────────────────────────────────
  // ProductModel → set of subcategory IDs (via products)
  const modelSubcategoryIds = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const p of allProducts) {
      if (p.ProductModelID != null && p.ProductSubcategoryID != null) {
        if (!map.has(p.ProductModelID)) map.set(p.ProductModelID, new Set());
        map.get(p.ProductModelID)!.add(p.ProductSubcategoryID);
      }
    }
    return map;
  }, [allProducts]);

  // ProductID → subcategoryID
  const productSubcategoryMap = useMemo(
    () =>
      new Map(
        allProducts.map((p) => [p.ProductID, p.ProductSubcategoryID ?? null]),
      ),
    [allProducts],
  );

  // subcategoryID → categoryID
  const subcategoryCategoryMap = useMemo(
    () =>
      new Map(
        allSubcategories.map((s) => [
          s.ProductSubcategoryID,
          s.ProductCategoryID,
        ]),
      ),
    [allSubcategories],
  );

  const subcategoriesForCategory = useMemo(
    () =>
      categoryFilter
        ? allSubcategories.filter((s) => s.ProductCategoryID === categoryFilter)
        : [],
    [allSubcategories, categoryFilter],
  );

  // ── Description tab: enrich + filter + paginate ──────────────────────────────
  const enrichedLocalizations = useMemo(() => {
    return cultureLinks.map((link) => {
      const model = allModels.find((m) => m.ProductModelID === link.ProductModelID);
      return { ...link, model };
    });
  }, [cultureLinks, allModels]);

  const filteredLocalizations = useMemo(() => {
    return enrichedLocalizations.filter((loc) => {
      const matchesSearch =
        !descSearch ||
        loc.model?.Name.toLowerCase().includes(descSearch.toLowerCase()) ||
        (loc.productDescription?.Description ?? "").toLowerCase().includes(descSearch.toLowerCase());
      const matchesCategory =
        !categoryFilter ||
        (() => {
          const subIds = modelSubcategoryIds.get(loc.ProductModelID) ?? new Set<number>();
          for (const subId of subIds) {
            const sub = allSubcategories.find((s) => s.ProductSubcategoryID === subId);
            if (sub?.ProductCategoryID === categoryFilter) return true;
          }
          return false;
        })();
      const matchesSubcategory =
        !subcategoryFilter ||
        (modelSubcategoryIds.get(loc.ProductModelID)?.has(subcategoryFilter) ?? false);
      return matchesSearch && matchesCategory && matchesSubcategory;
    });
  }, [enrichedLocalizations, descSearch, categoryFilter, subcategoryFilter, modelSubcategoryIds, allSubcategories]);

  const descTotalPages = Math.ceil(filteredLocalizations.length / ITEMS_PER_PAGE);
  const paginatedLocalizations = filteredLocalizations.slice(
    (descPage - 1) * ITEMS_PER_PAGE,
    descPage * ITEMS_PER_PAGE,
  );

  const availableModels = useMemo(() => {
    const localizedIds = new Set(cultureLinks.map((l) => l.ProductModelID));
    return allModels.filter((m) => !localizedIds.has(m.ProductModelID));
  }, [allModels, cultureLinks]);

  // ── Product Name tab: filter + paginate ───────────────────────────────────────────
  const translatedNameMap = useMemo(
    () => new Map(productNames.map((n) => [n.ProductID, n.Name])),
    [productNames],
  );
  const finishedProducts = useMemo(
    () => allProducts.filter((p) => p.ProductSubcategoryID != null),
    [allProducts],
  );
  const filteredProducts = useMemo(() => {
    return finishedProducts.filter((p) => {
      const translatedName = translatedNameMap.get(p.ProductID) ?? "";
      const matchesSearch =
        !nameSearch ||
        p.Name.toLowerCase().includes(nameSearch.toLowerCase()) ||
        translatedName.toLowerCase().includes(nameSearch.toLowerCase());
      const matchesCategory =
        !categoryFilter ||
        (() => {
          const subId = productSubcategoryMap.get(p.ProductID);
          if (subId == null) return false;
          return subcategoryCategoryMap.get(subId) === categoryFilter;
        })();
      const matchesSubcategory =
        !subcategoryFilter ||
        productSubcategoryMap.get(p.ProductID) === subcategoryFilter;
      return matchesSearch && matchesCategory && matchesSubcategory;
    });
  }, [finishedProducts, nameSearch, categoryFilter, subcategoryFilter, productSubcategoryMap, subcategoryCategoryMap, translatedNameMap]);

  const nameTotalPages = Math.ceil(filteredProducts.length / ITEMS_PER_PAGE);
  const paginatedProducts = filteredProducts.slice(
    (namePage - 1) * ITEMS_PER_PAGE,
    namePage * ITEMS_PER_PAGE,
  );
  const untranslatedProducts = useMemo(
    () => finishedProducts.filter((p) => !translatedNameMap.has(p.ProductID)),
    [finishedProducts, translatedNameMap],
  );
  const translatedCount = productNames.length;

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleAddLocalization = async () => {
    if (!selectedModelId || !newDescription.trim()) {
      toast({ title: "Validation Error", description: "Please select a product model and enter a description.", variant: "destructive" });
      return;
    }
    try {
      await createLocalization.mutateAsync({ productModelId: parseInt(selectedModelId), description: newDescription.trim() });
      const modelName = allModels.find((m) => m.ProductModelID === parseInt(selectedModelId))?.Name;
      toast({ title: "Localization Added", description: `Added ${culture.Name} description for "${modelName}".` });
      setIsAddingNew(false); setSelectedModelId(""); setNewDescription("");
    } catch (err) {
      toast({ title: "Failed to add localization", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

  const handleRemoveLocalization = async (link: { ProductModelID: number; ProductDescriptionID: number }) => {
    try {
      await deleteLink.mutateAsync({ productModelId: link.ProductModelID, productDescriptionId: link.ProductDescriptionID });
      toast({ title: "Localization Removed", description: `Removed ${culture.Name} description successfully.` });
    } catch (err) {
      toast({ title: "Failed to remove localization", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

  const handleSaveDescEdit = async (descriptionId: number) => {
    if (!editingDescText.trim()) {
      toast({ title: "Validation Error", description: "Description cannot be empty.", variant: "destructive" });
      return;
    }
    try {
      await updateDescription.mutateAsync({ productDescriptionId: descriptionId, description: editingDescText.trim() });
      toast({ title: "Description Updated", description: "Product description has been saved." });
      setEditingDescriptionId(null); setEditingDescText("");
    } catch (err) {
      toast({ title: "Failed to update description", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

  const handleAddProductName = async () => {
    if (!newNameProductId || !newNameText.trim()) {
      toast({ title: "Validation Error", description: "Please select a product and enter a translated name.", variant: "destructive" });
      return;
    }
    try {
      await createProductName.mutateAsync({ productId: parseInt(newNameProductId), name: newNameText.trim() });
      const product = allProducts.find((p) => p.ProductID === parseInt(newNameProductId))?.Name;
      toast({ title: "Name Translation Added", description: `Added ${culture.Name} name for "${product}".` });
      setAddingName(false); setNewNameProductId(""); setNewNameText("");
    } catch (err) {
      toast({ title: "Failed to add name", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

  const handleSaveNameEdit = async (productId: number) => {
    if (!editingNameText.trim()) {
      toast({ title: "Validation Error", description: "Name cannot be empty.", variant: "destructive" });
      return;
    }
    try {
      await updateProductName.mutateAsync({ productId, name: editingNameText.trim() });
      toast({ title: "Name Updated", description: "Product name translation has been saved." });
      setEditingNameProductId(null); setEditingNameText("");
    } catch (err) {
      toast({ title: "Failed to update name", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

  const handleDeleteProductName = async (productId: number) => {
    try {
      await deleteProductName.mutateAsync({ productId });
      toast({ title: "Name Translation Removed", description: "Product name translation removed." });
    } catch (err) {
      toast({ title: "Failed to remove name", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

  // ── Shared category/subcategory filter UI ────────────────────────────────────
  const CategoryFilter = () => (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Filter className="h-4 w-4" /><span>Filter:</span>
      </div>
      <select
        value={categoryFilter ?? ""}
        onChange={(e) => { setCategoryFilter(e.target.value ? Number(e.target.value) : null); setSubcategoryFilter(null); setDescPage(1); setNamePage(1); }}
        className="text-sm border rounded px-2 py-1 bg-background"
      >
        <option value="">All Categories</option>
        {categories.map((c) => <option key={c.ProductCategoryID} value={c.ProductCategoryID}>{c.Name}</option>)}
      </select>
      {categoryFilter !== null && subcategoriesForCategory.length > 0 && (
        <select
          value={subcategoryFilter ?? ""}
          onChange={(e) => { setSubcategoryFilter(e.target.value ? Number(e.target.value) : null); setDescPage(1); setNamePage(1); }}
          className="text-sm border rounded px-2 py-1 bg-background"
        >
          <option value="">All Subcategories</option>
          {subcategoriesForCategory.map((s) => <option key={s.ProductSubcategoryID} value={s.ProductSubcategoryID}>{s.Name}</option>)}
        </select>
      )}
      {(categoryFilter !== null || subcategoryFilter !== null) && (
        <button onClick={() => { setCategoryFilter(null); setSubcategoryFilter(null); setDescPage(1); setNamePage(1); }} className="text-xs text-muted-foreground hover:text-foreground underline">Clear</button>
      )}
    </div>
  );

  const isLoading = isLoadingLinks || isLoadingModels || isLoadingNames;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Product Localizations — {culture.Name}
          </DialogTitle>
          <DialogDescription>
            Manage translations for {culture.Name} ({culture.CultureID})
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading localizations…
            </div>
          ) : (
            <Tabs defaultValue="descriptions" className="flex flex-col flex-1 overflow-hidden">
              <TabsList className="w-full">
                <TabsTrigger value="descriptions" className="flex items-center gap-2 flex-1">
                  <FileText className="h-4 w-4" />
                  Model Descriptions
                  <Badge variant="secondary" className="ml-1 text-xs">{cultureLinks.length}</Badge>
                </TabsTrigger>
                <TabsTrigger value="names" className="flex items-center gap-2 flex-1">
                  <Tag className="h-4 w-4" />
                  Product Names
                  <Badge variant="secondary" className="ml-1 text-xs">{translatedCount}</Badge>
                </TabsTrigger>
              </TabsList>

              {/* ── MODEL DESCRIPTIONS TAB ─────────────────────────────────── */}
              <TabsContent value="descriptions" className="flex flex-col gap-3 flex-1 overflow-hidden mt-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{cultureLinks.length} model description{cultureLinks.length !== 1 ? "s" : ""} localized</span>
                  <Button size="sm" onClick={() => setIsAddingNew(true)} disabled={availableModels.length === 0 || isAddingNew}>
                    <Plus className="h-4 w-4 mr-2" />Add Description
                  </Button>
                </div>

                {isAddingNew && (
                  <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                    <div className="grid gap-2">
                      <Label>Product Model</Label>
                      <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                        <SelectTrigger><SelectValue placeholder="Select a product model…" /></SelectTrigger>
                        <SelectContent>
                          {availableModels.map((model) => (
                            <SelectItem key={model.ProductModelID} value={model.ProductModelID.toString()}>
                              <span className="flex items-center gap-2"><Package className="h-4 w-4" />{model.Name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Description ({culture.Name})</Label>
                      <Textarea placeholder={`Enter the product description in ${culture.Name}…`} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} rows={3} />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => { setIsAddingNew(false); setSelectedModelId(""); setNewDescription(""); }} disabled={createLocalization.isPending}>Cancel</Button>
                      <Button size="sm" onClick={handleAddLocalization} disabled={createLocalization.isPending}>
                        {createLocalization.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Add Description
                      </Button>
                    </div>
                  </div>
                )}

                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Search models or descriptions…" value={descSearch} onChange={(e) => { setDescSearch(e.target.value); setDescPage(1); }} className="pl-10" />
                </div>

                <CategoryFilter />

                <ScrollArea className="flex-1 border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[200px]">Product Model</TableHead>
                        <TableHead>Description ({culture.Name})</TableHead>
                        <TableHead className="w-[80px] text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredLocalizations.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                            {cultureLinks.length === 0 ? `No model descriptions localized for ${culture.Name} yet.` : "No matching localizations found."}
                          </TableCell>
                        </TableRow>
                      ) : paginatedLocalizations.map((loc) => {
                        const isEditing = editingDescriptionId === loc.ProductDescriptionID;
                        return (
                          <TableRow key={`${loc.ProductModelID}-${loc.ProductDescriptionID}`}>
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2"><Package className="h-4 w-4 text-muted-foreground" />{loc.model?.Name || `Model ${loc.ProductModelID}`}</div>
                            </TableCell>
                            <TableCell className="text-sm">
                              {isEditing ? (
                                <div className="flex items-center gap-2">
                                  <Textarea value={editingDescText} onChange={(e) => setEditingDescText(e.target.value)} className="min-h-[60px] text-sm" autoFocus />
                                  <div className="flex flex-col gap-1">
                                    <Button variant="ghost" size="sm" onClick={() => handleSaveDescEdit(loc.ProductDescriptionID)} disabled={updateDescription.isPending} className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-100">
                                      {updateDescription.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => { setEditingDescriptionId(null); setEditingDescText(""); }} className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground">
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="group cursor-pointer flex items-start gap-2 text-muted-foreground hover:text-foreground"
                                  onClick={() => { setEditingDescriptionId(loc.ProductDescriptionID); setEditingDescText(loc.productDescription?.Description || ""); }}>
                                  <span className="flex-1">{loc.productDescription?.Description || "—"}</span>
                                  <Pencil className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5 shrink-0" />
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" onClick={() => handleRemoveLocalization(loc)} className="text-destructive hover:text-destructive" disabled={isEditing || deleteLink.isPending}>
                                {deleteLink.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{filteredLocalizations.length} of {cultureLinks.length} shown</span>
                  {descTotalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setDescPage((p) => Math.max(1, p - 1))} disabled={descPage === 1}><ChevronLeft className="h-4 w-4" /></Button>
                      <span>Page {descPage} of {descTotalPages}</span>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setDescPage((p) => Math.min(descTotalPages, p + 1))} disabled={descPage === descTotalPages}><ChevronRight className="h-4 w-4" /></Button>
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* ── PRODUCT NAMES TAB ──────────────────────────────────────── */}
              <TabsContent value="names" className="flex flex-col gap-3 flex-1 overflow-hidden mt-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{translatedCount} of {finishedProducts.length} product name{finishedProducts.length !== 1 ? "s" : ""} translated</span>
                  <Button size="sm" onClick={() => setAddingName(true)} disabled={untranslatedProducts.length === 0 || addingName}>
                    <Plus className="h-4 w-4 mr-2" />Add Name
                  </Button>
                </div>

                {addingName && (
                  <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                    <div className="grid gap-2">
                      <Label>Product (English name)</Label>
                      <Select value={newNameProductId} onValueChange={setNewNameProductId}>
                        <SelectTrigger><SelectValue placeholder="Select a product…" /></SelectTrigger>
                        <SelectContent>
                          {untranslatedProducts.map((p) => (
                            <SelectItem key={p.ProductID} value={p.ProductID.toString()}>
                              <span className="flex items-center gap-2"><Package className="h-4 w-4" />{p.Name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Translated Name ({culture.Name})</Label>
                      <Input placeholder={`Enter product name in ${culture.Name}…`} value={newNameText} onChange={(e) => setNewNameText(e.target.value)} />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => { setAddingName(false); setNewNameProductId(""); setNewNameText(""); }} disabled={createProductName.isPending}>Cancel</Button>
                      <Button size="sm" onClick={handleAddProductName} disabled={createProductName.isPending}>
                        {createProductName.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Add Name
                      </Button>
                    </div>
                  </div>
                )}

                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Search products or translated names…" value={nameSearch} onChange={(e) => { setNameSearch(e.target.value); setNamePage(1); }} className="pl-10" />
                </div>

                <CategoryFilter />

                <ScrollArea className="flex-1 border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[220px]">Product (English)</TableHead>
                        <TableHead>Name ({culture.Name})</TableHead>
                        <TableHead className="w-[80px] text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredProducts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No matching products found.</TableCell>
                        </TableRow>
                      ) : paginatedProducts.map((p) => {
                        const translatedName = translatedNameMap.get(p.ProductID);
                        const isEditing = editingNameProductId === p.ProductID;
                        return (
                          <TableRow key={p.ProductID}>
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2"><Package className="h-4 w-4 text-muted-foreground" />{p.Name}</div>
                            </TableCell>
                            <TableCell className="text-sm">
                              {isEditing ? (
                                <div className="flex items-center gap-2">
                                  <Input value={editingNameText} onChange={(e) => setEditingNameText(e.target.value)} className="h-8 text-sm" autoFocus
                                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveNameEdit(p.ProductID); if (e.key === "Escape") { setEditingNameProductId(null); setEditingNameText(""); } }} />
                                  <div className="flex gap-1">
                                    <Button variant="ghost" size="sm" onClick={() => handleSaveNameEdit(p.ProductID)} disabled={updateProductName.isPending} className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-100">
                                      {updateProductName.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => { setEditingNameProductId(null); setEditingNameText(""); }} className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground">
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              ) : translatedName ? (
                                <div className="group cursor-pointer flex items-center gap-2 hover:text-foreground"
                                  onClick={() => { setEditingNameProductId(p.ProductID); setEditingNameText(translatedName); }}>
                                  <span className="flex-1">{translatedName}</span>
                                  <Pencil className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                                </div>
                              ) : (
                                <button className="text-muted-foreground/50 hover:text-muted-foreground italic text-xs"
                                  onClick={() => { setEditingNameProductId(p.ProductID); setEditingNameText(""); }}>
                                  Click to add translation
                                </button>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {translatedName && (
                                <Button variant="ghost" size="sm" onClick={() => handleDeleteProductName(p.ProductID)} className="text-destructive hover:text-destructive" disabled={isEditing || deleteProductName.isPending}>
                                  {deleteProductName.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{filteredProducts.length} product{filteredProducts.length !== 1 ? "s" : ""} shown{filteredProducts.length !== finishedProducts.length ? ` (filtered from ${finishedProducts.length})` : ""}</span>
                  {nameTotalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setNamePage((p) => Math.max(1, p - 1))} disabled={namePage === 1}><ChevronLeft className="h-4 w-4" /></Button>
                      <span>Page {namePage} of {nameTotalPages}</span>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setNamePage((p) => Math.min(nameTotalPages, p + 1))} disabled={namePage === nameTotalPages}><ChevronRight className="h-4 w-4" /></Button>
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default LocalizationDialog;
