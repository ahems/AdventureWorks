/**
 * Help Me Choose Service
 * Connects to the /api/helpme/* Azure Functions endpoints that power the AI wizard.
 */

import { trackError } from "@/lib/appInsights";

const getFunctionsEndpoint = (): string => {
  if (typeof window !== "undefined" && window.APP_CONFIG?.API_FUNCTIONS_URL) {
    return `${window.APP_CONFIG.API_FUNCTIONS_URL}/api/helpme`;
  }
  const functionsUrl = import.meta.env.VITE_API_FUNCTIONS_URL;
  if (functionsUrl) return `${functionsUrl}/api/helpme`;
  return "/api/helpme";
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizardQuestion {
  id: number;
  text: string;
  icon: string;
  options: string[];
}

export interface WizardQuestionsResponse {
  sessionId: string;
  questions: WizardQuestion[];
  /** Foundry response ID — pass back as previousThreadId in the recommendations request to chain both wizard phases. */
  threadId?: string;
}

export interface WizardAnswer {
  questionId: number;
  question: string;
  answer: string;
}

export interface ProductRecommendation {
  productId: number;
  productName: string;
  category: string;
  price: number | null;
  reason: string;
  thumbnailUrl: string | null;
}

export interface RecommendationsResponse {
  summary: string;
  recommendations: ProductRecommendation[];
  searchTermsUsed: string[];
  /** Foundry response ID for multi-turn refinement — pass back as previousThreadId for follow-up refinement requests. */
  threadId?: string;
}

export interface CatalogMeta {
  colors: string[];
  bikeSizes: string[];
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Fetch AI-generated personalised questions for the wizard.
 */
export const getWizardQuestions = async (
  context?: string,
  cultureId?: string,
  customerId?: number,
): Promise<WizardQuestionsResponse> => {
  const endpoint = getFunctionsEndpoint();

  try {
    const res = await fetch(`${endpoint}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context, cultureId, customerId }),
    });

    if (!res.ok)
      throw new Error(`getWizardQuestions failed: ${res.statusText}`);

    const data = await res.json();
    return {
      sessionId: data.sessionId ?? data.SessionId ?? "",
      questions: (data.questions ?? data.Questions ?? []).map(
        (q: Record<string, unknown>) => ({
          id: q.id ?? q.Id,
          text: q.text ?? q.Text ?? "",
          icon: q.icon ?? q.Icon ?? "❓",
          options: q.options ?? q.Options ?? [],
        }),
      ),
      threadId: data.threadId ?? data.ThreadId ?? undefined,
    };
  } catch (error) {
    trackError("HelpMeChoose getWizardQuestions error", error, {
      service: "helpMeService",
    });
    throw error;
  }
};

/**
 * Get product recommendations based on the user's wizard answers.
 */
export const getRecommendations = async (
  answers: WizardAnswer[],
  sessionId?: string,
  cultureId?: string,
  firstName?: string,
  gender?: string,
  heightLabel?: string,
  preferredColors?: string[],
  customerId?: number,
  previousThreadId?: string,
): Promise<RecommendationsResponse> => {
  const endpoint = getFunctionsEndpoint();

  try {
    const res = await fetch(`${endpoint}/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        answers,
        cultureId,
        firstName,
        gender,
        heightLabel,
        preferredColors,
        customerId,
        previousThreadId,
      }),
    });

    if (!res.ok)
      throw new Error(`getRecommendations failed: ${res.statusText}`);

    const data = await res.json();
    return {
      summary: data.summary ?? data.Summary ?? "",
      recommendations: (data.recommendations ?? data.Recommendations ?? []).map(
        (r: Record<string, unknown>) => ({
          productId: r.productId ?? r.ProductId ?? 0,
          productName: r.productName ?? r.ProductName ?? "",
          category: r.category ?? r.Category ?? "",
          price: r.price ?? r.Price ?? null,
          reason: r.reason ?? r.Reason ?? "",
          thumbnailUrl: r.thumbnailUrl ?? r.ThumbnailUrl ?? null,
        }),
      ),
      searchTermsUsed: data.searchTermsUsed ?? data.SearchTermsUsed ?? [],
      threadId: data.threadId ?? data.ThreadId ?? undefined,
    };
  } catch (error) {
    trackError("HelpMeChoose getRecommendations error", error, {
      service: "helpMeService",
    });
    throw error;
  }
};

/**
 * Fetch live catalog metadata: distinct product colours and bike frame sizes.
 */
export const getCatalogMeta = async (): Promise<CatalogMeta> => {
  const endpoint = getFunctionsEndpoint();
  try {
    const res = await fetch(`${endpoint}/catalog-meta`);
    if (!res.ok) throw new Error(`getCatalogMeta failed: ${res.statusText}`);
    const data = await res.json();
    return {
      colors: (data.colors ?? data.Colors ?? []) as string[],
      bikeSizes: (data.bikeSizes ?? data.BikeSizes ?? []) as string[],
    };
  } catch (error) {
    trackError("HelpMeChoose getCatalogMeta error", error, {
      service: "helpMeService",
    });
    throw error;
  }
};
