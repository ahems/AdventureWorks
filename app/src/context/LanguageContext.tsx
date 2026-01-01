import React, { createContext, useContext, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

export interface Language {
  code: string;
  name: string;
  flag: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English (US)", flag: "🇺🇸" },
  { code: "en-gb", name: "English (UK)", flag: "🇬🇧" },
  { code: "en-ca", name: "English (Canada)", flag: "🇨🇦" },
  { code: "en-au", name: "English (Australia)", flag: "🇦🇺" },
  { code: "en-nz", name: "English (New Zealand)", flag: "🇳🇿" },
  { code: "en-ie", name: "English (Ireland)", flag: "🇮🇪" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "de", name: "German", flag: "🇩🇪" },
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

interface LanguageContextType {
  selectedLanguage: string;
  setSelectedLanguage: (language: string) => void;
  languages: Language[];
}

const LanguageContext = createContext<LanguageContextType | undefined>(
  undefined
);

const detectBrowserLanguage = (): string => {
  // Get browser language
  const browserLang = navigator.language.toLowerCase();

  // First, try exact match
  const exactMatch = LANGUAGES.find(
    (lang) => lang.code.toLowerCase() === browserLang
  );
  if (exactMatch) return exactMatch.code;

  // Try to match the base language (e.g., "en" from "en-US")
  const baseLang = browserLang.split("-")[0];
  const baseMatch = LANGUAGES.find(
    (lang) => lang.code.toLowerCase() === baseLang
  );
  if (baseMatch) return baseMatch.code;

  // Try to match any language that starts with the base (e.g., "en-gb" for "en")
  const partialMatch = LANGUAGES.find((lang) =>
    lang.code.toLowerCase().startsWith(baseLang)
  );
  if (partialMatch) return partialMatch.code;

  // Default to English
  return "en";
};

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { i18n } = useTranslation();
  const [selectedLanguage, setSelectedLanguageState] = useState<string>(() => {
    // Try to get saved language from localStorage
    const saved = localStorage.getItem("selectedLanguage");
    // If no saved preference, detect from browser
    return saved || detectBrowserLanguage();
  });

  // Initialize i18n language on mount
  useEffect(() => {
    if (i18n.language !== selectedLanguage) {
      i18n.changeLanguage(selectedLanguage);
    }
  }, []);

  // Save to localStorage and sync with i18next whenever language changes
  useEffect(() => {
    localStorage.setItem("selectedLanguage", selectedLanguage);
    if (i18n.language !== selectedLanguage) {
      i18n.changeLanguage(selectedLanguage);
    }
  }, [selectedLanguage, i18n]);

  const setSelectedLanguage = (language: string) => {
    setSelectedLanguageState(language);
  };

  return (
    <LanguageContext.Provider
      value={{ selectedLanguage, setSelectedLanguage, languages: LANGUAGES }}
    >
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
};
