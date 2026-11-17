import React, { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLanguage } from "@/context/LanguageContext";
import { useCurrency } from "@/context/CurrencyContext";
import { useAuth } from "@/context/AuthContext";
import { useUnitMeasure } from "@/context/UnitMeasureContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ExternalLink,
  RotateCcw,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getWizardQuestions,
  getRecommendations,
  getCatalogMeta,
  type WizardQuestion,
  type WizardAnswer,
  type ProductRecommendation,
  type CatalogMeta,
} from "@/lib/helpMeService";
import { trackError } from "@/lib/appInsights";

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

// ---------------------------------------------------------------------------
// Types & step definitions
// ---------------------------------------------------------------------------

type Step =
  | "intro"
  | "profile"
  | "loading-questions"
  | "questions"
  | "loading-recs"
  | "results"
  | "error";

interface HelpMeChooseWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const HelpMeChooseWizard: React.FC<HelpMeChooseWizardProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation("helpme");
  const { selectedLanguage } = useLanguage();
  const { formatPrice } = useCurrency();
  const { user, isAuthenticated } = useAuth();
  const { unitSystem } = useUnitMeasure();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>("intro");
  const [questions, setQuestions] = useState<WizardQuestion[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswer[]>([]);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<
    ProductRecommendation[]
  >([]);
  const [summary, setSummary] = useState<string>("");
  const [error, setError] = useState<string>("");

  // Profile step state
  const [gender, setGender] = useState<string>("");
  const [heightLabel, setHeightLabel] = useState<string>("");
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [catalogMeta, setCatalogMeta] = useState<CatalogMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const catalogFetchedRef = useRef(false);

  // Pre-fetch catalog meta as soon as the dialog opens
  useEffect(() => {
    if (!open || catalogFetchedRef.current) return;
    catalogFetchedRef.current = true;
    setMetaLoading(true);
    getCatalogMeta()
      .then(setCatalogMeta)
      .catch(() => setCatalogMeta({ colors: [], bikeSizes: [] }))
      .finally(() => setMetaLoading(false));
  }, [open]);

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
    setRecommendations([]);
    setSummary("");
    setError("");
    setGender("");
    setHeightLabel("");
    setSelectedColors([]);
  }, []);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) reset();
      onOpenChange(open);
    },
    [onOpenChange, reset],
  );

  const progressPercent =
    step === "questions"
      ? ((currentQuestionIndex + 1) / Math.max(questions.length, 1)) * 100
      : step === "loading-recs" || step === "results"
        ? 100
        : 0;

  // ---------------------------------------------------------------------------
  // Step: Show profile questions first
  // ---------------------------------------------------------------------------

  const startWizard = useCallback(() => {
    setStep("profile");
  }, []);

  // ---------------------------------------------------------------------------
  // Step: Profile done — load AI questions
  // ---------------------------------------------------------------------------

  const handleProfileContinue = useCallback(async () => {
    setStep("loading-questions");
    try {
      const res = await getWizardQuestions(undefined, selectedLanguage);
      setQuestions(res.questions);
      setSessionId(res.sessionId);
      setCurrentQuestionIndex(0);
      setAnswers([]);
      setSelectedOption(null);
      setStep("questions");
    } catch (err) {
      trackError("HelpMeChooseWizard loadQuestions", err);
      setError(t("error.loadQuestions"));
      setStep("error");
    }
  }, [selectedLanguage, t]);

  // ---------------------------------------------------------------------------
  // Step: Answer a question and advance
  // ---------------------------------------------------------------------------

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
      // All questions answered — get recommendations
      setStep("loading-recs");
      try {
        const res = await getRecommendations(
          newAnswers,
          sessionId,
          selectedLanguage,
          isAuthenticated ? (user?.firstName ?? undefined) : undefined,
          isAuthenticated ? undefined : gender || undefined,
          heightLabel || undefined,
          selectedColors.length > 0 ? selectedColors : undefined,
        );
        setRecommendations(res.recommendations);
        setSummary(res.summary);
        setStep("results");
      } catch (err) {
        trackError("HelpMeChooseWizard getRecommendations", err);
        setError(t("error.loadRecommendations"));
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
      // Restore the previous answer as the selected option
      const prevAnswer = answers[prevIndex];
      setSelectedOption(prevAnswer?.answer ?? null);
      setAnswers((prev) => prev.slice(0, prevIndex));
    }
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderIntro = () => (
    <div className="flex flex-col items-center text-center gap-6 py-4">
      <div className="w-20 h-20 rounded-full bg-doodle-accent/10 flex items-center justify-center doodle-border-light">
        <span className="text-4xl">🚴</span>
      </div>
      <div>
        <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-3">
          {t("intro.title")}
        </h2>
        <p className="font-doodle text-doodle-text/70 max-w-sm leading-relaxed">
          {t("intro.description")}
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs">
        <Button
          onClick={startWizard}
          className="doodle-button doodle-button-primary flex-1 gap-2"
        >
          <Wand2 className="w-4 h-4" />
          {t("intro.cta")}
        </Button>
      </div>
      <p className="font-doodle text-xs text-doodle-text/50">
        {t("intro.hint")}
      </p>
    </div>
  );

  const renderProfile = () => (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <span className="text-3xl mb-2 block">🎯</span>
        <h3 className="font-doodle text-lg font-bold text-doodle-text">
          {t("profile.title")}
        </h3>
        <p className="font-doodle text-sm text-doodle-text/60 mt-1">
          {t("profile.subtitle")}
        </p>
      </div>

      {/* Gender — anonymous shoppers only; logged-in users' name provides gender signal */}
      {!isAuthenticated && (
        <div className="space-y-2">
          <p className="font-doodle text-sm font-semibold text-doodle-text">
            {t("profile.gender.label")}
          </p>
          <div className="flex gap-2 flex-wrap">
            {(["Male", "Female", "Prefer not to say"] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setGender((g) => (g === opt ? "" : opt))}
                className={cn(
                  "font-doodle px-3 py-1.5 rounded-lg text-sm border-2 transition-all",
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
      )}

      {/* Height → bike frame size guide */}
      <div className="space-y-2">
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

      {/* Colour preference — populated from live DB data */}
      <div className="space-y-2">
        <p className="font-doodle text-sm font-semibold text-doodle-text">
          🎨 {t("profile.colors.label")}
        </p>
        {metaLoading ? (
          <div className="flex gap-2 flex-wrap">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-8 w-20 rounded-lg bg-doodle-border/30 animate-pulse"
              />
            ))}
          </div>
        ) : (catalogMeta?.colors ?? []).length > 0 ? (
          <>
            <div className="flex flex-wrap gap-2">
              {catalogMeta!.colors.map((color) => (
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
                    "font-doodle px-3 py-1.5 rounded-lg text-sm border-2 transition-all",
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
          </>
        ) : null}
      </div>

      {/* Continue */}
      <div className="flex justify-end pt-1">
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
    <div className="flex flex-col items-center gap-4 py-10">
      <Loader2 className="w-10 h-10 text-doodle-accent animate-spin" />
      <p className="font-doodle text-doodle-text/70 animate-pulse">
        {t("loading.questions")}
      </p>
    </div>
  );

  const renderQuestion = () => {
    const q = questions[currentQuestionIndex];
    if (!q) return null;

    return (
      <div className="flex flex-col gap-5">
        {/* Progress */}
        <div className="space-y-1">
          <div className="flex justify-between font-doodle text-xs text-doodle-text/50">
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
        <div className="text-center">
          <span className="text-3xl mb-3 block">{q.icon}</span>
          <h3 className="font-doodle text-lg font-bold text-doodle-text leading-snug">
            {q.text}
          </h3>
        </div>

        {/* Options */}
        <div className="grid grid-cols-2 gap-3">
          {q.options.map((option) => (
            <button
              key={option}
              onClick={() => handleOptionSelect(option)}
              className={cn(
                "font-doodle p-3 rounded-lg text-sm text-left transition-all duration-150 border-2",
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
            size="sm"
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
            {currentQuestionIndex < questions.length - 1 && (
              <ChevronRight className="w-4 h-4" />
            )}
            {currentQuestionIndex === questions.length - 1 && (
              <Sparkles className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    );
  };

  const renderLoadingRecs = () => (
    <div className="flex flex-col items-center gap-4 py-10">
      <div className="relative">
        <Loader2 className="w-10 h-10 text-doodle-accent animate-spin" />
        <Sparkles className="w-4 h-4 text-doodle-green absolute -top-1 -right-1 animate-bounce" />
      </div>
      <p className="font-doodle text-doodle-text/70 animate-pulse text-center max-w-xs">
        {t("loading.recommendations")}
      </p>
    </div>
  );

  const renderResults = () => (
    <div className="flex flex-col gap-4">
      {/* AI summary */}
      <div className="doodle-card p-4 bg-doodle-accent/5 doodle-border-light">
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-doodle-accent mt-0.5 flex-shrink-0" />
          <p className="font-doodle text-sm text-doodle-text leading-relaxed">
            {summary}
          </p>
        </div>
      </div>

      {/* Recommendations — no extra scroll wrapper; parent div handles scroll */}
      {recommendations.length > 0 ? (
        <div className="flex flex-col gap-3">
          {recommendations.map((rec) => (
            <div
              key={rec.productId}
              className="doodle-card p-4 doodle-border-light flex flex-col sm:flex-row gap-3 hover:border-doodle-accent/60 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="font-doodle font-bold text-doodle-text text-sm leading-tight">
                    {rec.productName}
                  </h4>
                  {rec.price != null && (
                    <span className="font-doodle font-bold text-doodle-green text-sm flex-shrink-0">
                      {formatPrice(rec.price)}
                    </span>
                  )}
                </div>
                {rec.category && (
                  <span className="font-doodle text-xs text-doodle-text/50 inline-block mb-1">
                    {rec.category}
                  </span>
                )}
                <p className="font-doodle text-xs text-doodle-text/70 leading-relaxed mt-1">
                  {rec.reason}
                </p>
              </div>
              <div className="flex-shrink-0 flex items-end sm:items-center">
                <Button
                  size="sm"
                  variant="outline"
                  className="font-doodle text-xs gap-1 doodle-border-light"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/product/${rec.productId}`);
                  }}
                >
                  <ExternalLink className="w-3 h-3" />
                  {t("results.viewProduct")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-6 font-doodle text-doodle-text/60">
          <p>{t("results.noResults")}</p>
        </div>
      )}

      {/* Reset button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={reset}
        className="font-doodle gap-1 text-doodle-text/60 self-center"
      >
        <RotateCcw className="w-3 h-3" />
        {t("results.startAgain")}
      </Button>
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <span className="text-4xl">😔</span>
      <p className="font-doodle text-doodle-text/70">{error}</p>
      <Button onClick={reset} className="doodle-button gap-2">
        <RotateCcw className="w-4 h-4" />
        {t("error.tryAgain")}
      </Button>
    </div>
  );

  const titleMap: Record<Step, string> = {
    intro: t("title"),
    profile: t("title"),
    "loading-questions": t("title"),
    questions: t("title"),
    "loading-recs": t("title"),
    results: t("results.title"),
    error: t("title"),
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-md flex flex-col max-h-[90vh] p-0 overflow-hidden"
        aria-describedby={undefined}
      >
        <div className="doodle-card doodle-border-light bg-doodle-bg rounded-sm flex flex-col min-h-0 flex-1">
          {/* Fixed header */}
          <div className="px-6 pt-6 pb-3 flex-shrink-0">
            <DialogHeader>
              <DialogTitle className="font-doodle text-lg text-doodle-text flex items-center gap-2">
                <Wand2 className="w-5 h-5 text-doodle-accent" />
                {titleMap[step]}
              </DialogTitle>
            </DialogHeader>
          </div>

          {/* Scrollable content area */}
          <div className="overflow-y-auto flex-1 px-6 pb-6 min-h-0">
            {step === "intro" && renderIntro()}
            {step === "profile" && renderProfile()}
            {step === "loading-questions" && renderLoadingQuestions()}
            {step === "questions" && renderQuestion()}
            {step === "loading-recs" && renderLoadingRecs()}
            {step === "results" && renderResults()}
            {step === "error" && renderError()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
