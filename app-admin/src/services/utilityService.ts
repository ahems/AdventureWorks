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

export const generateProductEmbeddings = () =>
  startQueuedFunction("GenerateProductEmbeddings_HttpStart");

export const generateReviewEmbeddings = () =>
  startQueuedFunction("GenerateProductReviewEmbeddings_HttpStart");

export const translateProductDescriptions = (productModelIds?: number[]) =>
  startQueuedFunction(
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
  startQueuedFunction("GenerateProductReviewsUsingAI_HttpStart", {
    ...(productIds?.length ? { ProductIds: productIds } : {}),
    ...(reviewsPerProduct !== undefined
      ? { ReviewsPerProduct: reviewsPerProduct }
      : {}),
  });

// ── Verified Reviews (real customers with Delivered orders) ────────────────

export interface CustomerWithDeliveredOrder {
  customerID: number;
  firstName: string;
  lastName: string;
  emailAddress: string;
  deliveryDate: string;
}

export interface VerifiedReviewsJobState {
  isRunning: boolean;
  productId: number;
  productName: string;
  processedCount: number;
  totalCount: number;
  productsProcessed: number;
  productsTotal: number;
  startedAt: string | null;
  lastProgressAt: string | null;
  lastError: string | null;
}

export interface VerifiedReviewsSummary {
  qualifyingProductCount: number;
  maxEligibleCustomersPerProduct: number;
  topProductId: number;
  topProductName: string;
}

export interface CustomersWithDeliveredOrderResponse {
  customers: CustomerWithDeliveredOrder[];
  count: number;
}

/** Returns summary counts for the batch wizard: qualifying products and max eligible customers per product. */
export const getVerifiedReviewsSummary =
  async (): Promise<VerifiedReviewsSummary> => {
    const url = `${getFunctionsApiUrl()}/api/generate-verified-reviews/summary`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }
    return res.json();
  };

/**
 * Starts a batch verified-reviews generation job.
 * productCount: 0 = all qualifying products.
 * reviewsPerProduct: 1..maxEligibleCustomersPerProduct (default 1).
 * specificProductId: when set, only generates for that product (product-page path).
 * Returns 202 on success, throws on 409 Conflict or other errors.
 */
export const startBatchVerifiedReviews = async (
  productCount: number,
  reviewsPerProduct: number,
  specificProductId?: number,
): Promise<{ message: string; productsTotal: number; totalCount: number }> => {
  const url = `${getFunctionsApiUrl()}/api/generate-verified-reviews/start`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productCount,
      reviewsPerProduct,
      ...(specificProductId !== undefined ? { specificProductId } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
};

/**
 * Product-page helper: generates verified reviews for a single specific product.
 * Only uses real eshop customers who received a delivery and haven't yet reviewed it.
 * reviewsPerProduct: how many eligible customers to use (default 1).
 */
export const generateVerifiedReviewsForProduct = (
  productId: number,
  reviewsPerProduct = 1,
) => startBatchVerifiedReviews(1, reviewsPerProduct, productId);

export const getVerifiedReviewsJobStatus =
  async (): Promise<VerifiedReviewsJobState> => {
    const url = `${getFunctionsApiUrl()}/api/generate-verified-reviews/status`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }
    return res.json();
  };

/** Diagnostic: returns unreviewed eligible customers for a specific product. */
export const getCustomersWithDeliveredOrder = async (
  productId: number,
): Promise<CustomersWithDeliveredOrderResponse> => {
  const url = `${getFunctionsApiUrl()}/api/products/${productId}/customers-with-delivered-orders`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
};

/**
 * Lightweight: returns only the count of eligible unreviewed eshop customers
 * for a specific product. Use this for the product-page eligibility gate
 * instead of getCustomersWithDeliveredOrder (which fetches all rows).
 */
