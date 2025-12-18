import React, { createContext, useContext, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

export interface Language {
  code: string;
  name: string;
  flag: string;
}

export const LANGUAGES: Language[] = [
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "en", name: "English", flag: "🇺🇸" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "he", name: "Hebrew", flag: "🇮🇱" },
  { code: "th", name: "Thai", flag: "🇹🇭" },
  { code: "zh-cht", name: "Chinese", flag: "🇨🇳" },
];

interface LanguageContextType {
  selectedLanguage: string;
  setSelectedLanguage: (language: string) => void;
  languages: Language[];
}

const LanguageContext = createContext<LanguageContextType | undefined>(
  undefined
);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { i18n } = useTranslation();
  const [selectedLanguage, setSelectedLanguageState] = useState<string>(() => {
    // Try to get saved language from localStorage
    const saved = localStorage.getItem("selectedLanguage");
    return saved || "en";
  });

  // Save to localStorage and sync with i18next whenever language changes
  useEffect(() => {
    localStorage.setItem("selectedLanguage", selectedLanguage);
    i18n.changeLanguage(selectedLanguage);
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
