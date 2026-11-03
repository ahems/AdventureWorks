const namespace = 'http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions';

export interface InstructionPart {
  text: string;
  kind: 'text' | 'material' | 'tool' | 'specs' | 'blueprint' | 'diag';
}

export interface InstructionLocation {
  id: number;
  introduction: string;
  setupHours?: number;
  laborHours?: number;
  machineHours?: number;
  lotSize?: number;
  steps: InstructionPart[][];
}

export interface ManufacturingInstructions {
  introduction: string;
  locations: InstructionLocation[];
}

export function parseManufacturingInstructions(xml: string): ManufacturingInstructions {
  if (!xml.trim().startsWith('<')) {
    return { introduction: xml.trim(), locations: [] };
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Document type declarations are not supported.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Manufacturing instructions contain invalid XML.');
  const root = document.documentElement;
  if (root.localName !== 'root' || root.namespaceURI !== namespace) {
    throw new Error('Unsupported manufacturing instruction format.');
  }
  const ownText = (element: Element) => Array.from(element.childNodes)
    .filter(node => node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE)
    .map(node => node.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
  const numeric = (element: Element, name: string): number | undefined => {
    const value = element.getAttribute(name);
    if (value === null) return undefined;
    const parsed = Number(value);
    if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${name} in manufacturing instructions.`);
    return parsed;
  };
  const locations = Array.from(root.children).map(location => {
    if (location.localName !== 'Location' || location.namespaceURI !== namespace) throw new Error('Unsupported instruction section.');
    const id = numeric(location, 'LocationID');
    if (id === undefined || !Number.isInteger(id) || id <= 0) throw new Error('Invalid work center ID.');
    const steps = Array.from(location.children).map(step => {
      if (step.localName !== 'step' || step.namespaceURI !== namespace) throw new Error('Unsupported instruction step.');
      return Array.from(step.childNodes).map((node): InstructionPart => {
        if (node.nodeType === Node.COMMENT_NODE) return { kind: 'text', text: '' };
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
          return { kind: 'text', text: (node.textContent ?? '').replace(/\s+/g, ' ') };
        }
        if (!(node instanceof Element) || node.namespaceURI !== namespace) throw new Error('Unsupported step content.');
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        switch (node.localName) {
          case 'material': case 'tool': case 'specs': case 'blueprint':
            return { kind: node.localName, text };
          case 'diag':
            if (!/^[1-9]\d*$/.test(text)) throw new Error('Invalid illustration reference.');
            return { kind: 'diag', text };
          default: throw new Error(`Unsupported instruction element: ${node.localName}.`);
        }
      });
    });
    return {
      id, introduction: ownText(location), steps,
      setupHours: numeric(location, 'SetupHours'),
      laborHours: numeric(location, 'LaborHours'),
      machineHours: numeric(location, 'MachineHours'),
      lotSize: numeric(location, 'LotSize'),
    };
  });
  if (new Set(locations.map(location => location.id)).size !== locations.length) throw new Error('Duplicate work center IDs.');
  return { introduction: ownText(root), locations };
}

export function illustrationUrl(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid illustration ID.');
  return `${import.meta.env.BASE_URL}illustrations/illustration-${id}.svg`;
}
