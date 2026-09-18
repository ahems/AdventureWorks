import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Star,
  X,
  Loader2,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getVerifiedReviewsSummary,
  startBatchVerifiedReviews,
  getVerifiedReviewsJobStatus,
  type VerifiedReviewsJobState,
  type VerifiedReviewsSummary,
} from "@/services/utilityService";

type Step = "configure" | "running" | "done";

const GenerateVerifiedReviewsWizardDialog: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("configure");

  // Summary (qualifying product count + max eligible customers per product)
  const [summary, setSummary] = useState<VerifiedReviewsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Slider values
  const [productCount, setProductCount] = useState(0); // 0 = all
  const [reviewsPerProduct, setReviewsPerProduct] = useState(1);

  // Running/done state
  const [jobState, setJobState] = useState<VerifiedReviewsJobState | null>(null);
  const [existingJobRunning, setExistingJobRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isStarting = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── helpers ─────────────────────────────────────────────────────────────

  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    setSummary(null);
    try {
      const s = await getVerifiedReviewsSummary();
      setSummary(s);
      setProductCount(s.qualifyingProductCount); // default: all
      setReviewsPerProduct(1);                   // default: 1 per product
    } catch (err) {
      setSummaryError(
        err instanceof Error ? err.message : "Failed to load summary",
      );
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const handleOpen = useCallback(async () => {
    setIsOpen(true);
    setStep("configure");
    setErrorMessage(null);
    try {
      const status = await getVerifiedReviewsJobStatus();
      if (status.isRunning) {
        setExistingJobRunning(true);
        setJobState(status);
      } else {
        setExistingJobRunning(false);
      }
    } catch {
      /* non-critical */
    }
    await fetchSummary();
  }, [fetchSummary]);

  const handleClose = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setIsOpen(false);
    setStep("configure");
    setSummary(null);
    setSummaryError(null);
    setJobState(null);
    setExistingJobRunning(false);
    setErrorMessage(null);
    isStarting.current = false;
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      try {
        const status = await getVerifiedReviewsJobStatus();
        setJobState(status);
        if (!status.isRunning) {
          clearInterval(pollTimer.current!);
          pollTimer.current = null;
          setStep("done");
        }
      } catch {
        /* ignore poll errors */
      }
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  const handleStart = useCallback(async () => {
    if (!summary || summary.qualifyingProductCount === 0 || isStarting.current)
      return;
    isStarting.current = true;
    setErrorMessage(null);
    setStep("running");
    try {
      const result = await startBatchVerifiedReviews(
        effectiveProductCount,
        effectiveReviewsPerProduct,
      );
      const initialState: VerifiedReviewsJobState = {
        isRunning: true,
        productId: 0,
        productName: "",
        processedCount: 0,
        totalCount: result.totalCount,
        productsProcessed: 0,
        productsTotal: result.productsTotal,
        startedAt: new Date().toISOString(),
        lastError: null,
      };
      setJobState(initialState);
      startPolling();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to start generation";
      setErrorMessage(msg);
      setStep("configure");
      isStarting.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, productCount, reviewsPerProduct, startPolling]);

  // ── derived values ───────────────────────────────────────────────────────

  const maxProducts = summary?.qualifyingProductCount ?? 0;
  const maxPerProduct = summary?.maxEligibleCustomersPerProduct ?? 0;
  const effectiveProductCount = Math.max(1, Math.min(productCount || maxProducts, maxProducts));
  const effectiveReviewsPerProduct = Math.max(1, Math.min(reviewsPerProduct, Math.max(1, maxPerProduct)));
  const isAllProducts = maxProducts > 0 && effectiveProductCount === maxProducts;

  const canStart =
    !summaryLoading &&
    !existingJobRunning &&
    summary !== null &&
    summary.qualifyingProductCount > 0;

  // ── card trigger (closed state) ──────────────────────────────────────────

  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className="doodle-card p-5 flex items-center gap-4 hover:shadow-md transition-shadow w-full text-left"
      >
        <Star className="w-8 h-8 text-doodle-accent shrink-0" />
        <div>
          <p className="font-doodle font-semibold text-doodle-text">
            Generate Verified Reviews
          </p>
          <p className="font-doodle text-sm text-doodle-text/60">
            AI reviews from real customers who received a delivery
          </p>
        </div>
      </button>
    );
  }

  // ── modal ────────────────────────────────────────────────────────────────

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-doodle-bg border-2 border-doodle-text rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b-2 border-doodle-text">
          <div className="flex items-center gap-3">
            <Star className="w-6 h-6 text-doodle-accent" />
            <h2 className="font-doodle text-xl font-bold text-doodle-text">
              Generate Verified Reviews
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="text-doodle-text/50 hover:text-doodle-text transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">

          {/* ── Configure step ── */}
          {step === "configure" && (
            <>
              {/* Description */}
              <div className="p-3 bg-doodle-blue/10 border-2 border-doodle-blue/30 rounded-xl">
                <p className="font-doodle text-sm text-doodle-text leading-relaxed">
                  This feature generates AI-written product reviews using real
                  customer identities. Only customers who received a{" "}
                  <strong>Delivered</strong> order for a product and have{" "}
                  <strong>not yet reviewed</strong> it are eligible. Each review
                  is posted under the customer&apos;s real name and email, with
                  AI-generated staff replies added to a random selection.
                </p>
              </div>

              {/* Running guard banner */}
              {existingJobRunning && jobState && (() => {
                const lastActivity = jobState.lastProgressAt ?? jobState.startedAt;
                const minutesSinceActivity = lastActivity
                  ? (Date.now() - new Date(lastActivity).getTime()) / 60_000
                  : null;
                const appearsStuck = minutesSinceActivity !== null && minutesSinceActivity > 10;
                return (
                  <div className={`flex items-start gap-3 p-3 border-2 rounded-xl ${
                    appearsStuck
                      ? "bg-red-50 border-red-300"
                      : "bg-doodle-yellow/20 border-doodle-yellow"
                  }`}>
                    <AlertTriangle className={`w-5 h-5 shrink-0 mt-0.5 ${
                      appearsStuck ? "text-red-500" : "text-doodle-yellow"
                    }`} />
                    <div className="font-doodle text-sm text-doodle-text">
                      <p className="font-semibold">
                        {appearsStuck ? "Job appears stuck" : "Generation already in progress"}
                      </p>
                      <p className="text-doodle-text/70 mt-0.5">
                        {jobState.productsTotal > 1
                          ? `${jobState.productsProcessed}/${jobState.productsTotal} products done — `
                          : ""}
                        {jobState.processedCount}/{jobState.totalCount} reviews.
                        {appearsStuck
                          ? ` No progress for ${Math.round(minutesSinceActivity!)} min.`
                          : " Wait for it to finish before starting a new one."}
                      </p>
                      {appearsStuck && (
                        <button
                          onClick={async () => {
                            // Calling GET /status triggers the backend auto-reset for orphaned jobs
                            try {
                              const fresh = await getVerifiedReviewsJobStatus();
                              if (!fresh.isRunning) {
                                setExistingJobRunning(false);
                                setJobState(null);
                              } else {
                                setJobState(fresh);
                              }
                            } catch { /* ignore */ }
                          }}
                          className="mt-2 text-xs underline text-red-600 hover:no-underline"
                        >
                          Check again &amp; clear if resolved
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Error banner */}
              {errorMessage && (
                <div className="flex items-start gap-3 p-3 bg-red-100 border-2 border-red-400 rounded-xl">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <p className="font-doodle text-sm text-red-700">{errorMessage}</p>
                </div>
              )}

              {/* Summary loading skeleton */}
              {summaryLoading && (
                <div className="space-y-3">
                  {/* callout placeholder */}
                  <Skeleton className="h-12 w-full rounded-xl" />
                  {/* products slider placeholder */}
                  <div className="space-y-1.5">
                    <Skeleton className="h-3 w-48" />
                    <Skeleton className="h-4 w-full rounded" />
                    <div className="flex justify-between">
                      <Skeleton className="h-2.5 w-4" />
                      <Skeleton className="h-2.5 w-16" />
                    </div>
                  </div>
                  {/* reviews-per-product placeholder */}
                  <div className="space-y-1.5">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-4 w-full rounded" />
                    <Skeleton className="h-2.5 w-64" />
                  </div>
                  {/* summary line placeholder */}
                  <Skeleton className="h-3 w-3/4" />
                </div>
              )}

              {/* Summary error */}
              {summaryError && !summaryLoading && (
                <div className="flex items-center gap-2 text-red-600 font-doodle text-sm">
                  <AlertCircle className="w-4 h-4" />
                  {summaryError}
                  <button
                    onClick={fetchSummary}
                    className="underline ml-1 text-doodle-blue hover:no-underline"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Controls — only shown once summary loaded */}
              {summary && !summaryLoading && (
                <>
                  {summary.qualifyingProductCount === 0 ? (
                    <div className="flex items-center gap-2 text-doodle-text/60 font-doodle text-sm p-3 border-2 border-doodle-text/20 rounded-xl">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      No qualifying products found. Every customer who made a
                      delivered purchase has already reviewed their product, or
                      no delivered orders exist yet.
                    </div>
                  ) : (
                    <>
                      {/* Qualifying count callout */}
                      <div className="p-3 bg-doodle-green/10 border-2 border-doodle-green/30 rounded-xl">
                        <p className="font-doodle text-sm text-doodle-text">
                          <strong className="text-doodle-green">
                            {summary.qualifyingProductCount.toLocaleString()}
                          </strong>{" "}
                          {summary.qualifyingProductCount === 1 ? "product has" : "products have"}{" "}
                          customers who purchased and received a delivery but
                          haven&apos;t yet written a review.
                        </p>
                        {summary.topProductId > 0 && summary.topProductName && (
                          <p className="font-doodle text-xs text-doodle-text/50 mt-1.5">
                            Most eligible:{" "}
                            <a
                              href={`/product/${summary.topProductId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-doodle-text/60 hover:text-doodle-green underline underline-offset-2 transition-colors"
                            >
                              {summary.topProductName}
                            </a>
                            {" "}({summary.maxEligibleCustomersPerProduct.toLocaleString()} eligible customers)
                          </p>
                        )}
                      </div>

                      {/* ── How many products? ── */}
                      <div>
                        <label className="font-doodle text-sm font-semibold text-doodle-text block mb-1">
                          Products to add reviews to:{" "}
                          <span className="text-doodle-green">
                            {isAllProducts
                              ? `all ${maxProducts.toLocaleString()}`
                              : effectiveProductCount.toLocaleString()}
                          </span>
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={Math.max(1, maxProducts)}
                          value={effectiveProductCount}
                          onChange={(e) => setProductCount(Number(e.target.value))}
                          className="w-full accent-doodle-green"
                          disabled={existingJobRunning}
                        />
                        <div className="flex justify-between font-doodle text-xs text-doodle-text/50 mt-0.5">
                          <span>1</span>
                          <span>all ({maxProducts.toLocaleString()})</span>
                        </div>
                      </div>

                      {/* ── Reviews per product ── */}
                      <div className={maxPerProduct <= 1 ? "opacity-40 pointer-events-none select-none" : ""}>
                        <label className="font-doodle text-sm font-semibold text-doodle-text block mb-1">
                          Reviews per product:{" "}
                          <span className={maxPerProduct > 1 ? "text-doodle-accent" : "text-doodle-text/40"}>
                            {maxPerProduct <= 1 ? "1 (only 1 eligible customer per product)" : effectiveReviewsPerProduct}
                          </span>
                        </label>
                        {maxPerProduct > 1 ? (
                          <>
                            <input
                              type="range"
                              min={1}
                              max={maxPerProduct}
                              value={effectiveReviewsPerProduct}
                              onChange={(e) => setReviewsPerProduct(Number(e.target.value))}
                              className="w-full accent-doodle-accent"
                              disabled={existingJobRunning}
                            />
                            <div className="flex justify-between font-doodle text-xs text-doodle-text/50 mt-0.5">
                              <span>1 (default — avoids over-reviewing)</span>
                              <span>{maxPerProduct.toLocaleString()} (most eligible for any product)</span>
                            </div>
                            <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                              Defaulting to 1 prevents any single heavily-purchased product
                              getting a disproportionate number of AI reviews. The backend
                              randomly selects customers from each product&apos;s eligible pool.
                            </p>
                          </>
                        ) : (
                          <p className="font-doodle text-xs text-doodle-text/40 italic mt-1">
                            All qualifying products have only 1 eligible unreviewed customer —
                            no selection needed.
                          </p>
                        )}
                      </div>

                      {/* Summary line */}
                      <p className="font-doodle text-xs text-doodle-text/60 border-t border-doodle-text/10 pt-3">
                        This will generate up to{" "}
                        <strong>
                          {(effectiveProductCount * effectiveReviewsPerProduct).toLocaleString()}
                        </strong>{" "}
                        {effectiveProductCount * effectiveReviewsPerProduct === 1 ? "review" : "reviews"}{" "}
                        across{" "}
                        <strong>
                          {isAllProducts ? `all ${maxProducts.toLocaleString()}` : effectiveProductCount.toLocaleString()}
                        </strong>{" "}
                        {effectiveProductCount === 1 ? "product" : "products"}.
                      </p>
                    </>
                  )}
                </>
              )}

              {/* Start button */}
              <button
                onClick={handleStart}
                disabled={!canStart}
                className="doodle-button doodle-button-primary w-full disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-x-0 disabled:translate-y-0"
              >
                {summaryLoading
                  ? "Loading…"
                  : existingJobRunning
                    ? "Job already running — please wait"
                    : canStart
                      ? `Start — ${effectiveProductCount} product${effectiveProductCount !== 1 ? "s" : ""}, ${effectiveReviewsPerProduct} review${effectiveReviewsPerProduct !== 1 ? "s" : ""} each`
                      : "No qualifying products"}
              </button>
            </>
          )}

          {/* ── Running step ── */}
          {step === "running" && jobState && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-doodle-accent" />
                <div>
                  <p className="font-doodle font-semibold text-doodle-text">
                    Generating verified reviews…
                  </p>
                  {jobState.productName && (
                    <p className="font-doodle text-xs text-doodle-text/60 mt-0.5">
                      Currently:{" "}
                      <span className="text-doodle-accent">{jobState.productName}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* Products progress */}
              {jobState.productsTotal > 1 && (
                <p className="font-doodle text-xs text-doodle-text/70">
                  Products completed:{" "}
                  <strong>{jobState.productsProcessed}/{jobState.productsTotal}</strong>
                </p>
              )}

              {/* Reviews progress bar */}
              <div>
                <div className="flex justify-between font-doodle text-xs text-doodle-text/60 mb-1">
                  <span>{jobState.processedCount} / {jobState.totalCount} reviews</span>
                  <span>
                    {jobState.totalCount > 0
                      ? Math.round((jobState.processedCount / jobState.totalCount) * 100)
                      : 0}%
                  </span>
                </div>
                <div className="w-full bg-doodle-text/10 rounded-full h-3 border border-doodle-text/20 overflow-hidden">
                  <div
                    className="h-full bg-doodle-accent rounded-full transition-all duration-500"
                    style={{
                      width: `${jobState.totalCount > 0 ? (jobState.processedCount / jobState.totalCount) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>

              <p className="font-doodle text-xs text-doodle-text/50">
                The AI is writing reviews from each customer&apos;s perspective
                using their real identity. Staff replies are added to a random
                selection. This may take several minutes for large batches.
              </p>

              {jobState.lastError && (
                <div className="flex items-start gap-2 p-2 bg-red-50 border border-red-300 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="font-doodle text-xs text-red-600">
                    Last error: {jobState.lastError}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── Done step ── */}
          {step === "done" && jobState && (
            <div className="space-y-4 text-center">
              <CheckCircle className="w-14 h-14 text-doodle-green mx-auto" />
              <div>
                <p className="font-doodle text-lg font-bold text-doodle-text">Done!</p>
                <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                  Generated{" "}
                  <strong>{jobState.processedCount.toLocaleString()}</strong>{" "}
                  verified {jobState.processedCount === 1 ? "review" : "reviews"}{" "}
                  across{" "}
                  <strong>{jobState.productsTotal.toLocaleString()}</strong>{" "}
                  {jobState.productsTotal === 1 ? "product" : "products"} using
                  real customer identities from delivered orders.
                </p>
              </div>

              {jobState.lastError && (
                <div className="flex items-start gap-2 p-2 bg-yellow-50 border border-yellow-300 rounded-lg text-left">
                  <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
                  <p className="font-doodle text-xs text-yellow-700">
                    Some reviews may have failed: {jobState.lastError}
                  </p>
                </div>
              )}

              <div className="flex gap-3 justify-center pt-2">
                <a
                  href="/reviews"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl border-2 border-doodle-text font-doodle text-sm text-doodle-text hover:bg-doodle-text/5 transition-colors"
                >
                  View Reviews
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button
                  onClick={handleClose}
                  className="doodle-button doodle-button-primary"
                >
                  Close
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};

export default GenerateVerifiedReviewsWizardDialog;
