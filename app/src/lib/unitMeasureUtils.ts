export type UnitSystem = "imperial" | "metric";

// Map language codes to preferred unit systems
export const getUnitSystemForLanguage = (languageCode: string): UnitSystem => {
  // US, Liberia, and Myanmar primarily use imperial
  // Everyone else uses metric
  const imperialLanguages = ["en"]; // US English

  // Explicitly metric English variants
  const metricEnglishVariants = ["en-gb", "en-ca", "en-au", "en-nz", "en-ie"];

  if (imperialLanguages.includes(languageCode)) {
    return "imperial";
  }

  return "metric";
};
