import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { fetchProductModel, fetchLocations } from '@/services/api';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { illustrationUrl, parseManufacturingInstructions } from '@/lib/manufacturingInstructions';
import type { ManufacturingInstructions } from '@/lib/manufacturingInstructions';

function Illustration({ id }: { id: number }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <figure className="my-4 rounded border border-doodle-text/20 bg-white p-4 break-inside-avoid">
      {failed ? <p role="alert" className="text-sm text-destructive">Illustration {id} is unavailable. The instruction text remains available above.</p> : (
        <button onClick={() => setOpen(true)} className="block w-full" aria-label={`Enlarge illustration ${id}`}>
          <img src={illustrationUrl(id)} alt={`Assembly illustration ${id}`}
            className="mx-auto max-h-80 w-full object-contain" onError={() => setFailed(true)} />
        </button>
      )}
      <figcaption className="mt-3 text-center text-sm text-muted-foreground">
        Illustration {id}{!failed && <span className="print:hidden"> - Click to enlarge</span>}
      </figcaption>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl bg-white">
          <DialogHeader><DialogTitle>Illustration {id}</DialogTitle>
            <DialogDescription>Original assembly drawing at an enlarged scale.</DialogDescription>
          </DialogHeader>
          <img src={illustrationUrl(id)} alt={`Assembly illustration ${id}, enlarged`} className="max-h-[75vh] w-full object-contain" />
        </DialogContent>
      </Dialog>
    </figure>
  );
}

export default function ModelInstructions() {
  const { id } = useParams();
  const modelId = Number(id);
  const location = useLocation();
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
  useEffect(() => {
    if (parsed?.document && /^#work-center-\d+$/.test(location.hash)) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
    }
  }, [parsed, location.hash]);

  if (validId && model.isLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;
  return (
    <div className="instruction-document container mx-auto max-w-5xl space-y-6 px-4 py-8">
      <style>{`@media print {
        body { background: white !important; }
        header, footer, [role="status"], [data-sonner-toaster] { display: none !important; }
        .instruction-document { max-width: none !important; padding: 0 !important; }
        .instruction-document section { box-shadow: none !important; }
      }`}</style>
      <Link to={validId ? `/define/models/${modelId}` : '/define/models'}
        className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline print:hidden">
        <ArrowLeft className="h-4 w-4" /> Back to Model
      </Link>
      {model.isError ? (
        <div role="alert" className="doodle-card-static p-6 text-destructive">
          Could not load manufacturing instructions: {model.error.message}
        </div>
      ) : !validId || !model.data ? (
        <p className="doodle-card-static p-6">Product model not found.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-doodle text-2xl font-bold">{model.data.Name}</h1>
              <p className="text-muted-foreground">Manufacturing Instructions - Model {modelId}</p>
            </div>
            {parsed?.document && <button onClick={() => window.print()} className="doodle-button inline-flex items-center gap-2 print:hidden">
              <Printer className="h-4 w-4" /> Print
            </button>}
          </div>
          {!parsed ? <p className="doodle-card-static p-6">No manufacturing instructions are available for this model yet.</p> :
            parsed.error ? <p role="alert" className="doodle-card-static p-6 text-destructive">{parsed.error}</p> :
            parsed.document && (
              <>
                <section className="doodle-card-static p-6">
                  <h2 className="mb-3 font-doodle text-lg font-bold">Overview</h2>
                  <p className="whitespace-pre-wrap leading-relaxed">{parsed.document.introduction}</p>
                </section>
                {parsed.document.locations.length > 0 && (
                  <nav aria-label="Instruction work centers" className="flex flex-wrap gap-3 print:hidden">
                    {parsed.document.locations.map(center => <a key={center.id} href={`#work-center-${center.id}`}
                      className="doodle-button text-sm">Work Center {center.id}</a>)}
                  </nav>
                )}
                {centers.isError && <p role="alert" className="text-sm text-destructive">Work center names could not be loaded; source instructions are shown below.</p>}
                {parsed.document.locations.map(center => (
                  <section key={center.id} id={`work-center-${center.id}`} className="doodle-card-static scroll-mt-24 p-6">
                    <h2 className="font-doodle text-xl font-bold">
                      Work Center {center.id}{centers.data?.find(c => c.LocationID === center.id)?.Name
                        ? ` - ${centers.data.find(c => c.LocationID === center.id)!.Name}` : ''}
                    </h2>
                    <dl className="my-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                      {([['Setup', center.setupHours], ['Labor', center.laborHours], ['Machine', center.machineHours], ['Lot size', center.lotSize]] as const)
                        .map(([label, value]) => value === undefined ? null : (
                          <div key={label}><dt className="inline text-muted-foreground">{label}: </dt>
                            <dd className="inline font-semibold">{value}{label !== 'Lot size' ? ' h' : ''}</dd></div>
                        ))}
                    </dl>
                    <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{center.introduction}</p>
                    <ol className="list-decimal space-y-5 pl-6">
                      {center.steps.map((parts, index) => (
                        <li key={index} className="pl-2 leading-relaxed">
                          <p>{parts.map((part, i) => part.kind === 'text' ? part.text :
                            part.kind === 'diag' ? <a key={i} href={`#figure-${center.id}-${index}-${part.text}`} className="text-doodle-blue underline">{part.text}</a> :
                            <strong key={i} title={part.kind} className={part.kind === 'tool' ? 'text-doodle-blue' : ''}>{part.text}</strong>)}</p>
                          {Array.from(new Set<string>(parts.filter(part => part.kind === 'diag').map(part => part.text))).map(figure => (
                            <div key={figure} id={`figure-${center.id}-${index}-${figure}`}><Illustration id={Number(figure)} /></div>
                          ))}
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </>
            )}
        </>
      )}
    </div>
  );
}
