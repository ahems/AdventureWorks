import React, { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  FolderOpen,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Globe,
  Package,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  useAdminCategories,
  useAdminAllSubcategories,
  useAdminProductCountsBySubcategory,
} from "@/hooks/useAdminProducts";
import {
  createCategory,
  createSubcategory,
  deleteCategory as deleteCategoryApi,
  deleteSubcategory as deleteSubcategoryApi,
  translateCategoryName,
  CategoryTranslationPayload,
} from "@/services/utilityService";
import { toast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

// ─── Create Category Dialog ────────────────────────────────────────────────────

interface CreateCategoryDialogProps {
  onCreated: () => void;
}

const CreateCategoryDialog: React.FC<CreateCategoryDialogProps> = ({
  onCreated,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      const result = await createCategory(name.trim());
      if (!result.success) throw new Error(result.message ?? "Create failed");
      // Fire-and-forget translation
      const payload: CategoryTranslationPayload = {
        categoryId: result.categoryId!,
        englishName: name.trim(),
        type: "category",
      };
      translateCategoryName(payload).catch(() => {
        /* swallow — translation failure is non-blocking */
      });
      toast({
        title: "Category Created",
        description: `"${name.trim()}" was created and queued for translation.`,
      });
      setIsOpen(false);
      setName("");
      onCreated();
    } catch (err) {
      toast({
        title: "Create Failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
        data-testid="create-category-btn"
      >
        <Plus className="w-4 h-4" />
        Create Category
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="doodle-card w-full max-w-md p-6">
            <h2 className="font-doodle text-xl font-bold text-doodle-text mb-5">
              Create New Category
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="font-doodle text-sm text-doodle-text flex items-center gap-2 mb-1">
                  Category Name *
                  <span
                    className="inline-flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded"
                    data-testid="us-english-badge"
                  >
                    <Globe className="w-3 h-3" /> US English
                  </span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={50}
                  className="doodle-input w-full"
                  placeholder="e.g. Accessories"
                />
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isSaving}
                  className="doodle-button flex-1 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="doodle-button doodle-button-primary flex-1 py-2 disabled:opacity-60"
                >
                  {isSaving ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

// ─── Create Subcategory Dialog ─────────────────────────────────────────────────

interface CreateSubcategoryDialogProps {
  categoryId: number;
  onCreated: () => void;
}

const CreateSubcategoryDialog: React.FC<CreateSubcategoryDialogProps> = ({
  categoryId,
  onCreated,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      const result = await createSubcategory(categoryId, name.trim());
      if (!result.success) throw new Error(result.message ?? "Create failed");
      const payload: CategoryTranslationPayload = {
        categoryId: result.subcategoryId!,
        englishName: name.trim(),
        type: "subcategory",
      };
      translateCategoryName(payload).catch(() => {});
      toast({
        title: "Subcategory Created",
        description: `"${name.trim()}" was created and queued for translation.`,
      });
      setIsOpen(false);
      setName("");
      onCreated();
    } catch (err) {
      toast({
        title: "Create Failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(true);
        }}
        className="doodle-button flex items-center gap-1 py-1 px-2 text-xs"
      >
        <Plus className="w-3 h-3" />
        Add
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="doodle-card w-full max-w-md p-6">
            <h2 className="font-doodle text-xl font-bold text-doodle-text mb-5">
              Create New Subcategory
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="font-doodle text-sm text-doodle-text flex items-center gap-2 mb-1">
                  Subcategory Name *
                  <span className="inline-flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                    <Globe className="w-3 h-3" /> US English
                  </span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={50}
                  className="doodle-input w-full"
                  placeholder="e.g. Road Bikes"
                />
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isSaving}
                  className="doodle-button flex-1 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="doodle-button doodle-button-primary flex-1 py-2 disabled:opacity-60"
                >
                  {isSaving ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

// ─── Main Page ─────────────────────────────────────────────────────────────────

const CategoriesPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(
    new Set(),
  );
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const { data: categories = [], isLoading: categoriesLoading } =
    useAdminCategories();
  const { data: allSubcategories = [], isLoading: subsLoading } =
    useAdminAllSubcategories();

  const allSubcategoryIds = useMemo(
    () => allSubcategories.map((s) => s.ProductSubcategoryID),
    [allSubcategories],
  );

  const { data: productCounts = new Map() } =
    useAdminProductCountsBySubcategory(allSubcategoryIds);

  const toggleCategory = (id: number) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "categories"] });
    queryClient.invalidateQueries({ queryKey: ["admin", "subcategories"] });
  };

  const handleDeleteCategory = async (categoryId: number, name: string) => {
    if (
      !window.confirm(
        `Delete category "${name}"?\n\nThis will permanently delete all culture variants.`,
      )
    )
      return;
    setDeletingId(categoryId);
    try {
      const result = await deleteCategoryApi(categoryId);
      if (!result.success) throw new Error(result.message ?? "Delete failed");
      toast({
        title: "Category Deleted",
        description: `"${name}" was deleted.`,
      });
      invalidate();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("409") || msg.toLowerCase().includes("subcategor")) {
        toast({
          title: "Cannot Delete",
          description:
            "Remove all subcategories before deleting this category.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Delete Failed",
          description: msg,
          variant: "destructive",
        });
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteSubcategory = async (
    subcategoryId: number,
    name: string,
  ) => {
    if (
      !window.confirm(
        `Delete subcategory "${name}"?\n\nThis will permanently delete all culture variants.`,
      )
    )
      return;
    setDeletingId(subcategoryId);
    try {
      const result = await deleteSubcategoryApi(subcategoryId);
      if (!result.success) throw new Error(result.message ?? "Delete failed");
      toast({
        title: "Subcategory Deleted",
        description: `"${name}" was deleted.`,
      });
      invalidate();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("409") || msg.toLowerCase().includes("product")) {
        toast({
          title: "Cannot Delete",
          description: "Move or delete all products in this subcategory first.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Delete Failed",
          description: msg,
          variant: "destructive",
        });
      }
    } finally {
      setDeletingId(null);
    }
  };

  const isLoading = categoriesLoading || subsLoading;

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-doodle-bg flex flex-col">
        <AdminHeader />
        <main className="flex-1 flex items-center justify-center">
          <p className="font-doodle text-doodle-text/60">
            Please log in to manage categories.
          </p>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-doodle-bg flex flex-col">
      <AdminHeader />

      <main className="flex-1 container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-2">
              <FolderOpen className="w-7 h-7" />
              Categories
            </h1>
            <p className="font-doodle text-doodle-text/60 mt-1">
              Manage product categories and subcategories
            </p>
          </div>
          <CreateCategoryDialog onCreated={invalidate} />
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="doodle-card p-8 text-center animate-pulse">
            <div className="h-5 bg-doodle-text/10 rounded-md w-1/3 mx-auto mb-4" />
            <div className="h-5 bg-doodle-text/10 rounded-md w-1/2 mx-auto mb-4" />
            <div className="h-5 bg-doodle-text/10 rounded-md w-2/5 mx-auto" />
          </div>
        ) : categories.length === 0 ? (
          <div className="text-center py-16">
            <FolderOpen className="w-12 h-12 text-doodle-text/30 mx-auto mb-3" />
            <p className="font-doodle text-doodle-text/60 text-lg">
              No categories found.
            </p>
          </div>
        ) : (
          <div
            className="doodle-card overflow-hidden"
            data-testid="categories-table"
          >
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-doodle-text border-dashed">
                  <th className="font-doodle text-sm text-left px-4 py-3 text-doodle-text/70">
                    Category
                  </th>
                  <th className="font-doodle text-sm text-center px-4 py-3 text-doodle-text/70 hidden sm:table-cell">
                    Subcategories
                  </th>
                  <th className="font-doodle text-sm text-center px-4 py-3 text-doodle-text/70 hidden sm:table-cell">
                    Products
                  </th>
                  <th className="font-doodle text-sm text-right px-4 py-3 text-doodle-text/70">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => {
                  const subs = allSubcategories.filter(
                    (s) => s.ProductCategoryID === cat.ProductCategoryID,
                  );
                  const totalProducts = subs.reduce(
                    (sum, s) =>
                      sum + (productCounts.get(s.ProductSubcategoryID) ?? 0),
                    0,
                  );
                  const isExpanded = expandedCategories.has(
                    cat.ProductCategoryID,
                  );

                  return (
                    <React.Fragment key={cat.ProductCategoryID}>
                      {/* Category row */}
                      <tr
                        className="border-b border-doodle-text/20 hover:bg-doodle-text/5 cursor-pointer transition-colors"
                        onClick={() => toggleCategory(cat.ProductCategoryID)}
                        data-testid={`category-row-${cat.ProductCategoryID}`}
                      >
                        <td className="px-4 py-3">
                          <span className="font-doodle font-semibold text-doodle-text flex items-center gap-2">
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4 text-doodle-text/40" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-doodle-text/40" />
                            )}
                            {cat.Name}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center font-doodle text-doodle-text/70 hidden sm:table-cell">
                          {subs.length}
                        </td>
                        <td className="px-4 py-3 text-center font-doodle text-doodle-text/70 hidden sm:table-cell">
                          <Link
                            to={`/category/${cat.ProductCategoryID}`}
                            onClick={(e) => e.stopPropagation()}
                            className="hover:text-doodle-accent transition-colors flex items-center gap-1 justify-center"
                          >
                            <Package className="w-3 h-3" />
                            {totalProducts}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteCategory(
                                cat.ProductCategoryID,
                                cat.Name,
                              );
                            }}
                            disabled={
                              deletingId === cat.ProductCategoryID ||
                              subs.length > 0
                            }
                            title={
                              subs.length > 0
                                ? "Remove all subcategories first"
                                : `Delete ${cat.Name}`
                            }
                            className="doodle-button text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                            data-testid={`delete-category-${cat.ProductCategoryID}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>

                      {/* Expanded subcategory rows */}
                      {isExpanded && (
                        <>
                          {subs.map((sub) => {
                            const subProductCount =
                              productCounts.get(sub.ProductSubcategoryID) ?? 0;
                            return (
                              <tr
                                key={sub.ProductSubcategoryID}
                                className="border-b border-doodle-text/10 bg-doodle-text/[0.02] hover:bg-doodle-text/5 transition-colors"
                                data-testid={`subcategory-row-${sub.ProductSubcategoryID}`}
                              >
                                <td className="px-4 py-2 pl-10">
                                  <span className="font-doodle text-sm text-doodle-text/80">
                                    {sub.Name}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-center hidden sm:table-cell" />
                                <td className="px-4 py-2 text-center font-doodle text-sm text-doodle-text/60 hidden sm:table-cell">
                                  <Link
                                    to={`/category/${cat.ProductCategoryID}`}
                                    className="hover:text-doodle-accent transition-colors flex items-center gap-1 justify-center"
                                  >
                                    <Package className="w-3 h-3" />
                                    {subProductCount}
                                  </Link>
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <button
                                    onClick={() =>
                                      handleDeleteSubcategory(
                                        sub.ProductSubcategoryID,
                                        sub.Name,
                                      )
                                    }
                                    disabled={
                                      deletingId === sub.ProductSubcategoryID ||
                                      subProductCount > 0
                                    }
                                    title={
                                      subProductCount > 0
                                        ? "Move or delete products first"
                                        : `Delete ${sub.Name}`
                                    }
                                    className="doodle-button text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                                    data-testid={`delete-subcategory-${sub.ProductSubcategoryID}`}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                          {/* Add subcategory row */}
                          <tr className="border-b border-doodle-text/10 bg-doodle-text/[0.02]">
                            <td className="px-4 py-2 pl-10" colSpan={4}>
                              <CreateSubcategoryDialog
                                categoryId={cat.ProductCategoryID}
                                onCreated={invalidate}
                              />
                            </td>
                          </tr>
                        </>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
};

export default CategoriesPage;
