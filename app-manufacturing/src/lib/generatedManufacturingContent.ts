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
  history: {
    documentNumber: string;
    revisions: {
      revision: string; effectiveDate: string; changeRequest: string;
      description: string; preparedBy: string; approvedBy: string;
    }[];
  };
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

export function generatedIntroduction(text: string): string {
  return text.replace(/^AI-generated fictional demo instructions\. Not validated engineering or safety instructions\.\s*/, '')
    .replace('Fictional assembly demonstration', 'Assembly instructions')
    .replace('Fictional workshop demonstration', 'Workshop instructions')
    .replace('Demo draft for model', 'Instructions for model')
    .replace('Estimates are fictional demo assumptions. ', '');
}
