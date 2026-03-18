export interface SpecialOffer {
  SpecialOfferID: number;
  CultureID: string;
  Description: string;
  DiscountPct: number;
  Type: string;
  Category: string;
  StartDate: string;
  EndDate: string;
  MinQty: number;
  MaxQty: number | null;
  rowguid?: string;
  ModifiedDate?: string;
}

export type SpecialOfferFormData = Omit<
  SpecialOffer,
  "SpecialOfferID" | "rowguid" | "ModifiedDate"
>;

export const OFFER_TYPES = [
  "No Discount",
  "Volume Discount",
  "Seasonal Discount",
  "Customer Discount",
  "Promotional Discount",
  "Clearance",
] as const;

export const OFFER_CATEGORIES = [
  "Customer",
  "Reseller",
  "No Discount",
] as const;

/** CultureID values as stored in the DB (6-char nchar, right-padded with spaces) */
export const CULTURES: { id: string; label: string }[] = [
  { id: "ar    ", label: "Arabic" },
  { id: "de    ", label: "German" },
  { id: "en    ", label: "English (US)" },
  { id: "en-au ", label: "English (AU)" },
  { id: "en-ca ", label: "English (CA)" },
  { id: "en-gb ", label: "English (GB)" },
  { id: "en-ie ", label: "English (IE)" },
  { id: "en-nz ", label: "English (NZ)" },
  { id: "es    ", label: "Spanish" },
  { id: "fr    ", label: "French" },
  { id: "he    ", label: "Hebrew" },
  { id: "id    ", label: "Indonesian" },
  { id: "it    ", label: "Italian" },
  { id: "ja    ", label: "Japanese" },
  { id: "ko    ", label: "Korean" },
  { id: "nl    ", label: "Dutch" },
  { id: "pt    ", label: "Portuguese" },
  { id: "ru    ", label: "Russian" },
  { id: "th    ", label: "Thai" },
  { id: "tr    ", label: "Turkish" },
  { id: "vi    ", label: "Vietnamese" },
  { id: "zh    ", label: "Chinese (Simplified)" },
  { id: "zh-cht", label: "Chinese (Traditional)" },
];

export const DEFAULT_CULTURE_ID = "en    ";

export const getCultureLabel = (cultureId: string): string =>
  CULTURES.find((c) => c.id === cultureId)?.label ?? cultureId.trim();

export const getOfferStatus = (
  offer: SpecialOffer,
): "active" | "upcoming" | "expired" => {
  const now = new Date();
  const startDate = new Date(offer.StartDate);
  const endDate = new Date(offer.EndDate);

  if (now < startDate) return "upcoming";
  if (now > endDate) return "expired";
  return "active";
};
