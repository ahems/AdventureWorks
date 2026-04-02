import React, { useState } from "react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import UtilityFunctionCard from "@/components/UtilityFunctionCard";
import UtilityDashboard from "@/components/UtilityDashboard";
import { ThumbsUp, BarChart3, TrendingUp } from "lucide-react";
import {
  generateProductEmbeddings,
  generateReviewEmbeddings,
  generateProductReviews,
  JobResponse,
} from "@/services/utilityService";
import { RecentExecution } from "@/components/UtilityDashboard";
import { toast } from "sonner";

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
            AI-Powered Utilities
          </h1>
          <p className="font-doodle text-doodle-text/70">
            Trigger AI-powered operations and maintenance tasks
          </p>
        </div>

        {/* Dashboard Overview */}
        <UtilityDashboard recentExecutions={recentExecutions} />

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
      </main>

      <Footer />
    </div>
  );
};

export default UtilitiesPage;
