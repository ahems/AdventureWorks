import React, { useState, useCallback, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLanguage } from "@/context/LanguageContext";
import { useCurrency } from "@/context/CurrencyContext";
import { useAuth } from "@/context/AuthContext";
import { useUnitMeasure } from "@/context/UnitMeasureContext";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ExternalLink,
  RotateCcw,
  Wand2,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getWizardQuestions,
  getRecommendations,
  getCatalogMeta,
  type WizardQuestion,
  type WizardAnswer,
  type ProductRecommendation,
  type CatalogMeta,
} from "@/lib/helpMeService";
import { graphqlClient } from "@/lib/graphql-client";
import {
  GET_PRODUCT_PHOTOS_BATCH,
  GET_PHOTOS_BY_IDS,
} from "@/lib/graphql-queries";
import { trackError, trackEvent, trackPageView } from "@/lib/appInsights";

// ---------------------------------------------------------------------------
// Height bands — mapped to standard bike frame sizes
// ---------------------------------------------------------------------------

const HEIGHT_BANDS = [
  {
    label_cm: "Under 155 cm",
    label_imperial: "Under 5'1\"",
    sizeHint: "XS / 38",
  },
  {
    label_cm: "155 – 165 cm",
    label_imperial: "5'1\" – 5'5\"",
    sizeHint: "S / 38–42",
  },
  {
    label_cm: "165 – 175 cm",
    label_imperial: "5'5\" – 5'9\"",
    sizeHint: "M / 42–46",
  },
  {
    label_cm: "175 – 183 cm",
    label_imperial: "5'9\" – 6'0\"",
    sizeHint: "L / 46–50",
  },
  {
    label_cm: "183 – 193 cm",
    label_imperial: "6'0\" – 6'4\"",
    sizeHint: "XL / 50–54",
  },
  {
    label_cm: "Over 193 cm",
    label_imperial: "Over 6'4\"",
    sizeHint: "XL / 54+",
  },
] as const;

