import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { illustrationUrl, parseManufacturingInstructions } from './manufacturingInstructions';

const source = readFileSync('../seed-job/sql/ProductModel.csv', 'utf8');
const models = source.split('&|').filter(record => record.trim()).map(record => record.trim().split('+|'));
const namespace = 'http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions';

describe('manufacturing instruction parser', () => {
  it('parses every original instruction document and every diagram reference', () => {
    const instructions = models.filter(model => model[3].trim());
    expect(instructions).toHaveLength(9);
    const references = new Set<string>();
    for (const model of instructions) {
      const parsed = parseManufacturingInstructions(model[3]);
      expect(parsed.introduction.length).toBeGreaterThan(0);
      expect(parsed.locations.length).toBeGreaterThan(0);
      for (const center of parsed.locations) {
        expect(center.steps.length).toBeGreaterThan(0);
        for (const step of center.steps) for (const part of step) {
          if (part.kind === 'diag') references.add(part.text);
        }
      }
    }
    expect([...references].sort()).toEqual(['3', '4', '5', '6', '7']);
  });

  it('preserves all four saddle steps, inline materials and illustration 6', () => {
    const model = models.find(model => model[0] === '67')!;
    const center = parseManufacturingInstructions(model[3]).locations[0];
    expect(center).toMatchObject({ id: 50, laborHours: 1, setupHours: 0.25, lotSize: 1 });
    expect(center.steps).toHaveLength(4);
    expect(center.steps[1].map(part => part.text).join('')).toContain('See illustration 6.');
    expect(center.steps[1]).toContainEqual({ kind: 'diag', text: '6' });
  });

  it('supports existing plain-text instructions without interpreting markup', () => {
    expect(parseManufacturingInstructions('Inspect all parts.')).toEqual({ introduction: 'Inspect all parts.', locations: [] });
  });

  it.each([
    '<root>',
    '<root xmlns="wrong"/>',
    `<!DOCTYPE root><root xmlns="${namespace}"/>`,
    `<root xmlns="${namespace}"><Location LocationID="x"/></root>`,
    `<root xmlns="${namespace}"><Location LocationID="50"><step><diag>../bad</diag></step></Location></root>`,
    `<root xmlns="${namespace}"><Location LocationID="50"><step><script>alert(1)</script></step></Location></root>`,
  ])('rejects malformed or unsupported instructions: %s', xml => {
    expect(() => parseManufacturingInstructions(xml)).toThrow();
  });

  it('uses the same ID-based asset names for original and future illustrations', () => {
    expect(illustrationUrl(6)).toBe('/illustrations/illustration-6.svg');
    expect(illustrationUrl(1001)).toBe('/illustrations/illustration-1001.svg');
    expect(() => illustrationUrl(-1)).toThrow();
  });
});
