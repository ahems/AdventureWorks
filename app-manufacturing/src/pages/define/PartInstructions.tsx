import { useEffect, useMemo } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { fetchLocations, fetchPartDocuments } from '@/services/api';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import { parseManufacturingInstructions } from '@/lib/manufacturingInstructions';
import type { ManufacturingInstructions } from '@/lib/manufacturingInstructions';
import { generatedIntroduction, generatedPartDocument, matchesGeneratedPart } from '@/lib/generatedManufacturingContent';
import {
  InstructionBrandHeader, InstructionChangeHistory, InstructionLocationSections, InstructionPrintStyles, WorkCenterNavigation,
} from '@/components/InstructionDocumentParts';

const STATUS: Record<number, string> = { 1: 'Pending approval', 2: 'Approved', 3: 'Obsolete' };

function DemoAssumptionBadge() {
  return <p className="mt-2 inline-block rounded border border-amber-400 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">
    Demo assumption - no historical routing exists for this part; work centre assigned for demonstration only
  </p>;
}

interface Props {
  productId?: number;
  workCenterId?: number;
  embedded?: boolean;
}

export default function PartInstructions({ productId: suppliedProductId, workCenterId, embedded = false }: Props) {
  const { id } = useParams();
  const location = useLocation();
  const productId = suppliedProductId ?? Number(id);
  const validId = Number.isSafeInteger(productId) && productId > 0;
  const documents = useQuery({
    queryKey: ['part-documents', productId], queryFn: ({ signal }) => fetchPartDocuments(productId, signal), enabled: validId,
  });
  const centers = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });
  const sheet = documents.data?.find(document => document.generated && document.instructionsXml);
  const otherDocuments = documents.data?.filter(document => document !== sheet) ?? [];
  const parsed = useMemo<{ document: ManufacturingInstructions | null; error: string | null } | null>(() => {
    if (!sheet?.instructionsXml) return null;
    try {
      return { document: parseManufacturingInstructions(sheet.instructionsXml), error: null };
    } catch (error) {
      return { document: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [sheet?.instructionsXml]);
  const bundled = validId ? generatedPartDocument(productId) : undefined;
  const generated = bundled && parsed?.document && matchesGeneratedPart(bundled, parsed.document) ? bundled : undefined;
  const demoAssumption = generated?.routingBasis === 'demo-assumption';
  useEffect(() => {
    if (!embedded && parsed?.document && /^#work-center-\d+$/.test(location.hash)) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
    }
  }, [parsed, location.hash, embedded]);

  if (validId && documents.isLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;
  const name = generated ? `${generated.name} (${generated.productNumber})` : `Product ${productId}`;
  return (
    <div className="instruction-document container mx-auto max-w-5xl space-y-6 px-4 py-8">
      <InstructionPrintStyles />
      {!embedded && <Link to={validId ? `/define/products/${productId}` : '/define/products'}
        className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline print:hidden">
        <ArrowLeft className="h-4 w-4" /> Back to Product
      </Link>}
      {!validId ? <p className="doodle-card-static p-6">Product not found.</p> :
        documents.isError ? <div role="alert" className="doodle-card-static p-6 text-destructive">
          Could not load the part sheet: {documents.error.message}
        </div> : <>
          {!embedded && generated && <InstructionBrandHeader />}
          {!embedded && <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-doodle text-2xl font-bold">{sheet?.title ?? 'Part sheet'}</h1>
              <p className="text-muted-foreground">
                Part Sheet - <Link className="text-doodle-blue underline print:text-inherit print:no-underline" to={`/define/products/${productId}`}>{name}</Link>
                {sheet && <> · Revision {sheet.revision} · {STATUS[sheet.status] ?? `Status ${sheet.status}`}</>}
              </p>
              {demoAssumption && <DemoAssumptionBadge />}
            </div>
            {parsed?.document && <button onClick={() => window.print()} className="doodle-button inline-flex items-center gap-2 print:hidden">
              <Printer className="h-4 w-4" /> Print
            </button>}
          </div>}
          {!sheet ? <p className="doodle-card-static p-6">No part sheet is available for this product yet.</p> :
            parsed?.error ? <p role="alert" className="doodle-card-static p-6 text-destructive">{parsed.error}</p> :
            parsed?.document && <>
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
                <p className="doodle-card-static p-6">No part-sheet section matches this work center. Open the full part sheet for available guidance.</p>}
              <InstructionLocationSections document={parsed.document} centers={centers.data} figures={generated?.figures}
                generated={!!generated} workCenterId={embedded ? workCenterId : undefined}
                centerNote={demoAssumption ? () => <DemoAssumptionBadge /> : undefined} />
              {!embedded && generated && generated.whereUsed.length > 0 && <section className="doodle-card-static space-y-3 p-6">
                <h2 className="text-xl font-bold">Where used</h2>
                <p className="text-sm text-muted-foreground">
                  Current bills of materials that consume this part{generated.whereUsedCount > generated.whereUsed.length
                    ? ` (showing ${generated.whereUsed.length} of ${generated.whereUsedCount})` : ''}.
                </p>
                <ul className="space-y-2 text-sm">{generated.whereUsed.map(parent => <li key={parent.productId}>
                  <Link className="text-doodle-blue underline print:text-inherit print:no-underline" to={`/define/products/${parent.productId}`}>
                    {parent.name} ({parent.productNumber})</Link> · {parent.quantity} {parent.unit}
                  {parent.productModelId !== null && <> · <Link className="text-doodle-blue underline print:hidden"
                    to={`/define/models/${parent.productModelId}/instructions?productId=${parent.productId}`}>Model instructions</Link></>}
                </li>)}</ul>
              </section>}
              {!embedded && generated && <InstructionChangeHistory history={generated.history} />}
            </>}
          {!embedded && otherDocuments.length > 0 && <section className="doodle-card-static space-y-3 p-6">
            <h2 className="text-lg font-bold">Other linked documents</h2>
            <ul className="space-y-1 text-sm">{otherDocuments.map(document => <li key={document.documentNode}>
              {document.title} · {document.fileName} · Revision {document.revision} · {STATUS[document.status] ?? `Status ${document.status}`}
            </li>)}</ul>
          </section>}
          {!embedded && generated && <footer className="document-footer border-t py-6 text-sm text-muted-foreground">
            AdventureWorks · Manufacturing Engineering · {generated.history.documentNumber} · {name}
          </footer>}
        </>}
    </div>
  );
}
