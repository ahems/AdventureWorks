import React, { useState, useEffect } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { ArrowLeft, Star, Save, Tag } from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import ProductImageGallery from "@/components/ProductImageGallery";
import AiImageGeneratorDialog from "@/components/AiImageGeneratorDialog";
import { useAuth } from "@/context/AuthContext";
import {
  useAdminProductById,
  useAdminCategoryById,
  useAdminAllSubcategories,
} from "@/hooks/useAdminProducts";
import { useAdminSpecialOffers } from "@/hooks/useAdminPromotions";
import { useReviews } from "@/hooks/useReviews";
import { toast } from "@/hooks/use-toast";
import { getOfferStatus } from "@/types/promotion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ProductPage: React.FC = () => {
  const { productId } = useParams<{ productId: string }>();
  const { isAuthenticated } = useAuth();
  const prodIdNum = productId ? parseInt(productId) : 0;
  const { data: product, isLoading: productLoading } =
    useAdminProductById(prodIdNum);
  const subcatId = product?.ProductSubcategoryID ?? 0;
  const { data: allSubcategories = [] } = useAdminAllSubcategories();
  const catIdNum = React.useMemo(
    () =>
      allSubcategories.find((s) => s.ProductSubcategoryID === subcatId)
        ?.ProductCategoryID ?? 0,
    [allSubcategories, subcatId],
  );
  const { data: category } = useAdminCategoryById(catIdNum);
  const { averageRating, reviewCount } = useReviews(prodIdNum);
  const { data: promotions = [] } = useAdminSpecialOffers();

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPromotionId, setSelectedPromotionId] =
    useState<string>("none");

  // Sync form state when product loads
  useEffect(() => {
    if (product) {
      setName(product.Name);
      setPrice(product.ListPrice.toString());
      setDescription(product.Description || "");
    }
  }, [product]);

  // Filter to only show active and upcoming promotions (exclude "No Discount")
  const availablePromotions = promotions.filter((p) => {
    const status = getOfferStatus(p);
    return (
      p.SpecialOfferID !== 1 && (status === "active" || status === "upcoming")
    );
  });

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (productLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <AdminHeader />
        <main className="flex-1 container mx-auto px-4 py-12 text-center">
          <span className="font-doodle text-doodle-text/60">
            Loading product...
          </span>
        </main>
        <Footer />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="min-h-screen flex flex-col">
        <AdminHeader />
        <main className="flex-1 container mx-auto px-4 py-12 text-center">
          <span className="text-6xl block mb-4">🔍</span>
          <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
            Product Not Found
          </h1>
          <Link to="/" className="doodle-button doodle-button-primary">
            Back to Dashboard
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  const handleSave = () => {
    toast({
      title: "Product Updated",
      description: `${name} has been saved successfully.`,
    });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-4">
              <ProductImageGallery
                productId={product.ProductID}
                productName={product.Name}
                color={product.Color}
              />
              <AiImageGeneratorDialog
                productId={product.ProductID}
                productName={product.Name}
              />
            </div>

            <div className="space-y-6">
              <div className="doodle-card p-6">
                <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4">
                  Edit Product
                </h2>

                <div className="space-y-4">
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      Product Name
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="doodle-input w-full"
                    />
                  </div>

                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      SKU
                    </label>
                    <input
                      type="text"
                      value={product.ProductNumber}
                      disabled
                      className="doodle-input w-full bg-doodle-text/5"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        List Price ($)
                      </label>
                      <input
                        type="number"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        className="doodle-input w-full"
                      />
                    </div>
                    <div>
                      <label className="font-doodle text-sm text-doodle-text block mb-1">
                        Promotion (optional)
                      </label>
                      <Select
                        value={selectedPromotionId}
                        onValueChange={setSelectedPromotionId}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="No promotion" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            <span className="flex items-center gap-2">
                              No promotion
                            </span>
                          </SelectItem>
                          {availablePromotions.map((promo) => {
                            const status = getOfferStatus(promo);
                            return (
                              <SelectItem
                                key={promo.SpecialOfferID}
                                value={promo.SpecialOfferID.toString()}
                              >
                                <span className="flex items-center gap-2">
                                  <Tag className="w-3 h-3" />
                                  {promo.Description} (
                                  {(promo.DiscountPct * 100).toFixed(0)}% off)
                                  {status === "upcoming" && (
                                    <span className="text-xs text-muted-foreground">
                                      (upcoming)
                                    </span>
                                  )}
                                </span>
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {selectedPromotionId !== "none" && (
                    <div className="bg-doodle-accent/10 border border-doodle-accent/30 rounded-lg p-3">
                      {(() => {
                        const promo = availablePromotions.find(
                          (p) =>
                            p.SpecialOfferID.toString() === selectedPromotionId,
                        );
                        if (!promo) return null;
                        const status = getOfferStatus(promo);
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Tag className="w-4 h-4 text-doodle-accent" />
                              <span className="font-doodle font-bold text-doodle-text">
                                {promo.Description}
                              </span>
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full ${
                                  status === "active"
                                    ? "bg-green-500/20 text-green-700"
                                    : "bg-yellow-500/20 text-yellow-700"
                                }`}
                              >
                                {status}
                              </span>
                            </div>
                            <p className="text-sm text-doodle-text/70">
                              {promo.Type} •{" "}
                              {(promo.DiscountPct * 100).toFixed(0)}% discount
                              {promo.MinQty > 0 &&
                                ` • Min qty: ${promo.MinQty}`}
                              {promo.MaxQty && ` • Max qty: ${promo.MaxQty}`}
                            </p>
                            <p className="text-xs text-doodle-text/50">
                              Valid:{" "}
                              {new Date(promo.StartDate).toLocaleDateString()} -{" "}
                              {new Date(promo.EndDate).toLocaleDateString()}
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      Description
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={4}
                      className="doodle-input w-full"
                    />
                  </div>

                  <button
                    onClick={handleSave}
                    className="doodle-button doodle-button-primary w-full py-3 flex items-center justify-center gap-2"
                  >
                    <Save className="w-5 h-5" /> Save Changes
                  </button>
                </div>
              </div>

              <div className="doodle-card p-4">
                <h3 className="font-doodle font-bold text-doodle-text mb-2">
                  Product Stats
                </h3>
                <div className="flex items-center gap-2">
                  <div className="flex">
                    {[...Array(5)].map((_, i) => (
                      <Star
                        key={i}
                        className={`w-4 h-4 ${i < Math.round(averageRating) ? "fill-doodle-accent text-doodle-accent" : "text-doodle-text/20"}`}
                      />
                    ))}
                  </div>
                  <span className="font-doodle text-sm text-doodle-text/60">
                    {averageRating.toFixed(1)} ({reviewCount} reviews)
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12">
          <Link
            to={category ? `/category/${category.ProductCategoryID}` : "/"}
            className="doodle-button inline-flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back to{" "}
            {category?.Name || "Dashboard"}
          </Link>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ProductPage;