export const getProductEligibleReviewerCount = async (
  productId: number,
): Promise<number> => {
  const url = `${getFunctionsApiUrl()}/api/products/${productId}/eligible-reviewer-count`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  const data = await res.json();
  return data.count as number;
};

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

/**
 * Fire-and-forget: enqueues translation jobs for a single product's descriptions
 * (and names) to all non-English cultures onto the shared ai-job-queue.
 * Jobs are processed serially along with all other AI work.
 */
export const translateProductContent = (productModelIds: number[]) =>
  startQueuedFunction("TranslateProductDescriptions_HttpStart", {
    ProductModelIds: productModelIds,
  });

// ── Category name translation (fire-and-forget) ────────────────────────────

export interface CategoryTranslationPayload {
  categoryId: number;
  englishName: string;
  type: "category" | "subcategory";
}

export interface CategoryTranslationResult {
  success: boolean;
  culturesProcessed: number;
  message: string;
}

/**
 * Fire-and-forget: translates a category/subcategory name to all non-English cultures.
 */
export const translateCategoryName = async (
  payload: CategoryTranslationPayload,
): Promise<CategoryTranslationResult> => {
  const url = `${getFunctionsApiUrl()}/api/TranslateCategoryName`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `TranslateCategoryName HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

// ── Category / Subcategory CRUD (via Azure Functions for ID generation) ─────

export interface CreateCategoryResult {
  success: boolean;
  id: number;
  message: string;
}

export interface CreateSubcategoryResult {
  success: boolean;
  subcategoryId: number;
  message: string;
}

export interface DeleteCategoryResult {
  success: boolean;
  message: string;
}

export const createCategory = async (
  englishName: string,
): Promise<CreateCategoryResult> => {
  const url = `${getFunctionsApiUrl()}/api/CreateCategory`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ englishName }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `CreateCategory HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

export const createSubcategory = async (
  categoryId: number,
  englishName: string,
): Promise<CreateSubcategoryResult> => {
  const url = `${getFunctionsApiUrl()}/api/CreateSubcategory`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryId, englishName }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `CreateSubcategory HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

export const deleteCategory = async (
  categoryId: number,
): Promise<DeleteCategoryResult> => {
  const url = `${getFunctionsApiUrl()}/api/DeleteCategory`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: categoryId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DeleteCategory HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

export const deleteSubcategory = async (
  subcategoryId: number,
): Promise<DeleteCategoryResult> => {
  const url = `${getFunctionsApiUrl()}/api/DeleteSubcategory`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: subcategoryId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DeleteSubcategory HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

export interface SubcategoryProductInfo {
  totalProducts: number;
  modelGroupCount: number;
}

export const getSubcategoryProductInfo = async (
  subcategoryId: number,
): Promise<SubcategoryProductInfo> => {
  const url = `${getFunctionsApiUrl()}/api/GetSubcategoryProductCount`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: subcategoryId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GetSubcategoryProductCount HTTP ${res.status}${text ? `: ${text}` : ""}`,
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

export interface ArchiveTransactionsResult {
  success: boolean;
  recordsArchived: number;
  archivedAt: string;
}

/**
 * Manually triggers the TransactionHistory archive job.
 * Moves records older than 1 year from TransactionHistory → TransactionHistoryArchive.
 * GET /api/archive/trigger
 */
export const archiveTransactions =
  async (): Promise<ArchiveTransactionsResult> => {
    const url = `${getFunctionsApiUrl()}/api/archive/trigger`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }
    return res.json() as Promise<ArchiveTransactionsResult>;
  };

export const generateSingleProductImages = (productId: number) => {
  const url = `${getFunctionsApiUrl()}/api/products/${productId}/generate-images`;
  return fetch(url, { method: "POST" }).then((res) => {
    if (!res.ok) {
      return res.text().then((text) => {
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
      });
    }
  });
};

// ── AI Product Content Generation ─────────────────────────────────────────