// Known AdventureWorks product colours — used immediately while (or if) the
// live API fetch is in-flight or fails, so chips always render.
const FALLBACK_COLORS = [
  "Black",
  "Blue",
  "Grey",
  "Multi",
  "Red",
  "Silver",
  "Silver/Black",
  "White",
  "Yellow",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step =
  | "intro"
  | "profile"
  | "loading-questions"
  | "questions"
  | "loading-recs"
  | "results"
  | "error";

interface EnrichedRecommendation extends ProductRecommendation {
  thumbBase64?: string | null;
}

interface PhotoMapping {
  ProductID: number;
  ProductPhotoID: number;
}
interface PhotoData {
  ProductPhotoID: number;
  ThumbNailPhoto: string | null;
}

// ---------------------------------------------------------------------------
// Helpers — batch photo fetch for recommendation results
// ---------------------------------------------------------------------------

const fetchThumbnailsForProducts = async (
  productIds: number[],
): Promise<Map<number, string | null>> => {
  const result = new Map<number, string | null>();
  if (productIds.length === 0) return result;

  try {
    // Step 1: get ProductPhotoID for each product (primary photos only)
    const mappingData = await graphqlClient.request<{
      productProductPhotos: { items: PhotoMapping[] };
    }>(GET_PRODUCT_PHOTOS_BATCH, { productIds });

    const mappings = mappingData.productProductPhotos.items;
    if (mappings.length === 0) return result;

    const photoIds = mappings.map((m) => m.ProductPhotoID);

    // Step 2: fetch thumbnail base64 data
    const photoData = await graphqlClient.request<{
      productPhotos: { items: PhotoData[] };
    }>(GET_PHOTOS_BY_IDS, { photoIds });

    const photoMap = new Map<number, string | null>();
    photoData.productPhotos.items.forEach((p) => {
      photoMap.set(p.ProductPhotoID, p.ThumbNailPhoto);
    });

    mappings.forEach((m) => {
      result.set(m.ProductID, photoMap.get(m.ProductPhotoID) ?? null);
    });
  } catch {
    // Non-fatal — photos just won't show
  }
  return result;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const HelpMeChoosePage: React.FC = () => {
  const { t } = useTranslation("helpme");
  const { selectedLanguage } = useLanguage();
  const { formatPrice } = useCurrency();
  const { user, isAuthenticated } = useAuth();
  const { unitSystem } = useUnitMeasure();
  const navigate = useNavigate();

  // Wizard state
  const [step, setStep] = useState<Step>("intro");
  const [questions, setQuestions] = useState<WizardQuestion[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswer[]>([]);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [enrichedRecs, setEnrichedRecs] = useState<EnrichedRecommendation[]>(
    [],
  );
  const [summary, setSummary] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Profile state
  const [gender, setGender] = useState<string>("");
  const [heightLabel, setHeightLabel] = useState<string>("");
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  // Seed with fallback colours immediately so chips always render.
  // Live data from the API will overwrite this when it arrives.
  const [catalogMeta, setCatalogMeta] = useState<CatalogMeta>({
    colors: FALLBACK_COLORS,
    bikeSizes: [],
  });
  const catalogFetchedRef = useRef(false);

  // App Insights page tracking
  useEffect(() => {
    trackPageView("HelpMeChoose", { authenticated: String(isAuthenticated) });
  }, [isAuthenticated]);

  // Fetch live catalog meta on mount; fallback colours stay until this resolves.
  useEffect(() => {
    if (catalogFetchedRef.current) return;
    catalogFetchedRef.current = true;
    getCatalogMeta()
      .then((meta) => {
        if (meta.colors.length > 0) setCatalogMeta(meta);
        // If API returns empty for any reason keep the fallback colours
      })
      .catch(() => {
        /* keep the fallback colours already in state */
      });
  }, []);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    setStep("intro");
    setQuestions([]);
    setSessionId("");
    setCurrentQuestionIndex(0);
    setAnswers([]);
    setSelectedOption(null);
    setEnrichedRecs([]);
    setSummary("");
    setErrorMsg("");
    setGender("");
    setHeightLabel("");
    setSelectedColors([]);
  }, []);

  const progressPercent =
    step === "questions"
      ? ((currentQuestionIndex + 1) / Math.max(questions.length, 1)) * 100
      : step === "loading-recs" || step === "results"
        ? 100
        : 0;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const startWizard = useCallback(() => {
    setStep("profile");
  }, []);

  const handleProfileContinue = useCallback(async () => {
    setStep("loading-questions");
    trackEvent("HelpMeChoose.ProfileCompleted", {
      hasGender: String(!!(gender || isAuthenticated)),
      hasHeight: String(!!heightLabel),
      colorCount: String(selectedColors.length),
      isAuthenticated: String(isAuthenticated),
    });
    try {
      const res = await getWizardQuestions(undefined, selectedLanguage);
      setQuestions(res.questions);
      setSessionId(res.sessionId);
      setCurrentQuestionIndex(0);
      setAnswers([]);
      setSelectedOption(null);
      setStep("questions");
    } catch (err) {
      trackError("HelpMeChoosePage loadQuestions", err);
      setErrorMsg(t("error.loadQuestions"));
      setStep("error");
    }
  }, [
    selectedLanguage,
    gender,
    heightLabel,
    selectedColors,
    isAuthenticated,
    t,
  ]);

  const handleOptionSelect = (option: string) => {
    setSelectedOption(option);
  };

  const handleNext = useCallback(async () => {
    if (!selectedOption) return;

    const currentQuestion = questions[currentQuestionIndex];
    const newAnswers: WizardAnswer[] = [
      ...answers,
      {
        questionId: currentQuestion.id,
        question: currentQuestion.text,
        answer: selectedOption,
      },
    ];
    setAnswers(newAnswers);
    setSelectedOption(null);

    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((i) => i + 1);
    } else {
      setStep("loading-recs");
      try {
        const res = await getRecommendations(
          newAnswers,
          sessionId,
          selectedLanguage,
          isAuthenticated ? (user?.firstName ?? undefined) : undefined,
          gender || undefined,
          heightLabel || undefined,
          selectedColors.length > 0 ? selectedColors : undefined,
          isAuthenticated ? user?.businessEntityId : undefined,
        );

        // Enrich with photos
        const productIds = res.recommendations.map((r) => r.productId);
        const thumbMap = await fetchThumbnailsForProducts(productIds);

        const enriched: EnrichedRecommendation[] = res.recommendations.map(
          (r) => ({
            ...r,
            thumbBase64: thumbMap.get(r.productId) ?? null,
          }),
        );

        setEnrichedRecs(enriched);
        setSummary(res.summary);

        trackEvent("HelpMeChoose.ResultsViewed", {
          sessionId,
          recommendationCount: String(enriched.length),
          searchTerms: res.searchTermsUsed.join(", "),
        });

        setStep("results");
      } catch (err) {
        trackError("HelpMeChoosePage getRecommendations", err);
        setErrorMsg(t("error.loadRecommendations"));
        setStep("error");
      }
    }
  }, [
    selectedOption,
    questions,
    currentQuestionIndex,
    answers,
    sessionId,
    selectedLanguage,
    isAuthenticated,
    user,
    gender,
    heightLabel,
    selectedColors,
    t,
  ]);

  const handleBack = () => {
    if (currentQuestionIndex > 0) {
      const prevIndex = currentQuestionIndex - 1;
      setCurrentQuestionIndex(prevIndex);
      const prevAnswer = answers[prevIndex];
      setSelectedOption(prevAnswer?.answer ?? null);
      setAnswers((prev) => prev.slice(0, prevIndex));
    }
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderIntro = () => (
    <div className="flex flex-col items-center text-center gap-8 py-12">
      <div className="w-24 h-24 rounded-full bg-doodle-accent/10 flex items-center justify-center doodle-border-light">
        <span className="text-5xl">🚴</span>
      </div>
      <div className="max-w-lg">
        <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-4">
          {t("intro.title")}
        </h1>
        <p className="font-doodle text-doodle-text/70 leading-relaxed text-lg">
          {t("intro.description")}
        </p>
      </div>
      <Button
        onClick={startWizard}
        className="doodle-button doodle-button-primary gap-2 text-lg px-8 py-3"
      >
        <Wand2 className="w-5 h-5" />
        {t("intro.cta")}
      </Button>
      <p className="font-doodle text-sm text-doodle-text/50">
        {t("intro.hint")}
      </p>
    </div>
  );

  const renderProfile = () => (
    <div className="flex flex-col gap-6 max-w-xl mx-auto">
      <div className="text-center">
        <span className="text-4xl mb-3 block">🎯</span>
        <h2 className="font-doodle text-2xl font-bold text-doodle-text">
          {t("profile.title")}
        </h2>
        <p className="font-doodle text-doodle-text/60 mt-1">
          {t("profile.subtitle")}
        </p>
      </div>

      {/* Gender — always shown */}
      <div className="space-y-3">
        <p className="font-doodle text-sm font-semibold text-doodle-text">
          {t("profile.gender.label")}
        </p>
        <div className="flex gap-3 flex-wrap">
          {(["Male", "Female", "Prefer not to say"] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setGender((g) => (g === opt ? "" : opt))}
              className={cn(
                "font-doodle px-4 py-2 rounded-lg text-sm border-2 transition-all",
                gender === opt
                  ? "border-doodle-accent bg-doodle-accent/10 font-semibold text-doodle-text"
                  : "border-doodle-border/40 bg-doodle-bg text-doodle-text/70 hover:border-doodle-accent/50",
              )}
            >
              {opt === "Male"
                ? t("profile.gender.male")
                : opt === "Female"
                  ? t("profile.gender.female")
                  : t("profile.gender.preferNotToSay")}
            </button>
          ))}
        </div>
      </div>

      {/* Height */}
      <div className="space-y-3">
        <p className="font-doodle text-sm font-semibold text-doodle-text">
          🚴 {t("profile.height.label")}
        </p>
        <Select value={heightLabel} onValueChange={setHeightLabel}>
          <SelectTrigger className="font-doodle doodle-border-light bg-doodle-bg w-full">
            <SelectValue placeholder={t("profile.height.placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {HEIGHT_BANDS.map((band) => {
              const display =
                unitSystem === "metric" ? band.label_cm : band.label_imperial;
              const value = `${display} (frame sizes: ${band.sizeHint})`;
              return (
                <SelectItem
                  key={band.sizeHint}
                  value={value}
                  className="font-doodle"
                >
                  {display}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Colours */}
      <div className="space-y-3">
        <p className="font-doodle text-sm font-semibold text-doodle-text">
          🎨 {t("profile.colors.label")}
        </p>
        <div className="flex flex-wrap gap-2">
          {catalogMeta.colors.map((color) => (
            <button
              key={color}
              onClick={() =>
                setSelectedColors((prev) =>
                  prev.includes(color)
                    ? prev.filter((c) => c !== color)
                    : [...prev, color],
                )
              }
              className={cn(
                "font-doodle px-4 py-2 rounded-lg text-sm border-2 transition-all",
                selectedColors.includes(color)
                  ? "border-doodle-accent bg-doodle-accent/10 font-semibold text-doodle-text"
                  : "border-doodle-border/40 bg-doodle-bg text-doodle-text/70 hover:border-doodle-accent/50",
              )}
            >
              {color}
            </button>
          ))}
        </div>
        <p className="font-doodle text-xs text-doodle-text/50">
          {t("profile.colors.hint")}
        </p>
      </div>

      <div className="flex justify-between items-center pt-2">
        <Button
          variant="ghost"
          onClick={reset}
          className="font-doodle gap-1 text-doodle-text/60"
        >
          <ChevronLeft className="w-4 h-4" />
          {t("nav.back")}
        </Button>
        <Button
          onClick={handleProfileContinue}
          className="doodle-button doodle-button-primary gap-2"
        >
          {t("profile.continue")}
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );

  const renderLoadingQuestions = () => (
    <div className="flex flex-col items-center gap-6 py-16">
      <Loader2 className="w-12 h-12 text-doodle-accent animate-spin" />
      <p className="font-doodle text-doodle-text/70 animate-pulse text-lg">
        {t("loading.questions")}
      </p>
    </div>
  );

  const renderQuestion = () => {
    const q = questions[currentQuestionIndex];
    if (!q) return null;

    return (
      <div className="flex flex-col gap-6 max-w-xl mx-auto">
        {/* Progress */}
        <div className="space-y-2">
          <div className="flex justify-between font-doodle text-sm text-doodle-text/50">
            <span>
              {t("progress.question", {
                current: currentQuestionIndex + 1,
                total: questions.length,
              })}
            </span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <Progress value={progressPercent} className="h-2" />
        </div>

        {/* Question */}
        <div className="text-center py-4">
          <span className="text-5xl mb-4 block">{q.icon}</span>
          <h2 className="font-doodle text-2xl font-bold text-doodle-text leading-snug">
            {q.text}
          </h2>
        </div>

        {/* Options — 2×2 grid */}
        <div className="grid grid-cols-2 gap-4">
          {q.options.map((option) => (
            <button
              key={option}
              onClick={() => handleOptionSelect(option)}
              className={cn(
                "font-doodle p-4 rounded-lg text-sm text-left transition-all duration-150 border-2",
                "hover:border-doodle-accent hover:bg-doodle-accent/5",
                selectedOption === option
                  ? "border-doodle-accent bg-doodle-accent/10 font-semibold text-doodle-text shadow-sm"
                  : "border-doodle-border/40 bg-doodle-bg text-doodle-text/80",
              )}
            >
              {option}
            </button>
          ))}
        </div>

        {/* Navigation */}
        <div className="flex justify-between pt-2">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={currentQuestionIndex === 0}
            className="font-doodle gap-1 text-doodle-text/60"
          >
            <ChevronLeft className="w-4 h-4" />
            {t("nav.back")}
          </Button>
          <Button
            onClick={handleNext}
            disabled={!selectedOption}
            className="doodle-button doodle-button-primary gap-1"
          >
            {currentQuestionIndex === questions.length - 1
              ? t("nav.findProducts")
              : t("nav.next")}
            {currentQuestionIndex < questions.length - 1 ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    );
  };

  const renderLoadingRecs = () => (
    <div className="flex flex-col items-center gap-6 py-16">
      <div className="relative">
        <Loader2 className="w-12 h-12 text-doodle-accent animate-spin" />
        <Sparkles className="w-5 h-5 text-doodle-green absolute -top-1 -right-1 animate-bounce" />
      </div>
      <p className="font-doodle text-doodle-text/70 animate-pulse text-center max-w-sm text-lg">
        {t("loading.recommendations")}
      </p>
    </div>
  );

  const renderResults = () => (
    <div className="flex flex-col gap-8">
      {/* Breadcrumb */}
      <Button
        variant="ghost"
        onClick={reset}
        className="font-doodle gap-1 text-doodle-text/60 self-start -ml-2"
      >
        <ArrowLeft className="w-4 h-4" />
        {t("results.startAgain")}
      </Button>

      {/* AI summary banner */}
      <div className="doodle-card p-6 bg-doodle-accent/5 doodle-border-light">
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-doodle-accent mt-0.5 flex-shrink-0" />
          <p className="font-doodle text-base text-doodle-text leading-relaxed">
            {summary}
          </p>
        </div>
      </div>

      {/* Results grid */}
      {enrichedRecs.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {enrichedRecs.map((rec) => (
            <div
              key={rec.productId}
              className="doodle-card doodle-border-light flex flex-col hover:border-doodle-accent/60 transition-colors overflow-hidden"
            >
              {/* Thumbnail */}
              <div className="w-full aspect-square bg-doodle-bg border-b border-doodle-border/30 flex items-center justify-center overflow-hidden">
                {rec.thumbBase64 ? (
                  <img
                    src={`data:image/jpeg;base64,${rec.thumbBase64}`}
                    alt={rec.productName}
                    className="w-full h-full object-contain p-3"
                  />
                ) : (
                  <span className="text-5xl opacity-20">🚴</span>
                )}
              </div>

              {/* Content */}
              <div className="p-5 flex flex-col flex-1 gap-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-doodle font-bold text-doodle-text text-base leading-tight flex-1">
                    {rec.productName}
                  </h3>
                  {rec.price != null && (
                    <span className="font-doodle font-bold text-doodle-green text-base flex-shrink-0">
                      {formatPrice(rec.price)}
                    </span>
                  )}
                </div>

                {rec.category && (
                  <Badge
                    variant="secondary"
                    className="font-doodle text-xs w-fit"
                  >
                    {rec.category}
                  </Badge>
                )}

                {/* AI personalised reason */}
                <div className="flex items-start gap-2 mt-1">
                  <Sparkles className="w-3.5 h-3.5 text-doodle-accent mt-0.5 flex-shrink-0" />
                  <p className="font-doodle text-sm text-doodle-text/70 leading-relaxed">
                    {rec.reason}
                  </p>
                </div>

                <div className="mt-auto pt-3">
                  <Button
                    className="doodle-button doodle-button-primary w-full gap-2 text-sm"
                    onClick={() => navigate(`/product/${rec.productId}`)}
                  >
                    <ExternalLink className="w-4 h-4" />
                    {t("results.viewProduct")}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 font-doodle text-doodle-text/60">
          <span className="text-5xl mb-4 block">🔍</span>
          <p className="text-lg">{t("results.noResults")}</p>
        </div>
      )}
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center gap-6 py-16 text-center">
      <span className="text-5xl">😔</span>
      <p className="font-doodle text-doodle-text/70 text-lg">{errorMsg}</p>
      <Button onClick={reset} className="doodle-button gap-2">
        <RotateCcw className="w-4 h-4" />
        {t("error.tryAgain")}
      </Button>
    </div>
  );

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  const isWideLayout = step === "results";

  return (
    <div className="min-h-screen flex flex-col bg-doodle-bg">
      <Header />

      <main className="flex-1">
        {/* Page header bar */}
        <div className="border-b border-doodle-border/30 bg-doodle-bg/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="container mx-auto px-4 py-3 flex items-center gap-3">
            <Link
              to="/"
              className="font-doodle text-sm text-doodle-text/60 hover:text-doodle-text flex items-center gap-1 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Home
            </Link>
            <span className="text-doodle-border/50">/</span>
            <span className="font-doodle text-sm text-doodle-text flex items-center gap-1.5">
              <Wand2 className="w-4 h-4 text-doodle-accent" />
              {t("title")}
            </span>
          </div>
        </div>

        {/* Content */}
        <div
          className={cn(
            "container mx-auto px-4 py-10",
            isWideLayout ? "max-w-7xl" : "max-w-2xl",
          )}
        >
          {step === "intro" && renderIntro()}
          {step === "profile" && renderProfile()}
          {step === "loading-questions" && renderLoadingQuestions()}
          {step === "questions" && renderQuestion()}
          {step === "loading-recs" && renderLoadingRecs()}
          {step === "results" && renderResults()}
          {step === "error" && renderError()}
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default HelpMeChoosePage;
