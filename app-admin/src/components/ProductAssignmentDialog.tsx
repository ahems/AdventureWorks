import React, { useState, useMemo } from "react";
import {
  Search,
  X,
  Package,
  Check,
  FolderOpen,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Product } from "@/types/product";
import {
  useAdminAllProducts,
  useAdminCategories,
  useAdminAllSubcategories,
} from "@/hooks/useAdminProducts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ProductAssignmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  promotionName: string;
  assignedProductIds: number[];
  onSave: (productIds: number[]) => void;
}

const ProductAssignmentDialog: React.FC<ProductAssignmentDialogProps> = ({
  open,
  onOpenChange,
  promotionName,
  assignedProductIds,
  onSave,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    new Set(assignedProductIds),
  );
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(
    new Set(),
  );
  const [showCategoryView, setShowCategoryView] = useState(false);

  const { data: products = [] } = useAdminAllProducts();
  const { data: categories = [] } = useAdminCategories();
  const { data: subcategories = [] } = useAdminAllSubcategories();

  // Reset selection when dialog opens
  React.useEffect(() => {
    if (open) {
      setSelectedIds(new Set(assignedProductIds));
      setSearchQuery("");
      setShowCategoryView(false);
      setExpandedCategories(new Set());
    }
  }, [open, assignedProductIds]);

  // Group products by category and subcategory
  const productsByCategory = useMemo(() => {
    const grouped: Record<number, Record<number, Product[]>> = {};

    categories.forEach((cat) => {
      grouped[cat.ProductCategoryID] = {};
      subcategories
        .filter((sub) => sub.ProductCategoryID === cat.ProductCategoryID)
        .forEach((sub) => {
          grouped[cat.ProductCategoryID][sub.ProductSubcategoryID] =
            products.filter(
              (p) => p.ProductSubcategoryID === sub.ProductSubcategoryID,
            );
        });
    });

    return grouped;
  }, [categories, subcategories, products]);

  const filteredProducts = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return products.filter(
      (p) =>
        p.Name.toLowerCase().includes(query) ||
        p.ProductNumber.toLowerCase().includes(query),
    );
  }, [searchQuery, products]);

  const toggleProduct = (productId: number) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(productId)) {
        newSet.delete(productId);
      } else {
        newSet.add(productId);
      }
      return newSet;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === filteredProducts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProducts.map((p) => p.ProductID)));
    }
  };

  const toggleCategory = (categoryId: number) => {
    const categoryProducts = Object.values(
      productsByCategory[categoryId] || {},
    ).flat();
    const allSelected = categoryProducts.every((p) =>
      selectedIds.has(p.ProductID),
    );

    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      categoryProducts.forEach((p) => {
        if (allSelected) {
          newSet.delete(p.ProductID);
        } else {
          newSet.add(p.ProductID);
        }
      });
      return newSet;
    });
  };

  const toggleSubcategory = (subcategoryId: number) => {
    const subcategoryProducts = products.filter(
      (p) => p.ProductSubcategoryID === subcategoryId,
    );
    const allSelected = subcategoryProducts.every((p) =>
      selectedIds.has(p.ProductID),
    );

    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      subcategoryProducts.forEach((p) => {
        if (allSelected) {
          newSet.delete(p.ProductID);
        } else {
          newSet.add(p.ProductID);
        }
      });
      return newSet;
    });
  };

  const toggleExpandCategory = (categoryId: number) => {
    setExpandedCategories((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(categoryId)) {
        newSet.delete(categoryId);
      } else {
        newSet.add(categoryId);
      }
      return newSet;
    });
  };

  const getCategorySelectionState = (categoryId: number) => {
    const categoryProducts = Object.values(
      productsByCategory[categoryId] || {},
    ).flat();
    if (categoryProducts.length === 0) return "none";
    const selectedCount = categoryProducts.filter((p) =>
      selectedIds.has(p.ProductID),
    ).length;
    if (selectedCount === 0) return "none";
    if (selectedCount === categoryProducts.length) return "all";
    return "partial";
  };

  const getSubcategorySelectionState = (subcategoryId: number) => {
    const subcategoryProducts = products.filter(
      (p) => p.ProductSubcategoryID === subcategoryId,
    );
    if (subcategoryProducts.length === 0) return "none";
    const selectedCount = subcategoryProducts.filter((p) =>
      selectedIds.has(p.ProductID),
    ).length;
    if (selectedCount === 0) return "none";
    if (selectedCount === subcategoryProducts.length) return "all";
    return "partial";
  };

  const handleSave = () => {
    onSave(Array.from(selectedIds));
    onOpenChange(false);
  };

  const selectedCount = selectedIds.size;
  const allSelected =
    filteredProducts.length > 0 && selectedIds.size === filteredProducts.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-doodle-bg border-[3px] border-doodle-text max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-doodle text-xl text-doodle-text flex items-center gap-2">
            <Package className="w-5 h-5" />
            Assign Products
          </DialogTitle>
          <DialogDescription className="font-doodle text-doodle-text/60">
            Select products to include in "{promotionName}"
          </DialogDescription>
        </DialogHeader>

        {/* Search and View Toggle */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-doodle-text/40" />
            <Input
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="doodle-input pl-10"
              disabled={showCategoryView}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-doodle-text/40 hover:text-doodle-text"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            onClick={() => setShowCategoryView(!showCategoryView)}
            className={`font-doodle border-2 border-doodle-text/20 ${showCategoryView ? "bg-doodle-accent/20 border-doodle-accent" : ""}`}
          >
            <FolderOpen className="w-4 h-4 mr-2" />
            {showCategoryView ? "List View" : "By Category"}
          </Button>
        </div>

        {/* Select all / Count */}
        <div className="flex items-center justify-between py-2 border-b-2 border-doodle-text/20">
          {!showCategoryView && (
            <button
              onClick={toggleAll}
              className="flex items-center gap-2 font-doodle text-sm text-doodle-text hover:text-doodle-accent transition-colors"
            >
              <Checkbox checked={allSelected} />
              <span>Select all ({filteredProducts.length})</span>
            </button>
          )}
          {showCategoryView && (
            <span className="font-doodle text-sm text-doodle-text/60">
              Select by category or subcategory
            </span>
          )}
          <span className="font-doodle text-sm text-doodle-text/60">
            {selectedCount} selected
          </span>
        </div>

        {/* Product List or Category View */}
        <ScrollArea className="flex-1 min-h-0 max-h-[40vh]">
          {showCategoryView ? (
            <div className="space-y-2 pr-4">
              {categories.map((category) => {
                const categoryState = getCategorySelectionState(
                  category.ProductCategoryID,
                );
                const isExpanded = expandedCategories.has(
                  category.ProductCategoryID,
                );
                const categorySubcategories = subcategories.filter(
                  (sub) => sub.ProductCategoryID === category.ProductCategoryID,
                );

                return (
                  <Collapsible
                    key={category.ProductCategoryID}
                    open={isExpanded}
                    onOpenChange={() =>
                      toggleExpandCategory(category.ProductCategoryID)
                    }
                  >
                    <div className="border-2 border-doodle-text/20">
                      <div className="flex items-center gap-2 p-3 bg-doodle-bg">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCategory(category.ProductCategoryID);
                          }}
                          className="flex items-center"
                        >
                          <div
                            className={`w-5 h-5 border-2 flex items-center justify-center transition-colors ${
                              categoryState === "all"
                                ? "border-doodle-accent bg-doodle-accent text-doodle-bg"
                                : categoryState === "partial"
                                  ? "border-doodle-accent bg-doodle-accent/30"
                                  : "border-doodle-text/40"
                            }`}
                          >
                            {categoryState === "all" && (
                              <Check className="w-3 h-3" />
                            )}
                            {categoryState === "partial" && (
                              <div className="w-2 h-0.5 bg-doodle-accent" />
                            )}
                          </div>
                        </button>
                        <CollapsibleTrigger className="flex-1 flex items-center justify-between text-left hover:text-doodle-accent">
                          <span className="font-doodle font-bold text-doodle-text">
                            {category.Name}
                          </span>
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </CollapsibleTrigger>
                      </div>
                      <CollapsibleContent>
                        <div className="border-t-2 border-doodle-text/10">
                          {categorySubcategories.map((subcategory) => {
                            const subcatState = getSubcategorySelectionState(
                              subcategory.ProductSubcategoryID,
                            );
                            const productCount = products.filter(
                              (p) =>
                                p.ProductSubcategoryID ===
                                subcategory.ProductSubcategoryID,
                            ).length;

                            return (
                              <button
                                key={subcategory.ProductSubcategoryID}
                                onClick={() =>
                                  toggleSubcategory(
                                    subcategory.ProductSubcategoryID,
                                  )
                                }
                                className="w-full flex items-center gap-3 p-3 pl-10 hover:bg-doodle-accent/5 transition-colors"
                              >
                                <div
                                  className={`w-5 h-5 border-2 flex items-center justify-center transition-colors ${
                                    subcatState === "all"
                                      ? "border-doodle-accent bg-doodle-accent text-doodle-bg"
                                      : subcatState === "partial"
                                        ? "border-doodle-accent bg-doodle-accent/30"
                                        : "border-doodle-text/40"
                                  }`}
                                >
                                  {subcatState === "all" && (
                                    <Check className="w-3 h-3" />
                                  )}
                                  {subcatState === "partial" && (
                                    <div className="w-2 h-0.5 bg-doodle-accent" />
                                  )}
                                </div>
                                <span className="font-doodle text-sm text-doodle-text flex-1 text-left">
                                  {subcategory.Name}
                                </span>
                                <span className="font-doodle text-xs text-doodle-text/50">
                                  {productCount} products
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          ) : (
            <div className="space-y-1 pr-4">
              {filteredProducts.length === 0 ? (
                <p className="font-doodle text-doodle-text/50 text-center py-8">
                  No products found
                </p>
              ) : (
                filteredProducts.map((product) => {
                  const isSelected = selectedIds.has(product.ProductID);
                  return (
                    <button
                      key={product.ProductID}
                      onClick={() => toggleProduct(product.ProductID)}
                      className={`w-full flex items-center gap-3 p-3 border-2 transition-all ${
                        isSelected
                          ? "border-doodle-accent bg-doodle-accent/10"
                          : "border-doodle-text/20 hover:border-doodle-text/40"
                      }`}
                    >
                      <div
                        className={`w-5 h-5 border-2 flex items-center justify-center transition-colors ${
                          isSelected
                            ? "border-doodle-accent bg-doodle-accent text-doodle-bg"
                            : "border-doodle-text/40"
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3" />}
                      </div>
                      <div className="flex-1 text-left">
                        <p className="font-doodle font-bold text-doodle-text text-sm">
                          {product.Name}
                        </p>
                        <p className="font-doodle text-xs text-doodle-text/50">
                          {product.ProductNumber} · $
                          {product.ListPrice.toFixed(2)}
                        </p>
                      </div>
                      {product.salePercent && (
                        <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-accent/20 text-doodle-accent border border-doodle-accent">
                          {product.salePercent}% off
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="border-t-2 border-doodle-text/20 pt-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="font-doodle"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="doodle-button doodle-button-primary"
          >
            Save ({selectedCount} products)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ProductAssignmentDialog;
