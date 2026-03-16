import React, { useState } from "react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import UtilityFunctionCard from "@/components/UtilityFunctionCard";
import UtilityDashboard from "@/components/UtilityDashboard";
import {
  Sparkles,
  Search as SearchIcon,
  Languages,
  Image,
  MessageSquare,
  Wand2,
  Database,
  FileText,
  ImagePlus,
  Star,
  TrendingUp,
  BarChart3,
  ThumbsUp,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  embellishProductDescriptions,
  generateProductEmbeddings,
  generateReviewEmbeddings,
  translateProductDescriptions,
  translateLanguageFile,
  generateProductImages,
  generateProductReviews,
  supportedLanguages,
  JobResponse,
} from "@/services/utilityService";
import { RecentExecution } from "@/components/UtilityDashboard";
import { toast } from "sonner";

const categories = [
  { id: "ai-analysis", name: "AI Analysis", icon: TrendingUp },
  { id: "product-ai", name: "Product AI Enhancement", icon: Sparkles },
  { id: "embeddings", name: "Embeddings & Search", icon: Database },
  { id: "translations", name: "Translations", icon: Languages },
  { id: "images", name: "Images & Media", icon: Image },
  { id: "reviews", name: "Reviews & Content", icon: MessageSquare },
];

const UtilitiesPage: React.FC = () => {
  const [activeCategory, setActiveCategory] = useState("ai-analysis");
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>(
    [],
  );

  // Form states
  const [processAllProducts, setProcessAllProducts] = useState(true);
  const [productIds, setProductIds] = useState("");
  const [translationMode, setTranslationMode] = useState("recent");
  const [productModelIds, setProductModelIds] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("es");
  const [languageFileContent, setLanguageFileContent] = useState("");
  const [processAllImages, setProcessAllImages] = useState(true);
  const [imageProductIds, setImageProductIds] = useState("");
  const [generateAllReviews, setGenerateAllReviews] = useState(true);
  const [reviewProductIds, setReviewProductIds] = useState("");
  const [reviewsPerProduct, setReviewsPerProduct] = useState<
    number | undefined
  >(undefined);

  const trackExecution = (
    name: string,
    status: RecentExecution["status"] = "running",
  ) => {
    setRecentExecutions((prev) => [
      { name, time: new Date().toISOString(), status },
      ...prev.slice(0, 9),
    ]);
  };

  const parseProductIds = (input: string): number[] | undefined => {
    if (!input.trim()) return undefined;
    return input
      .split(",")
      .map((id) => parseInt(id.trim()))
      .filter((id) => !isNaN(id));
  };

  const handleEmbellish = async () => {
    const ids = processAllProducts ? undefined : parseProductIds(productIds);
    toast.info("Starting product description enhancement...");
    trackExecution("Embellish Product Descriptions");
    return embellishProductDescriptions(ids);
  };

  const handleProductEmbeddings = async () => {
    toast.info("Starting product embeddings generation...");
    trackExecution("Generate Product Embeddings");
    return generateProductEmbeddings();
  };

  const handleReviewEmbeddings = async () => {
    toast.info("Starting review embeddings generation...");
    trackExecution("Generate Review Embeddings");
    return generateReviewEmbeddings();
  };

  const handleTranslateDescriptions = async () => {
    const ids =
      translationMode === "specific"
        ? parseProductIds(productModelIds)
        : undefined;
    toast.info("Starting product description translations...");
    trackExecution("Translate Product Descriptions");
    return translateProductDescriptions(ids);
  };

  const handleTranslateLanguageFile = async (): Promise<JobResponse> => {
    if (!languageFileContent.trim()) {
      toast.error("Please provide language file content");
      throw new Error("No content provided");
    }
    let parsedData: object;
    try {
      parsedData = JSON.parse(languageFileContent);
    } catch {
      toast.error("Invalid JSON — please check the language file content");
      throw new Error("Invalid JSON");
    }
    toast.info(`Starting translation to ${targetLanguage}...`);
    trackExecution(`Translate Language File → ${targetLanguage}`);
    return translateLanguageFile(targetLanguage, parsedData);
  };

  const handleGenerateImages = async () => {
    const ids = processAllImages ? undefined : parseProductIds(imageProductIds);
    toast.info("Starting AI image generation...");
    trackExecution("Generate Product Images");
    return generateProductImages(ids);
  };

  const handleGenerateReviews = async () => {
    const ids = generateAllReviews
      ? undefined
      : parseProductIds(reviewProductIds);
    toast.info("Starting AI review generation...");
    trackExecution("Generate Product Reviews");
    return generateProductReviews(ids, reviewsPerProduct);
  };

  const renderCategoryContent = () => {
    switch (activeCategory) {
      case "ai-analysis":
        return (
          <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
            <UtilityFunctionCard
              title="Run Review AI Analysis"
              description="Analyze all reviews using AI to detect sentiment, generate response suggestions, and flag potential issues"
              icon={<ThumbsUp className="w-6 h-6" />}
              onExecute={async (): Promise<JobResponse> => {
                toast.info("Starting AI review analysis...");
                trackExecution("Run Review AI Analysis");
                return generateProductReviews();
              }}
              actionLabel="Analyze Reviews"
            />

            <UtilityFunctionCard
              title="Product Success Analysis"
              description="AI-powered analysis of product success metrics including views, cart additions, abandonments, purchases, and review sentiment"
              icon={<BarChart3 className="w-6 h-6" />}
              infoBadge="Comprehensive metrics"
              onExecute={async (): Promise<JobResponse> => {
                toast.info("Starting product success analysis...");
                trackExecution("Product Success Analysis");
                return generateProductEmbeddings();
              }}
              actionLabel="Run Analysis"
            />

            <UtilityFunctionCard
              title="AI Review Summary"
              description="Generate executive summary of review trends, sentiment distribution, and key recommendations across all products"
              icon={<TrendingUp className="w-6 h-6" />}
              onExecute={async (): Promise<JobResponse> => {
                toast.info("Generating AI review summary...");
                trackExecution("AI Review Summary");
                return generateReviewEmbeddings();
              }}
              actionLabel="Generate Summary"
            />
          </div>
        );

      case "product-ai":
        return (
          <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
            <UtilityFunctionCard
              title="Embellish Product Descriptions"
              description="Use AI to enhance product descriptions with more engaging and detailed content"
              icon={<Wand2 className="w-6 h-6" />}
              onExecute={handleEmbellish}
              actionLabel="Start Enhancement"
            >
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="processAll"
                    checked={processAllProducts}
                    onCheckedChange={(checked) =>
                      setProcessAllProducts(checked as boolean)
                    }
                  />
                  <Label htmlFor="processAll" className="font-doodle">
                    Process all products
                  </Label>
                </div>
                {!processAllProducts && (
                  <div>
                    <Label htmlFor="productIds" className="font-doodle text-sm">
                      Product IDs (comma-separated)
                    </Label>
                    <Textarea
                      id="productIds"
                      value={productIds}
                      onChange={(e) => setProductIds(e.target.value)}
                      placeholder="1, 2, 3, 4"
                      className="mt-1 font-mono text-sm"
                    />
                  </div>
                )}
              </div>
            </UtilityFunctionCard>
          </div>
        );

      case "embeddings":
        return (
          <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
            <UtilityFunctionCard
              title="Generate Product Embeddings"
              description="Generate vector embeddings for product descriptions to enable AI-powered semantic search. Includes product variants (colors, sizes, styles)."
              icon={<SearchIcon className="w-6 h-6" />}
              infoBadge="~5-10 minutes for full catalog"
              onExecute={handleProductEmbeddings}
              actionLabel="Generate Embeddings"
            />

            <UtilityFunctionCard
              title="Generate Review Embeddings"
              description="Generate vector embeddings for product review comments to enable semantic search of customer feedback"
              icon={<Star className="w-6 h-6" />}
              onExecute={handleReviewEmbeddings}
              actionLabel="Generate Review Embeddings"
            />
          </div>
        );

      case "translations":
        return (
          <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
            <UtilityFunctionCard
              title="Translate Product Descriptions"
              description="Translate product descriptions to all supported languages. By default, processes recently enhanced products."
              icon={<Languages className="w-6 h-6" />}
              onExecute={handleTranslateDescriptions}
              actionLabel="Start Translation"
            >
              <div className="space-y-4">
                <RadioGroup
                  value={translationMode}
                  onValueChange={setTranslationMode}
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="recent" id="recent" />
                    <Label htmlFor="recent" className="font-doodle">
                      Recently enhanced products
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="specific" id="specific" />
                    <Label htmlFor="specific" className="font-doodle">
                      Specific product model IDs
                    </Label>
                  </div>
                </RadioGroup>
                {translationMode === "specific" && (
                  <div>
                    <Label htmlFor="modelIds" className="font-doodle text-sm">
                      Product Model IDs (comma-separated)
                    </Label>
                    <Textarea
                      id="modelIds"
                      value={productModelIds}
                      onChange={(e) => setProductModelIds(e.target.value)}
                      placeholder="1, 2, 3, 4"
                      className="mt-1 font-mono text-sm"
                    />
                  </div>
                )}
                <div>
                  <Label className="font-doodle text-sm">
                    Supported Languages
                  </Label>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {supportedLanguages.slice(0, 8).map((lang) => (
                      <Badge
                        key={lang.code}
                        variant="outline"
                        className="text-xs"
                      >
                        {lang.name}
                      </Badge>
                    ))}
                    <Badge variant="outline" className="text-xs">
                      +{supportedLanguages.length - 8} more
                    </Badge>
                  </div>
                </div>
              </div>
            </UtilityFunctionCard>

            <UtilityFunctionCard
              title="Translate Language File"
              description="Translate frontend i18n language files from English to multiple languages"
              icon={<FileText className="w-6 h-6" />}
              onExecute={handleTranslateLanguageFile}
              actionLabel="Translate File"
            >
              <div className="space-y-4">
                <div>
                  <Label htmlFor="targetLang" className="font-doodle text-sm">
                    Target Language
                  </Label>
                  <Select
                    value={targetLanguage}
                    onValueChange={setTargetLanguage}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {supportedLanguages.map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>
                          {lang.name} ({lang.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="langContent" className="font-doodle text-sm">
                    Source JSON Content
                  </Label>
                  <Textarea
                    id="langContent"
                    value={languageFileContent}
                    onChange={(e) => setLanguageFileContent(e.target.value)}
                    placeholder='{"greeting": "Hello", "farewell": "Goodbye"}'
                    className="mt-1 font-mono text-sm h-24"
                  />
                </div>
              </div>
            </UtilityFunctionCard>
          </div>
        );

      case "images":
        return (
          <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
            <UtilityFunctionCard
              title="Generate Product Images"
              description="Generate AI-created product images using DALL-E. Images are automatically added to the product catalog."
              icon={<ImagePlus className="w-6 h-6" />}
              warningBadge="Uses Azure OpenAI credits"
              onExecute={handleGenerateImages}
              actionLabel="Generate Images"
            >
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="processAllImages"
                    checked={processAllImages}
                    onCheckedChange={(checked) =>
                      setProcessAllImages(checked as boolean)
                    }
                  />
                  <Label htmlFor="processAllImages" className="font-doodle">
                    Process all products without images
                  </Label>
                </div>
                {!processAllImages && (
                  <div>
                    <Label
                      htmlFor="imageProductIds"
                      className="font-doodle text-sm"
                    >
                      Product IDs (comma-separated)
                    </Label>
                    <Textarea
                      id="imageProductIds"
                      value={imageProductIds}
                      onChange={(e) => setImageProductIds(e.target.value)}
                      placeholder="1, 2, 3, 4"
                      className="mt-1 font-mono text-sm"
                    />
                  </div>
                )}
              </div>
            </UtilityFunctionCard>
          </div>
        );

      case "reviews":
        return (
          <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
            <UtilityFunctionCard
              title="Generate Product Reviews"
              description="Generate realistic AI-created product reviews with varied sentiment (positive, neutral, negative). Creates 0-10 reviews per product."
              icon={<MessageSquare className="w-6 h-6" />}
              warningBadge="Adds data to database"
              onExecute={handleGenerateReviews}
              actionLabel="Generate Reviews"
            >
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="generateAllReviews"
                    checked={generateAllReviews}
                    onCheckedChange={(checked) =>
                      setGenerateAllReviews(checked as boolean)
                    }
                  />
                  <Label htmlFor="generateAllReviews" className="font-doodle">
                    Generate for all products
                  </Label>
                </div>
                {!generateAllReviews && (
                  <div>
                    <Label
                      htmlFor="reviewProductIds"
                      className="font-doodle text-sm"
                    >
                      Product IDs (comma-separated)
                    </Label>
                    <Textarea
                      id="reviewProductIds"
                      value={reviewProductIds}
                      onChange={(e) => setReviewProductIds(e.target.value)}
                      placeholder="1, 2, 3, 4"
                      className="mt-1 font-mono text-sm"
                    />
                  </div>
                )}
                <div>
                  <Label
                    htmlFor="reviewsPerProduct"
                    className="font-doodle text-sm"
                  >
                    Reviews per product (leave empty for random 0-10)
                  </Label>
                  <Input
                    id="reviewsPerProduct"
                    type="number"
                    min="0"
                    max="20"
                    value={reviewsPerProduct ?? ""}
                    onChange={(e) =>
                      setReviewsPerProduct(
                        e.target.value ? parseInt(e.target.value) : undefined,
                      )
                    }
                    placeholder="Random (0-10)"
                    className="mt-1"
                  />
                </div>
              </div>
            </UtilityFunctionCard>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-doodle-bg">
      <AdminHeader />

      <main className="container mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="mb-6">
          <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-2">
            AI-Powered Utilities
          </h1>
          <p className="font-doodle text-doodle-text/70">
            Trigger AI-powered operations and maintenance tasks
          </p>
        </div>

        {/* Dashboard Overview */}
        <UtilityDashboard recentExecutions={recentExecutions} />

        <div className="flex flex-col md:flex-row gap-6">
          {/* Sidebar Navigation */}
          <aside className="md:w-64 shrink-0">
            <nav className="doodle-card p-4 sticky top-24">
              <h2 className="font-doodle font-bold text-sm text-muted-foreground uppercase tracking-wide mb-4">
                Categories
              </h2>
              <ul className="space-y-1">
                {categories.map((category) => {
                  const Icon = category.icon;
                  return (
                    <li key={category.id}>
                      <button
                        onClick={() => setActiveCategory(category.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-doodle text-left transition-colors ${
                          activeCategory === category.id
                            ? "bg-primary/10 text-primary font-bold"
                            : "text-foreground hover:bg-muted"
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                        {category.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </aside>

          {/* Main Content */}
          <div className="flex-1">
            <div className="mb-6">
              <h2 className="font-doodle text-xl font-bold text-foreground flex items-center gap-2">
                {categories.find((c) => c.id === activeCategory)?.icon &&
                  React.createElement(
                    categories.find((c) => c.id === activeCategory)!.icon,
                    { className: "w-5 h-5" },
                  )}
                {categories.find((c) => c.id === activeCategory)?.name}
              </h2>
            </div>

            {renderCategoryContent()}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default UtilitiesPage;
