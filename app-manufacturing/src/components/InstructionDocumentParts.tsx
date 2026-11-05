import { useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { illustrationUrl } from '@/lib/manufacturingInstructions';
import type { ManufacturingInstructions } from '@/lib/manufacturingInstructions';
import { generatedIntroduction } from '@/lib/generatedManufacturingContent';
import type { GeneratedFigure, GeneratedHistory } from '@/lib/generatedManufacturingContent';
import ManufacturingComponentLegend from '@/components/ManufacturingComponentLegend';
import ManufacturingLogo from '@/components/ManufacturingLogo';
import type { Location } from '@/types/production';

export function Illustration({ id, content }: { id: number; content?: GeneratedFigure }) {
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
        Illustration {id}{content && `: ${content.title}`}{!failed && <span className="print:hidden"> - Click to enlarge</span>}
      </figcaption>
      {content && <div className="mt-4 space-y-3">
        <h3 className="font-semibold">Operation guidance</h3>
        {content.guidance.map((text, index) => <p key={index} className="text-sm leading-relaxed">{text}</p>)}
        <ManufacturingComponentLegend callouts={content.callouts} />
      </div>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl bg-white">
          <DialogHeader><DialogTitle>Illustration {id}</DialogTitle>
            <DialogDescription>{content?.title ?? 'Assembly drawing at an enlarged scale.'}</DialogDescription>
          </DialogHeader>
          <img src={illustrationUrl(id)} alt={`Assembly illustration ${id}, enlarged`} className="max-h-[75vh] w-full object-contain" />
        </DialogContent>
      </Dialog>
    </figure>
  );
}

export function InstructionPrintStyles() {
  return <style>{`@media print {
    body { background: white !important; }
    header, footer, [role="status"], [data-sonner-toaster] { display: none !important; }
    .instruction-document { max-width: none !important; padding: 0 !important; }
    .instruction-document section { box-shadow: none !important; }
    .instruction-document .document-footer { display: block !important; }
    .instruction-document #change-history table { min-width: 0; font-size: 8pt; }
    .instruction-document #change-history td { min-width: 0; white-space: normal; padding: 4px; }
  }`}</style>;
}

export function InstructionBrandHeader() {
  return <div className="flex items-center gap-3 border-b-4 border-blue-600 pb-6">
    <ManufacturingLogo className="h-14 w-14" />
    <div><p className="text-2xl font-extrabold tracking-tight">Adventure<span className="text-blue-600">Works</span></p>
      <p className="text-xs uppercase tracking-widest text-muted-foreground">Manufacturing Hub</p></div>
  </div>;
}

export function WorkCenterNavigation({ document }: { document: ManufacturingInstructions }) {
  if (document.locations.length === 0) return null;
  return <nav aria-label="Instruction work centers" className="flex flex-wrap gap-3 print:hidden">
    {document.locations.map(center => <a key={center.id} href={`#work-center-${center.id}`}
      className="doodle-button text-sm">Work Center {center.id}</a>)}
  </nav>;
}

interface LocationSectionsProps {
  document: ManufacturingInstructions;
  centers?: Location[];
  figures?: Record<string, GeneratedFigure>;
  generated: boolean;
  workCenterId?: number;
  centerNote?: (centerId: number) => ReactNode;
}

export function InstructionLocationSections({ document, centers, figures, generated, workCenterId, centerNote }: LocationSectionsProps) {
  return <>{document.locations.filter(center => workCenterId === undefined || center.id === workCenterId).map(center => {
    const name = centers?.find(c => c.LocationID === center.id)?.Name;
    return (
      <section key={center.id} id={`work-center-${center.id}`} className="doodle-card-static scroll-mt-24 p-6">
        <h2 className="font-doodle text-xl font-bold">Work Center {center.id}{name ? ` - ${name}` : ''}</h2>
        {centerNote?.(center.id)}
        <dl className="my-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {([['Setup', center.setupHours], ['Labor', center.laborHours], ['Machine', center.machineHours], ['Lot size', center.lotSize]] as const)
            .map(([label, value]) => value === undefined ? null : (
              <div key={label}><dt className="inline text-muted-foreground">{label}: </dt>
                <dd className="inline font-semibold">{value}{label !== 'Lot size' ? ' h' : ''}</dd></div>
            ))}
        </dl>
        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{generated ? generatedIntroduction(center.introduction) : center.introduction}</p>
        <ol className="list-decimal space-y-5 pl-6">
          {center.steps.map((parts, index) => (
            <li key={index} className="pl-2 leading-relaxed">
              <p>{parts.map((part, i) => part.kind === 'text' ? part.text :
                part.kind === 'diag' ? <a key={i} href={`#figure-${center.id}-${index}-${part.text}`} className="text-doodle-blue underline">{part.text}</a> :
                <strong key={i} title={part.kind} className={part.kind === 'tool' ? 'text-doodle-blue' : ''}>{part.text}</strong>)}</p>
              {Array.from(new Set<string>(parts.filter(part => part.kind === 'diag').map(part => part.text))).map(figure => (
                <div key={figure} id={`figure-${center.id}-${index}-${figure}`}><Illustration id={Number(figure)} content={figures?.[figure]} /></div>
              ))}
            </li>
          ))}
        </ol>
      </section>
    );
  })}</>;
}

export function InstructionChangeHistory({ history }: { history: GeneratedHistory }) {
  return <section id="change-history" className="doodle-card-static space-y-4 p-6">
    <h2 className="text-xl font-bold">Document change management history</h2>
    <p><strong>Document:</strong> {history.documentNumber} · <strong>Current revision:</strong>{' '}
      {history.revisions.at(-1)?.revision} · <strong>Owner:</strong> Manufacturing Engineering</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
      <thead><tr>{['Revision', 'Effective date', 'Change request', 'Description of change', 'Prepared by', 'Approved by']
        .map(label => <th key={label} className="whitespace-nowrap border-b p-3">{label}</th>)}</tr></thead>
      <tbody>{history.revisions.map(revision => <tr key={revision.revision}>
        <td className="border-b p-3 align-top">{revision.revision}</td>
        <td className="whitespace-nowrap border-b p-3 align-top"><time dateTime={revision.effectiveDate}>{revision.effectiveDate}</time></td>
        <td className="whitespace-nowrap border-b p-3 align-top">{revision.changeRequest}</td>
        <td className="min-w-80 border-b p-3 align-top">{revision.description}</td>
        <td className="whitespace-nowrap border-b p-3 align-top">{revision.preparedBy}</td>
        <td className="whitespace-nowrap border-b p-3 align-top">{revision.approvedBy}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