export interface GenerateProductContentRequest {
  category: string;
  subcategory: string;
  productLine?: string | null;
  class_?: string | null;
  style?: string | null;
  /** Full list of available sizes — AI returns which subset makes sense for this product. */
  availableSizes?: string[];
  /** Full list of available colors — AI returns which subset makes sense for this product. */
  availableColors?: string[];
  /** Full list of available style values — AI returns which subset makes sense for this product. */
  availableStyles?: string[];
}

export interface GenerateProductContentResponse {
  productName: string;
  productDescription: string;
  estimatedWeightLb: number;
  suggestedStandardCost: number;
  suggestedListPrice: number;
  suggestedSizes: string[];
  suggestedColors: string[];
  suggestedStyles: string[];
  /** Foundry response ID — pass as previousResponseId on the next product in the same wizard run. */
  threadId?: string;
}

export const generateProductContent = async (
  request: GenerateProductContentRequest,
  previousResponseId?: string,
): Promise<GenerateProductContentResponse> => {
  const url = `${getFunctionsApiUrl()}/api/products/generate-content`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: request.category,
      subcategory: request.subcategory,
      productLine: request.productLine ?? null,
      class: request.class_ ?? null,
      style: request.style ?? null,
      availableSizes: request.availableSizes ?? null,
      availableColors: request.availableColors ?? null,
      availableStyles: request.availableStyles ?? null,
      previousResponseId: previousResponseId ?? null,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GenerateProductContent HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  const data = await res.json();
  // Ensure backward-compatible defaults for new fields
  return {
    productName: data.productName ?? "",
    productDescription: data.productDescription ?? "",
    estimatedWeightLb: data.estimatedWeightLb ?? 0,
    suggestedStandardCost: data.suggestedStandardCost ?? 0,
    suggestedListPrice: data.suggestedListPrice ?? 0,
    suggestedSizes: data.suggestedSizes ?? [],
    suggestedColors: data.suggestedColors ?? [],
    suggestedStyles: data.suggestedStyles ?? [],
    threadId: data.threadId ?? undefined,
  };
};

/**
 * Fire-and-forget: generates AI reviews AND staff replies for a single product.
 * Designed for the "Generate Products with AI" wizard.
 */
export const generateReviewsWithReplies = (productId: number): Promise<void> =>
  fetch(
    `${getFunctionsApiUrl()}/api/products/${productId}/generate-reviews-with-replies`,
    { method: "POST" },
  )
    .then(() => undefined)
    .catch(() => undefined);

/**
 * Fire-and-forget: asks AI to suggest and create a new top-level category.
 * The backend queries the DB, calls AI, creates the category, and translates it.
 */
export const generateCategoryWithAI = (): Promise<void> =>
  fetch(`${getFunctionsApiUrl()}/api/GenerateCategoryWithAI`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "category" }),
  })
    .then(() => undefined)
    .catch(() => undefined);

/**
 * Fire-and-forget: asks AI to suggest and create a new subcategory under the given parent.
 * @param categoryId — the parent category's ID
 * @param categoryName — the parent category's English name (for AI context)
 */
export const generateSubcategoryWithAI = (
  categoryId: number,
  categoryName: string,
): Promise<void> =>
  fetch(`${getFunctionsApiUrl()}/api/GenerateCategoryWithAI`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "subcategory", categoryId, categoryName }),
  })
    .then(() => undefined)
    .catch(() => undefined);

// ── AI Promotion Generation ────────────────────────────────────────────────

export interface GeneratePromotionRequest {
  promotionType: string;
  offerCategory: string;
  categoryId?: number;
  categoryName?: string;
  subcategoryId?: number;
  subcategoryName?: string;
  /** Foundry response ID from a previous call — used for multi-turn refinement. */
  previousThreadId?: string;
}

export interface SuggestedProduct {
  productId: number;
  productName: string;
  currentPrice: number;
  standardCost: number;
  inventoryLevel: number;
  recentSalesCount: number;
  reason: string;
}

