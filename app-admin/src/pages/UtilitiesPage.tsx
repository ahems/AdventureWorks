import React, { useState } from "react";
import { Link } from "react-router-dom";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import UtilityFunctionCard from "@/components/UtilityFunctionCard";
import UtilityDashboard from "@/components/UtilityDashboard";
import {
  ThumbsUp,
  BarChart3,
  TrendingUp,
  Archive,
  Bot,
  ExternalLink,
  FolderOpen,
  Globe,
  DollarSign,
  ShoppingBag,
  Users,
  Package,
  Tag,
  FolderPlus,
} from "lucide-react";
import {
  generateProductEmbeddings,
  generateReviewEmbeddings,
  generateProductReviews,
  archiveTransactions,
  JobResponse,
} from "@/services/utilityService";
import { RecentExecution } from "@/components/UtilityDashboard";
import { toast } from "sonner";
import { buildInspectorUrl, getApiMcpUrl, getDabMcpUrl } from "@/lib/utils";

const UtilitiesPage: React.FC = () => {
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>(
    [],
  );

  const trackExecution = (
    name: string,
    status: RecentExecution["status"] = "running",
  ) => {
    setRecentExecutions((prev) => [
      { name, time: new Date().toISOString(), status },
      ...prev.slice(0, 9),
    ]);
  };

  return (
    <div className="min-h-screen bg-doodle-bg">
      <AdminHeader />

      <main className="container mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="mb-6">
          <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-2">
            Utilities
          </h1>
          <p className="font-doodle text-doodle-text/70">
            AI operations, tools, and reference data management
          </p>
        </div>

        {/* Dashboard Overview */}
        <UtilityDashboard recentExecutions={recentExecutions} />

        {/* AI Operations */}
        <h2 className="font-doodle text-xl font-semibold text-doodle-text mb-4 mt-8">
          AI Operations
        </h2>
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
          <UtilityFunctionCard
            title="Archive Transactions"
            description="Move TransactionHistory records older than 1 year into TransactionHistoryArchive. Runs automatically every Sunday at 02:00 UTC; use this button to trigger manually."
            icon={<Archive className="w-6 h-6" />}
            infoBadge="Weekly auto-run"
            onExecute={async (): Promise<JobResponse> => {
              toast.info("Starting transaction archive job\u2026");
              trackExecution("Archive Transactions");
              const result = await archiveTransactions();
              toast.success(`Archived ${result.recordsArchived} record(s).`);
              return {
                id: `archive-${Date.now()}`,
                statusQueryGetUri: null,
                terminatePostUri: null,
              };
            }}
            actionLabel="Archive Now"
          />
        </div>

        {/* AI Generators */}
        <h3 className="font-doodle text-lg font-semibold text-doodle-text mb-3 mt-6">
          AI Generators
        </h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Link
            to="/generate-order"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <ShoppingBag className="w-8 h-8 text-doodle-purple shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Generate Orders
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Create realistic AI-generated orders using persona profiles
              </p>
            </div>
          </Link>
          <Link
            to="/customers"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <Users className="w-8 h-8 text-doodle-blue shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Generate Customer
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Generate synthetic customers with realistic AI profiles
              </p>
            </div>
          </Link>
          <Link
            to="/products"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <Package className="w-8 h-8 text-doodle-green shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Generate Products
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                AI product content, images and translations wizard
              </p>
            </div>
          </Link>
          <Link
            to="/promotions"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <Tag className="w-8 h-8 text-doodle-orange shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Generate Promotion
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                AI-powered promotional campaign generation wizard
              </p>
            </div>
          </Link>
          <Link
            to="/categories"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <FolderPlus className="w-8 h-8 text-doodle-yellow shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Generate Categories
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                AI-generated product categories and subcategories
              </p>
            </div>
          </Link>
        </div>

        {/* Tools & Inspectors */}
        <h2 className="font-doodle text-xl font-semibold text-doodle-text mb-4 mt-8">
          Tools &amp; Inspectors
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Link
            to="/stale-carts"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <Bot className="w-8 h-8 text-doodle-purple shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Smart Cart Recovery
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Manage abandoned cart recovery campaigns
              </p>
            </div>
          </Link>
          <a
            href={buildInspectorUrl(getApiMcpUrl())}
            target="_blank"
            rel="noopener noreferrer"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <ExternalLink className="w-8 h-8 text-doodle-blue shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                MCP Inspector – AdventureWorks
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Inspect the AdventureWorks MCP server tools
              </p>
            </div>
          </a>
          <a
            href={buildInspectorUrl(getDabMcpUrl())}
            target="_blank"
            rel="noopener noreferrer"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <ExternalLink className="w-8 h-8 text-doodle-blue shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                MCP Inspector – DAB Data API
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Inspect the Data API Builder MCP server
              </p>
            </div>
          </a>
        </div>

        {/* Reference Data */}
        <h2 className="font-doodle text-xl font-semibold text-doodle-text mb-4 mt-8">
          Reference Data
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Link
            to="/categories"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <FolderOpen className="w-8 h-8 text-doodle-orange shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Categories
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Manage product category hierarchy
              </p>
            </div>
          </Link>
          <Link
            to="/cultures"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <Globe className="w-8 h-8 text-doodle-green shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Cultures
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Manage localization languages
              </p>
            </div>
          </Link>
          <Link
            to="/currencies"
            className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow"
          >
            <DollarSign className="w-8 h-8 text-doodle-yellow shrink-0" />
            <div>
              <p className="font-doodle font-semibold text-doodle-text">
                Currencies
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Manage currencies and exchange rates
              </p>
            </div>
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default UtilitiesPage;
