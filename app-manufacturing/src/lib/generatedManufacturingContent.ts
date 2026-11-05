import { parseManufacturingInstructions } from './manufacturingInstructions';
import type { ManufacturingInstructions } from './manufacturingInstructions';

export interface GeneratedFigure {
  title: string;
  guidance: string[];
  callouts: { number: number; name: string; productNumber: string }[];
}

export interface GeneratedDocument {
  modelId: number;
  sourceInstructions: string;
  processNotes: string[];
  variantNotes: string[];
  figures: Record<string, GeneratedFigure>;
  supplementalFigures?: boolean;
  history: GeneratedHistory;
}

export interface GeneratedHistory {
  documentNumber: string;
  lifecycleSource?: { ProductID: number };
  revisions: {
    revision: string; effectiveDate: string; changeRequest: string;
    description: string; preparedBy: string; approvedBy: string;
  }[];
}

export interface GeneratedPartDocument {
  productId: number;
  name: string;
  productNumber: string;
  documentNode: string;
  title: string;
  sourceInstructions: string;
  routingBasis: 'historical' | 'demo-assumption';
  processNotes: string[];
  variantNotes: string[];
  figures: Record<string, GeneratedFigure>;
  history: GeneratedHistory;
  whereUsed: {
    productId: number; name: string; productNumber: string;
    productModelId: number | null; productModelName: string | null; quantity: number; unit: string;
  }[];
  whereUsedCount: number;
}

const documents = import.meta.glob<GeneratedDocument>('../data/manufacturing/model-*.json', {
  eager: true, import: 'default',
});

export function generatedDocument(modelId: number, live: ManufacturingInstructions): GeneratedDocument | undefined {
  const document = documents[`../data/manufacturing/model-${modelId}.json`];
  if (!document) return undefined;
  // SQL's typed XML may change prefixes/whitespace; bind metadata to the parsed content, not serialization.
  return JSON.stringify(parseManufacturingInstructions(document.sourceInstructions)) === JSON.stringify(live)
    ? document : undefined;
}

const partDocuments = import.meta.glob<GeneratedPartDocument>('../data/manufacturing/part-*.json', {
  eager: true, import: 'default',
});

export function hasGeneratedPartSheet(productId: number): boolean {
  return `../data/manufacturing/part-${productId}.json` in partDocuments;
}

export function generatedPartDocument(productId: number): GeneratedPartDocument | undefined {
  return partDocuments[`../data/manufacturing/part-${productId}.json`];
}

export function matchesGeneratedPart(document: GeneratedPartDocument, live: ManufacturingInstructions): boolean {
  return JSON.stringify(parseManufacturingInstructions(document.sourceInstructions)) === JSON.stringify(live);
}

export function generatedIntroduction(text: string): string {
  return text.replace(/^AI-generated fictional demo instructions\. Not validated engineering or safety instructions\.\s*/, '')
    .replace('Fictional assembly demonstration', 'Assembly instructions')
    .replace('Fictional workshop demonstration', 'Workshop instructions')
    .replace('Demo draft for model', 'Instructions for model')
    .replace('Estimates are fictional demo assumptions. ', '')
    .replace(/Demo assumption: this part has no historical routing, so this existing work centre was assigned for demonstration only\.\s*/, '')
    .replace(/\bFictional (?:shop-floor )?(?:demonstration|part sheet)\b/, 'Shop-floor instructions');
}