export interface PromotionSuggestion {
  description: string;
  discountPct: number;
  type: string;
  category: string;
  startDate: string;
  endDate: string;
  minQty: number;
  suggestedProducts: SuggestedProduct[];
  aiReasoning: string;
}

export interface GeneratePromotionResult {
  /** The promotion suggestion generated by the AI agent. */
  suggestion: PromotionSuggestion;
  /** Foundry response ID — pass back as previousThreadId to refine the suggestion. */
  threadId?: string;
}

/**
 * Call the AI promotion agent to generate a promotion suggestion.
 * The agent uses live inventory and sales data via the MCP server.
 * Returns a structured suggestion including products, discount %, and framing.
 * Pass previousThreadId to refine a previous suggestion in a multi-turn conversation.
 */
export const generatePromotionWithAI = async (
  request: GeneratePromotionRequest,
): Promise<GeneratePromotionResult> => {
  const url = `${getFunctionsApiUrl()}/api/GeneratePromotion`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GeneratePromotion HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  const data = await res.json();
  // Backend returns { suggestion, threadId } — unwrap for callers
  if (data && typeof data === "object" && "suggestion" in data) {
    return data as GeneratePromotionResult;
  }
  // Backward-compat: plain PromotionSuggestion (pre-Foundry backend)
  return { suggestion: data as PromotionSuggestion, threadId: undefined };
};

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

// ── AI Order Generation ────────────────────────────────────────────────────

export interface OrderGenLogEntry {
  message: string;
  type: "info" | "success" | "error" | "dim";
}

export interface OrderGenerationResult {
  success: boolean;
  salesOrderId: number;
  customerName?: string;
  customerEmail?: string;
  newCustomerCreated?: boolean;
  totalDue?: number;
  receiptPdfBase64?: string;
  errorMessage?: string;
  log: OrderGenLogEntry[];
  /** Foundry response ID — pass back as previousThreadId to refine the order in a follow-up turn. */
  threadId?: string;
}

/**
 * Call the AI Order Generation wizard backend.
 * The agent uses MCP tools to research the catalogue, promotions, and customers,
 * then creates a realistic order (and optionally a new customer) in the database.
 * Returns detailed per-step log and the new SalesOrderID.
 * Pass previousThreadId to continue a multi-turn order-generation conversation.
 */
