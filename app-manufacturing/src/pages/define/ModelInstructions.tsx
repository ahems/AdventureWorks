import { useEffect, useMemo } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { fetchProductModel, fetchLocations } from '@/services/api';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import { parseManufacturingInstructions } from '@/lib/manufacturingInstructions';
import type { ManufacturingInstructions } from '@/lib/manufacturingInstructions';
import { generatedDocument, generatedIntroduction } from '@/lib/generatedManufacturingContent';
import {
  Illustration, InstructionBrandHeader, InstructionChangeHistory, InstructionLocationSections,
  InstructionPrintStyles, WorkCenterNavigation,
} from '@/components/InstructionDocumentParts';
import InstructionProductContext from '@/components/InstructionProductContext';

interface Props {
  modelId?: number;
  workCenterId?: number;
  embedded?: boolean;
  productId?: number;
}

export default function ModelInstructions({ modelId: suppliedModelId, workCenterId, embedded = false, productId }: Props) {
  const { id } = useParams();
  const modelId = suppliedModelId ?? Number(id);
  const location = useLocation();
  const requestedProduct = new URLSearchParams(location.search).get('productId');
  const selectedProductId = productId ?? (requestedProduct !== null ? Number(requestedProduct) : undefined);
  const validId = Number.isSafeInteger(modelId) && modelId > 0;
  const model = useQuery({
    queryKey: ['product-model', modelId], queryFn: () => fetchProductModel(modelId), enabled: validId,
  });
  const centers = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });
  const parsed = useMemo<{ document: ManufacturingInstructions | null; error: string | null } | null>(() => {
    if (!model.data?.Instructions?.trim()) return null;
    try {
      return { document: parseManufacturingInstructions(model.data.Instructions), error: null };
    } catch (error) {
      return { document: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [model.data?.Instructions]);
  const generated = useMemo(() => parsed?.document ? generatedDocument(modelId, parsed.document) : undefined, [modelId, parsed]);
  useEffect(() => {
    if (!embedded && parsed?.document && /^#work-center-\d+$/.test(location.hash)) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
    }
  }, [parsed, location.hash, embedded]);

  if (validId && model.isLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;
  return (
    <div className="instruction-document container mx-auto max-w-5xl space-y-6 px-4 py-8">
      <InstructionPrintStyles />
      {!embedded && <Link to={validId ? `/define/models/${modelId}` : '/define/models'}
        className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline print:hidden">
        <ArrowLeft className="h-4 w-4" /> Back to Model
      </Link>}
      {model.isError ? (
        <div role="alert" className="doodle-card-static p-6 text-destructive">
          Could not load manufacturing instructions: {model.error.message}
        </div>
      ) : !validId || !model.data ? (
        <p className="doodle-card-static p-6">Product model not found.</p>
      ) : (
        <>
          {!embedded && generated && <InstructionBrandHeader />}
          {!embedded && <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-doodle text-2xl font-bold">{model.data.Name}</h1>
              <p className="text-muted-foreground">Manufacturing Instructions - Model {modelId}</p>
            </div>
            {parsed?.document && <button onClick={() => window.print()} className="doodle-button inline-flex items-center gap-2 print:hidden">
              <Printer className="h-4 w-4" /> Print
            </button>}
          </div>}
          {selectedProductId !== undefined && <InstructionProductContext productId={selectedProductId} modelId={modelId}
            representativeId={generated?.history.lifecycleSource?.ProductID} />}
          {!parsed ? <p className="doodle-card-static p-6">No manufacturing instructions are available for this model yet.</p> :
            parsed.error ? <p role="alert" className="doodle-card-static p-6 text-destructive">{parsed.error}</p> :
            parsed.document && (
              <>
                {!embedded && <section className="doodle-card-static p-6">
                  <h2 className="mb-3 font-doodle text-lg font-bold">Overview</h2>
                  <p className="whitespace-pre-wrap leading-relaxed">{generated ? generatedIntroduction(parsed.document.introduction) : parsed.document.introduction}</p>
                </section>}
                {!embedded && generated && <section className="doodle-card-static space-y-4 p-6">
                  <h2 className="text-lg font-bold">Process notes and estimates</h2>
                  <ul className="list-disc space-y-2 pl-6">{generated.processNotes.map((text, index) => <li key={index}>{text}</li>)}</ul>
                  <h2 className="text-lg font-bold">Variant notes</h2>
                  <ul className="list-disc space-y-2 pl-6">{generated.variantNotes.map((text, index) => <li key={index}>{text}</li>)}</ul>
                </section>}
                {!embedded && <WorkCenterNavigation document={parsed.document} />}
                {centers.isError && <p role="alert" className="text-sm text-destructive">Work center names could not be loaded; source instructions are shown below.</p>}
                {embedded && !parsed.document.locations.some(center => center.id === workCenterId) &&
                  <p className="doodle-card-static p-6">No instruction section matches this work center. Open the full document for available guidance.</p>}
                <InstructionLocationSections document={parsed.document} centers={centers.data} figures={generated?.figures}
                  generated={!!generated} workCenterId={embedded ? workCenterId : undefined} />
                {generated?.supplementalFigures && <section className="doodle-card-static space-y-4 p-6">
                  <h2 className="text-xl font-bold">Assembly illustrations</h2>
                  {Object.entries(generated.figures).map(([id, content]) => <Illustration key={id} id={Number(id)} content={content} />)}
                </section>}
                {!embedded && generated && <>
                  <InstructionChangeHistory history={generated.history} />
                  <footer className="document-footer border-t py-6 text-sm text-muted-foreground">
                    AdventureWorks · Manufacturing Engineering · {model.data.Name} · Model {modelId}
                  </footer>
                </>}
              </>
            )}
        </>
      )}
    </div>
  );
}
