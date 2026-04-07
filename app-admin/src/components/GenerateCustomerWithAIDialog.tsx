import React, { useState } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles,
  X,
  Loader2,
  CheckCircle,
  AlertCircle,
  User,
  Globe,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import {
  generateCustomerWithAI,
  GenerateCustomerResult,
  supportedLanguages,
} from "@/services/utilityService";
import { useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

// Map locale codes to country flags / display labels including English base locales
const LOCALE_OPTIONS = [
  { code: "en", name: "English (US)", flag: "🇺🇸" },
  { code: "en-gb", name: "English (UK)", flag: "🇬🇧" },
  { code: "en-ca", name: "English (Canada)", flag: "🇨🇦" },
  { code: "en-au", name: "English (Australia)", flag: "🇦🇺" },
  { code: "en-nz", name: "English (New Zealand)", flag: "🇳🇿" },
  { code: "en-ie", name: "English (Ireland)", flag: "🇮🇪" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "de", name: "German", flag: "🇩🇪" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "pt", name: "Portuguese", flag: "🇵🇹" },
  { code: "it", name: "Italian", flag: "🇮🇹" },
  { code: "nl", name: "Dutch", flag: "🇳🇱" },
  { code: "ru", name: "Russian", flag: "🇷🇺" },
  { code: "zh", name: "Chinese (Simplified)", flag: "🇨🇳" },
  { code: "zh-cht", name: "Chinese (Traditional)", flag: "🇹🇼" },
  { code: "ja", name: "Japanese", flag: "🇯🇵" },
  { code: "ko", name: "Korean", flag: "🇰🇷" },
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "he", name: "Hebrew", flag: "🇮🇱" },
  { code: "tr", name: "Turkish", flag: "🇹🇷" },
  { code: "vi", name: "Vietnamese", flag: "🇻🇳" },
  { code: "th", name: "Thai", flag: "🇹🇭" },
  { code: "id", name: "Indonesian", flag: "🇮🇩" },
];

interface GenerateCustomerWithAIDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCustomerGenerated?: () => void;
}

const GenerateCustomerWithAIDialog: React.FC<
  GenerateCustomerWithAIDialogProps
> = ({ open, onOpenChange, onCustomerGenerated }) => {
  const queryClient = useQueryClient();
  const [locale, setLocale] = useState("en");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerateCustomerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setResult(null);
    setError(null);

    try {
      const res = await generateCustomerWithAI(locale);
      setResult(res);
      // Invalidate customer list cache so the new customer appears
      queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
      onCustomerGenerated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleClose = () => {
    if (isGenerating) return;
    setResult(null);
    setError(null);
    onOpenChange(false);
  };

  const selectedLocale = LOCALE_OPTIONS.find((l) => l.code === locale);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={handleClose}
        aria-hidden="true"
      />
      <div className="relative bg-white border-4 border-doodle-text shadow-[8px_8px_0_0_#1a1a1a] max-w-md w-full p-6 z-10 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-doodle text-xl font-bold text-doodle-text flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-doodle-accent" />
            Generate Customer with AI
          </h2>
          <button
            onClick={handleClose}
            disabled={isGenerating}
            className="p-1 hover:bg-doodle-text/10 rounded transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!result && !isGenerating && (
          <>
            <p className="font-doodle text-sm text-doodle-text/60 mb-6">
              AI will invent a realistic customer profile — name, email, phone
              and address — appropriate for the chosen locale, then create the
              record in the database.
            </p>

            {/* Locale picker */}
            <div className="mb-6">
              <label className="font-doodle text-sm font-bold text-doodle-text flex items-center gap-2 mb-2">
                <Globe className="w-4 h-4" />
                Locale / Language
              </label>
              <Select value={locale} onValueChange={setLocale}>
                <SelectTrigger className="w-full font-doodle">
                  <SelectValue>
                    {selectedLocale
                      ? `${selectedLocale.flag} ${selectedLocale.name}`
                      : "Select locale"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LOCALE_OPTIONS.map((opt) => (
                    <SelectItem
                      key={opt.code}
                      value={opt.code}
                      className="font-doodle"
                    >
                      {opt.flag} {opt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <button
              onClick={handleGenerate}
              className="w-full doodle-button doodle-button-primary flex items-center justify-center gap-2 py-3"
            >
              <Sparkles className="w-4 h-4" />
              Generate Customer
            </button>
          </>
        )}

        {/* Generating state */}
        {isGenerating && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="w-10 h-10 text-doodle-accent animate-spin" />
            <p className="font-doodle text-doodle-text/70">
              AI is inventing a{" "}
              <strong>{selectedLocale?.name ?? locale}</strong> customer…
            </p>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 p-4 bg-red-50 border-2 border-red-200">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-doodle font-bold text-red-700">
                  Generation failed
                </p>
                <p className="font-doodle text-sm text-red-600">{error}</p>
              </div>
            </div>
            <button
              onClick={() => {
                setError(null);
              }}
              className="font-doodle text-sm underline text-doodle-text/60 hover:text-doodle-text"
            >
              Try again
            </button>
          </div>
        )}

        {/* Success state */}
        {result && result.success && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 p-3 bg-green-50 border-2 border-green-200">
              <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
              <div>
                <p className="font-doodle font-bold text-green-800">
                  Customer created!
                </p>
                <p className="font-doodle text-xs text-green-700">
                  Locale: {result.locale} · ID #{result.salesCustomerId}
                </p>
              </div>
            </div>

            <div className="p-4 border-2 border-doodle-text/20 bg-white space-y-2">
              <div className="flex items-center gap-2 mb-3">
                <User className="w-4 h-4 text-doodle-accent" />
                <span className="font-doodle font-bold text-doodle-text">
                  {result.firstName} {result.lastName}
                </span>
              </div>
              {result.email && (
                <p className="font-doodle text-sm text-doodle-text/70">
                  📧 {result.email}
                </p>
              )}
              {result.phone && (
                <p className="font-doodle text-sm text-doodle-text/70">
                  📞 {result.phone}
                </p>
              )}
              {result.address && (
                <p className="font-doodle text-sm text-doodle-text/70">
                  📍 {result.address}, {result.city}
                  {result.stateCode ? `, ${result.stateCode}` : ""}{" "}
                  {result.postalCode}
                </p>
              )}
              {result.country && (
                <p className="font-doodle text-sm text-doodle-text/70">
                  🌍 {result.country}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setResult(null);
                }}
                className="flex-1 font-doodle text-sm border-2 border-doodle-text px-4 py-2 hover:bg-doodle-text/10 transition-colors"
              >
                Generate Another
              </button>
              <button
                onClick={handleClose}
                className="flex-1 doodle-button doodle-button-primary py-2"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default GenerateCustomerWithAIDialog;