export const generateOrderWithAI = async (
  personaType: string,
  customPersona?: string,
  seedCustomerId?: number,
  previousThreadId?: string,
): Promise<OrderGenerationResult> => {
  const url = `${getFunctionsApiUrl()}/api/GenerateOrderWithAI`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      personaType,
      customPersona,
      seedCustomerId,
      previousThreadId,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GenerateOrderWithAI HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

// ── Top Spenders (for existing-customer persona) ───────────────────────────

export interface TopSpenderCustomer {
  customerID: number;
  firstName: string;
  lastName: string;
  email?: string;
  totalSpend: number;
  orderCount: number;
}

export const getTopSpenders = async (
  limit = 100,
): Promise<TopSpenderCustomer[]> => {
  const url = `${getFunctionsApiUrl()}/api/customers/top-spenders?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GetTopSpenders HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

// ── Bulk Order Generation ──────────────────────────────────────────────────

export interface GenerateOrdersBulkResult {
  queued: number;
  message: string;
}

export const generateOrdersBulk = async (
  count: number,
): Promise<GenerateOrdersBulkResult> => {
  const url = `${getFunctionsApiUrl()}/api/GenerateOrdersBulk`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GenerateOrdersBulk HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

// ── AI Customer Generation ─────────────────────────────────────────────────

export interface GenerateCustomerResult {
  success: boolean;
  salesCustomerId: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  stateCode: string;
  postalCode: string;
  country: string;
  locale: string;
  error?: string;
}

/**
 * Ask the AI to generate a realistic fake customer profile for the given locale,
 * then create the customer record in the database.
 */
export const generateCustomerWithAI = async (
  locale: string,
): Promise<GenerateCustomerResult> => {
  const url = `${getFunctionsApiUrl()}/api/customers/generate-with-ai`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GenerateCustomerWithAI HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

// ── Shopping Simulator ─────────────────────────────────────────────────────

export interface ShoppingSimulatorStatus {
  isRunning: boolean;
  ordersPerMinute: number;
  existingCustomerPercentage: number;
  durationHours: number;
  stopScheduledAt: string | null;
  noOrderCustomerPercentage: number;
  abandonedCartPercentage: number;
  includeConsumerOrders: boolean;
  includeStoreOrders: boolean;
  storeOrderPercentage: number;
  startedAt: string | null;
  totalQueued: number;
  newCustomerQueued: number;
  existingCustomerQueued: number;
  storeOrderQueued: number;
  queueDepth: number;
  message?: string;
}

export interface ShoppingSimulatorStartConfig {
  ordersPerMinute: number;
  existingCustomerPercentage: number;
  durationHours: number;
  noOrderCustomerPercentage: number;
  abandonedCartPercentage: number;
  includeConsumerOrders: boolean;
  includeStoreOrders: boolean;
  storeOrderPercentage: number;
}

export const getShoppingSimulatorStatus =
  async (): Promise<ShoppingSimulatorStatus> => {
    const url = `${getFunctionsApiUrl()}/api/shopping-simulator/status`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `ShoppingSimulator status HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };

export const startShoppingSimulator = async (
  config: ShoppingSimulatorStartConfig,
): Promise<ShoppingSimulatorStatus> => {
  const url = `${getFunctionsApiUrl()}/api/shopping-simulator/start`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `ShoppingSimulator start HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

export const stopShoppingSimulator =
  async (): Promise<ShoppingSimulatorStatus> => {
    const url = `${getFunctionsApiUrl()}/api/shopping-simulator/stop`;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `ShoppingSimulator stop HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };

export const clearShoppingSimulatorQueue =
  async (): Promise<ShoppingSimulatorStatus> => {
    const url = `${getFunctionsApiUrl()}/api/shopping-simulator/clear-queue`;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `ShoppingSimulator clear-queue HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };

export interface SimulationOrderResult {
  success: boolean;
  salesOrderId: number;
  customerId: number;
  customerName: string | null;
  newCustomerCreated: boolean;
  totalDue: number;
  errorMessage: string | null;
  personaType: string | null;
  aiReasoning: string | null;
  itemCount: number;
  orderType: string | null;
  completedAt: string;
}

export const getShoppingSimulatorResults = async (
  limit = 50,
): Promise<SimulationOrderResult[]> => {
  const url = `${getFunctionsApiUrl()}/api/shopping-simulator/results?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `ShoppingSimulator results HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

// ── Order Pipeline Configuration ───────────────────────────────────────────

export interface OrderPipelineConfig {
  processingToApprovedMinMinutes: number;
  processingToApprovedMaxMinutes: number;
  approvedToShippedMinHours: number;
  approvedToShippedMaxHours: number;
}

export interface OrderPipelineStatusEntry {
  orderCount: number;
  totalValue: number;
}

export interface OrderPipelineStatus {
  inProcess: OrderPipelineStatusEntry;
  approved: OrderPipelineStatusEntry;
  backordered: OrderPipelineStatusEntry;
  rejected: OrderPipelineStatusEntry;
  shipped: OrderPipelineStatusEntry;
  cancelled: OrderPipelineStatusEntry;
  note: string;
}

export interface OrderPipelinePromoteResult {
  promoted: number;
  message: string;
}

export const getOrderPipelineConfig =
  async (): Promise<OrderPipelineConfig> => {
    const res = await fetch(
      `${getFunctionsApiUrl()}/api/orders/pipeline/config`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Pipeline config GET HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };

export const saveOrderPipelineConfig = async (
  config: OrderPipelineConfig,
): Promise<OrderPipelineConfig> => {
  const res = await fetch(
    `${getFunctionsApiUrl()}/api/orders/pipeline/config`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Pipeline config PUT HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
};

export const getOrderPipelineStatus =
  async (): Promise<OrderPipelineStatus> => {
    const res = await fetch(
      `${getFunctionsApiUrl()}/api/orders/pipeline/status`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Pipeline status GET HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };

export const promoteOrdersPendingToApproved =
  async (): Promise<OrderPipelinePromoteResult> => {
    const res = await fetch(
      `${getFunctionsApiUrl()}/api/orders/pipeline/promote-pending`,
      { method: "POST" },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Promote pending HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };

export const promoteOrdersApprovedToShipped =
  async (): Promise<OrderPipelinePromoteResult> => {
    const res = await fetch(
      `${getFunctionsApiUrl()}/api/orders/pipeline/promote-approved`,
      { method: "POST" },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Promote approved HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };

// ── Review AI Analysis ─────────────────────────────────────────────────────

export interface ReviewAnalysisInput {
  productReviewId: number;
  rating: number;
  comments: string;
  reviewerName: string;
  productName: string;
}

export interface ReviewAnalysisResult {
  productReviewId: number;
  sentiment: "positive" | "neutral" | "negative";
  flags: string[];
  suggestedResponse: string | null;
  error?: string;
}

/**
 * Analyses reviews for sentiment, flags, and suggested responses.
 * Automatically splits into batches of 50 (API max) and merges results.
 */
export const analyzeReviewsBatch = async (
  reviews: ReviewAnalysisInput[],
  onProgress?: (completed: number, total: number) => void,
): Promise<ReviewAnalysisResult[]> => {
  const BATCH_SIZE = 50;
  const results: ReviewAnalysisResult[] = [];
  const totalBatches = Math.ceil(reviews.length / BATCH_SIZE);

  for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
    const batch = reviews.slice(i, i + BATCH_SIZE);
    const res = await fetch(
      `${getFunctionsApiUrl()}/api/reviews/analyze-batch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviews: batch }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Review analysis HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    const data: { analyses: ReviewAnalysisResult[] } = await res.json();
    results.push(...data.analyses);
    onProgress?.(Math.min(i + BATCH_SIZE, reviews.length), reviews.length);
  }

  return results;
};

