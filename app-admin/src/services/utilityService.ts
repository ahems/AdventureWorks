// Real utility service — wires to Azure Functions (Durable & queue-based)
import { getFunctionsApiUrl } from "@/lib/utils";

export interface DurableFunctionResponse {
  id: string;
  statusQueryGetUri: string;
  sendEventPostUri: string;
  terminatePostUri: string;
  purgeHistoryDeleteUri: string;
}

export interface QueuedJobResponse {
  id: string;
  statusQueryGetUri: null;
  terminatePostUri: null;
}

export type JobResponse = DurableFunctionResponse | QueuedJobResponse;

export interface OrchestrationStatus {
  instanceId?: string;
  runtimeStatus: "Pending" | "Running" | "Completed" | "Failed" | "Terminated";
  customStatus?: string | null;
  input?: unknown;
  output?: unknown;
  createdTime?: string;
  lastUpdatedTime?: string;
}

export const supportedLanguages = [
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
  { code: "it", name: "Italian" },
  { code: "nl", name: "Dutch" },
  { code: "ru", name: "Russian" },
  { code: "zh", name: "Chinese (Simplified)" },
  { code: "zh-cht", name: "Chinese (Traditional)" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "ar", name: "Arabic" },
  { code: "he", name: "Hebrew" },
  { code: "tr", name: "Turkish" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "id", name: "Indonesian" },
  { code: "en-gb", name: "English (UK)" },
  { code: "en-ca", name: "English (Canada)" },
  { code: "en-au", name: "English (Australia)" },
  { code: "en-nz", name: "English (New Zealand)" },
  { code: "en-ie", name: "English (Ireland)" },
];

async function startDurableFunction(
  name: string,
  body?: object,
): Promise<DurableFunctionResponse> {
  const url = `${getFunctionsApiUrl()}/api/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

async function startQueuedFunction(
  name: string,
  body?: object,
): Promise<QueuedJobResponse> {
  const url = `${getFunctionsApiUrl()}/api/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return {
    id: `queued-${Date.now()}`,
    statusQueryGetUri: null,
    terminatePostUri: null,
  };
}

// ── Durable Functions (support status polling) ─────────────────────────────

export const embellishProductDescriptions = (productIds?: number[]) =>
  startDurableFunction(
    "EmbellishProductsUsingAI_HttpStart",
    productIds?.length ? { ProductIds: productIds } : undefined,
  );

export const generateProductEmbeddings = () =>
  startDurableFunction("GenerateProductEmbeddings_HttpStart");

export const generateReviewEmbeddings = () =>
  startDurableFunction("GenerateProductReviewEmbeddings_HttpStart");

export const translateProductDescriptions = (productModelIds?: number[]) =>
  startDurableFunction(
    "TranslateProductDescriptions_HttpStart",
    productModelIds?.length ? { ProductModelIds: productModelIds } : undefined,
  );

/** languageData must be the parsed JSON object (not a string) */
export const translateLanguageFile = (
  targetLanguage: string,
  languageData: object,
) =>
  startDurableFunction("TranslateLanguageFile_HttpStart", {
    targetLanguage,
    languageData,
  });

export const generateProductReviews = (
  productIds?: number[],
  reviewsPerProduct?: number,
) =>
  startDurableFunction("GenerateProductReviewsUsingAI_HttpStart", {
    ...(productIds?.length ? { ProductIds: productIds } : {}),
    ...(reviewsPerProduct !== undefined
      ? { ReviewsPerProduct: reviewsPerProduct }
      : {}),
  });

// ── Promotion translation ──────────────────────────────────────────────────

export interface PromotionTranslationPayload {
  specialOfferID: number;
  description: string;
  discountPct: number;
  type: string;
  category: string;
  startDate: string;
  endDate: string;
  minQty: number;
  maxQty?: number | null;
}

export interface PromotionTranslationResult {
  success: boolean;
  culturesProcessed: number;
  message: string;
}

/**
 * Fire-and-forget: translates a promotion description to all non-English cultures
 * by calling the TranslatePromotion Azure Function directly (not a Durable Function).
 */
export const translatePromotion = async (
  payload: PromotionTranslationPayload,
): Promise<PromotionTranslationResult> => {
  const url = `${getFunctionsApiUrl()}/api/TranslatePromotion`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `TranslatePromotion HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

// ── Queue-based Functions (fire and forget, no status polling) ──────────────

export const generateProductImages = (productIds?: number[]) =>
  startQueuedFunction(
    "GenerateProductImages_HttpStart",
    productIds?.length ? { ProductIds: productIds } : undefined,
  );

// ── Status management for Durable Functions ────────────────────────────────

/**
 * Poll the status of a running Durable orchestration.
 * @param statusQueryGetUri — the URL returned by the HttpStart response
 */
export const getOrchestrationStatus = async (
  statusQueryGetUri: string,
): Promise<OrchestrationStatus> => {
  const res = await fetch(statusQueryGetUri);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/**
 * Terminate a running Durable orchestration.
 * @param terminatePostUri — the URL returned by the HttpStart response
 */
export const terminateOrchestration = async (
  terminatePostUri: string,
): Promise<boolean> => {
  const res = await fetch(terminatePostUri, { method: "POST" });
  return res.ok;
};
