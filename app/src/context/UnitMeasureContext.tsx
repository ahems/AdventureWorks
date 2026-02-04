import React, { createContext, useContext, useState, useEffect } from "react";
import { UnitSystem, getUnitSystemForLanguage } from "@/lib/unitMeasureUtils";

// Conversion factors
const LBS_TO_KG = 0.453592;
const KG_TO_LBS = 2.20462;
const INCHES_TO_CM = 2.54;
const CM_TO_INCHES = 0.393701;

interface UnitMeasureContextType {
  unitSystem: UnitSystem;
  setUnitSystem: (system: UnitSystem) => void;
  convertWeight: (
    weight: number | null,
    sourceUnit: string | null
  ) => { value: number | null; unit: string };
  convertSize: (
    size: string | null,
    sourceUnit: string | null
  ) => { value: string | null; unit: string };
  formatWeight: (weight: number | null, sourceUnit: string | null) => string;
  formatSize: (size: string | null, sourceUnit: string | null) => string;
}

const UnitMeasureContext = createContext<UnitMeasureContextType | undefined>(
  undefined
);

export const UnitMeasureProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [unitSystem, setUnitSystemState] = useState<UnitSystem>(() => {
    const saved = localStorage.getItem("unitSystem");
    return (saved as UnitSystem) || "imperial";
  });

  useEffect(() => {
    localStorage.setItem("unitSystem", unitSystem);
  }, [unitSystem]);

  const setUnitSystem = (system: UnitSystem) => {
    setUnitSystemState(system);
  };

  const convertWeight = (
    weight: number | null,
    sourceUnit: string | null
  ): { value: number | null; unit: string } => {
    if (weight === null || weight === 0) {
      return { value: null, unit: unitSystem === "metric" ? "kg" : "lbs" };
    }

    // Normalize source unit code (trim spaces)
    const normalizedSource = sourceUnit?.trim().toUpperCase();

    // Determine if source is metric or imperial
    const sourceIsMetric =
      normalizedSource === "G" || normalizedSource === "KG";
    const sourceIsImperial = normalizedSource === "LB";

    // Convert to grams first if needed
    let weightInGrams = weight;
    if (sourceIsImperial) {
      weightInGrams = weight * 453.592; // lbs to grams
    } else if (normalizedSource === "KG") {
      weightInGrams = weight * 1000;
    }
    // If source is 'G', it's already in grams

    if (unitSystem === "metric") {
      // Convert to kg if over 1000g, otherwise use grams
      if (weightInGrams >= 1000) {
        return {
          value: Math.round((weightInGrams / 1000) * 100) / 100,
          unit: "kg",
        };
      }
      return { value: Math.round(weightInGrams), unit: "g" };
    } else {
      // Convert to lbs
      const lbs = weightInGrams / 453.592;
      return { value: Math.round(lbs * 100) / 100, unit: "lbs" };
    }
  };

  const convertSize = (
    size: string | null,
    sourceUnit: string | null
  ): { value: string | null; unit: string } => {
    if (!size) {
      return { value: null, unit: unitSystem === "metric" ? "cm" : "in" };
    }

    // Try to extract numeric value from size string
    const numericMatch = size.match(/(\d+\.?\d*)/);
    if (!numericMatch) {
      // Non-numeric size (like "S", "M", "L", "XL")
      return { value: size, unit: "" };
    }

    const numericValue = parseFloat(numericMatch[1]);
    const normalizedSource = sourceUnit?.trim().toUpperCase();

    // Determine if source is metric or imperial
    const sourceIsMetric =
      normalizedSource === "CM" || normalizedSource === "MM";
    const sourceIsImperial = normalizedSource === "IN";

    // Convert to cm first
    let valueInCm = numericValue;
    if (sourceIsImperial) {
      valueInCm = numericValue * INCHES_TO_CM;
    } else if (normalizedSource === "MM") {
      valueInCm = numericValue / 10;
    }
    // If source is 'CM', it's already in cm

    if (unitSystem === "metric") {
      // Use mm for small values, cm otherwise
      if (valueInCm < 1) {
        return { value: Math.round(valueInCm * 10).toString(), unit: "mm" };
      }
      return { value: Math.round(valueInCm * 10) / 10 + "", unit: "cm" };
    } else {
      // Convert to inches
      const inches = valueInCm * CM_TO_INCHES;
      return { value: (Math.round(inches * 10) / 10).toString(), unit: "in" };
    }
  };

  const formatWeight = (
    weight: number | null,
    sourceUnit: string | null
  ): string => {
    const converted = convertWeight(weight, sourceUnit);
    if (converted.value === null) return "";
    return `${converted.value} ${converted.unit}`;
  };

  const formatSize = (
    size: string | null,
    sourceUnit: string | null
  ): string => {
    const converted = convertSize(size, sourceUnit);
    if (converted.value === null) return "";
    if (!converted.unit) return converted.value; // For non-numeric sizes
    return `${converted.value} ${converted.unit}`;
  };

  const value = {
    unitSystem,
    setUnitSystem,
    convertWeight,
    convertSize,
    formatWeight,
    formatSize,
  };

  return (
    <UnitMeasureContext.Provider value={value}>
      {children}
    </UnitMeasureContext.Provider>
  );
};

export const useUnitMeasure = () => {
  const context = useContext(UnitMeasureContext);
  if (!context) {
    throw new Error("useUnitMeasure must be used within UnitMeasureProvider");
  }
  return context;
};