// ── Review Moderation Background Job ──────────────────────────────────────

export interface ReviewModerationJobState {
  isRunning: boolean;
  jobId: string;
  queuedCount: number;
  processedCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  startedAt: string | null;
  lastProgressAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface StartReviewModerationResponse {
  started: boolean;
  message: string;
  state: ReviewModerationJobState;
  error?: string;
  httpStatus: number;
}

export const startReviewModerationAnalyzeApproveAll =
  async (): Promise<StartReviewModerationResponse> => {
    const res = await fetch(
      `${getFunctionsApiUrl()}/api/reviews/moderation/start-analyze-approve-all`,
      {
        method: "POST",
      },
    );

    const data = (await res.json().catch(() => ({}))) as Omit<
      StartReviewModerationResponse,
      "httpStatus"
    >;

    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Review moderation start HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }

    return {
      started: data.started ?? false,
      message: data.message ?? (data.error || "Unknown response"),
      state: data.state ?? {
        isRunning: false,
        jobId: "",
        queuedCount: 0,
        processedCount: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        startedAt: null,
        lastProgressAt: null,
        completedAt: null,
        lastError: null,
      },
      error: data.error,
      httpStatus: res.status,
    };
  };

export const getReviewModerationStatus =
  async (): Promise<ReviewModerationJobState> => {
    const res = await fetch(
      `${getFunctionsApiUrl()}/api/reviews/moderation/status`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Review moderation status HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    return res.json();
  };
