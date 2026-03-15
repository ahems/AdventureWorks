// Mock Utility Service for Admin Functions
// Simulates Azure Durable Functions API responses

export interface OrchestrationStatus {
  instanceId: string;
  status: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Terminated';
  runtimeStatus: string;
  customStatus?: string;
  input?: any;
  output?: any;
  createdTime: string;
  lastUpdatedTime: string;
  progress?: number;
  message?: string;
}

export interface DurableFunctionResponse {
  id: string;
  statusQueryGetUri: string;
  sendEventPostUri: string;
  terminatePostUri: string;
  purgeHistoryDeleteUri: string;
}

// Simulated orchestration instances storage
const orchestrationInstances = new Map<string, OrchestrationStatus>();

const generateInstanceId = () => {
  return `orch-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};

const simulateProgress = (instanceId: string, totalSteps: number, stepDuration: number) => {
  let currentStep = 0;
  const interval = setInterval(() => {
    currentStep++;
    const instance = orchestrationInstances.get(instanceId);
    if (instance) {
      const progress = Math.min((currentStep / totalSteps) * 100, 100);
      instance.progress = progress;
      instance.lastUpdatedTime = new Date().toISOString();
      
      if (progress >= 100) {
        instance.status = 'Completed';
        instance.runtimeStatus = 'Completed';
        instance.message = 'Operation completed successfully';
        clearInterval(interval);
      } else {
        instance.message = `Processing step ${currentStep} of ${totalSteps}...`;
      }
      orchestrationInstances.set(instanceId, instance);
    } else {
      clearInterval(interval);
    }
  }, stepDuration);
};

// Embellish Product Descriptions
export const embellishProductDescriptions = async (productIds?: number[]): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: { ProductIds: productIds },
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: 'Starting AI enhancement of product descriptions...',
  };
  
  orchestrationInstances.set(instanceId, instance);
  simulateProgress(instanceId, productIds?.length || 50, 200);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Generate Product Embeddings
export const generateProductEmbeddings = async (): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: {},
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: 'Generating vector embeddings for product catalog...',
  };
  
  orchestrationInstances.set(instanceId, instance);
  simulateProgress(instanceId, 100, 100);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Generate Review Embeddings
export const generateReviewEmbeddings = async (): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: {},
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: 'Generating vector embeddings for product reviews...',
  };
  
  orchestrationInstances.set(instanceId, instance);
  simulateProgress(instanceId, 75, 150);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Translate Product Descriptions
export const translateProductDescriptions = async (productModelIds?: number[]): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: productModelIds,
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: 'Translating product descriptions to supported languages...',
  };
  
  orchestrationInstances.set(instanceId, instance);
  simulateProgress(instanceId, 120, 150);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Translate Language File
export const translateLanguageFile = async (targetLanguage: string, sourceContent: string): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: { targetLanguage, contentSize: sourceContent.length },
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: `Translating language file to ${targetLanguage}...`,
    output: null,
  };
  
  orchestrationInstances.set(instanceId, instance);
  
  // Simulate translation with mock output
  setTimeout(() => {
    const inst = orchestrationInstances.get(instanceId);
    if (inst) {
      inst.progress = 100;
      inst.status = 'Completed';
      inst.runtimeStatus = 'Completed';
      inst.message = 'Translation completed';
      inst.output = {
        translatedContent: `{"greeting": "Translated to ${targetLanguage}"}`,
        targetLanguage,
      };
      orchestrationInstances.set(instanceId, inst);
    }
  }, 3000);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Generate Product Images
export const generateProductImages = async (productIds?: number[]): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: { ProductIds: productIds },
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: 'Generating AI images using DALL-E...',
  };
  
  orchestrationInstances.set(instanceId, instance);
  simulateProgress(instanceId, productIds?.length || 25, 400);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Generate Product Thumbnails
export const generateProductThumbnails = async (): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: {},
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: 'Regenerating product thumbnails...',
  };
  
  orchestrationInstances.set(instanceId, instance);
  simulateProgress(instanceId, 60, 100);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Generate Product Reviews
export const generateProductReviews = async (productIds?: number[], reviewsPerProduct?: number): Promise<DurableFunctionResponse> => {
  const instanceId = generateInstanceId();
  const now = new Date().toISOString();
  
  const instance: OrchestrationStatus = {
    instanceId,
    status: 'Running',
    runtimeStatus: 'Running',
    input: { ProductIds: productIds, ReviewsPerProduct: reviewsPerProduct },
    createdTime: now,
    lastUpdatedTime: now,
    progress: 0,
    message: 'Generating AI product reviews with varied sentiment...',
  };
  
  orchestrationInstances.set(instanceId, instance);
  simulateProgress(instanceId, productIds?.length || 40, 250);
  
  return {
    id: instanceId,
    statusQueryGetUri: `/api/status/${instanceId}`,
    sendEventPostUri: `/api/event/${instanceId}`,
    terminatePostUri: `/api/terminate/${instanceId}`,
    purgeHistoryDeleteUri: `/api/purge/${instanceId}`,
  };
};

// Get Orchestration Status
export const getOrchestrationStatus = (instanceId: string): OrchestrationStatus | null => {
  return orchestrationInstances.get(instanceId) || null;
};

// Terminate Orchestration
export const terminateOrchestration = (instanceId: string): boolean => {
  const instance = orchestrationInstances.get(instanceId);
  if (instance && instance.status === 'Running') {
    instance.status = 'Terminated';
    instance.runtimeStatus = 'Terminated';
    instance.message = 'Operation was terminated by user';
    instance.lastUpdatedTime = new Date().toISOString();
    orchestrationInstances.set(instanceId, instance);
    return true;
  }
  return false;
};

// Utility Stats Interface
export interface UtilityStats {
  totalProducts: number;
  productsWithEmbeddings: number;
  totalEmbeddings: number;
  reviewEmbeddings: number;
  totalTranslations: number;
  languagesCovered: number;
  aiGeneratedImages: number;
  thumbnailsGenerated: number;
  totalReviews: number;
  aiGeneratedReviews: number;
  averageRating: number;
  lastExecutions: {
    embeddings: string | null;
    translations: string | null;
    imageGeneration: string | null;
    reviewGeneration: string | null;
  };
  recentExecutions: Array<{
    name: string;
    time: string;
    status: 'success' | 'failed' | 'running';
  }>;
}

// Get mock utility stats
export const getUtilityStats = (): UtilityStats => {
  const now = new Date();
  return {
    totalProducts: 295,
    productsWithEmbeddings: 248,
    totalEmbeddings: 1847,
    reviewEmbeddings: 3256,
    totalTranslations: 4720,
    languagesCovered: 16,
    aiGeneratedImages: 189,
    thumbnailsGenerated: 567,
    totalReviews: 1423,
    aiGeneratedReviews: 892,
    averageRating: 4.2,
    lastExecutions: {
      embeddings: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      translations: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
      imageGeneration: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
      reviewGeneration: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    },
    recentExecutions: [
      { name: 'Product Embeddings', time: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), status: 'success' },
      { name: 'Translate ES', time: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(), status: 'success' },
      { name: 'Generate Images', time: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), status: 'failed' },
    ],
  };
};

// Supported languages for translation
export const supportedLanguages = [
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-cht', name: 'Chinese (Traditional)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he', name: 'Hebrew' },
  { code: 'tr', name: 'Turkish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
  { code: 'en-gb', name: 'English (UK)' },
  { code: 'en-ca', name: 'English (Canada)' },
  { code: 'en-au', name: 'English (Australia)' },
  { code: 'en-nz', name: 'English (New Zealand)' },
  { code: 'en-ie', name: 'English (Ireland)' },
];
