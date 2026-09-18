import type { BillOfMaterials, Product, WorkOrder } from '@/types/production';

export interface AssemblyTreeNode {
  componentId: number;
  componentName: string;
  perAssemblyQty: number;
  unitCost: number;
  bomLevel: number;
  unitMeasureCode: string;
  modifiedDate: string;
  children: AssemblyTreeNode[];
  totalCost: number;
}

export interface AssemblyStats {
  assemblyId: number;
  assemblyName: string;
  depth: number;
  nodeCount: number;
  distinctComponents: number;
  rolledUpCost: number;
  listPrice: number;
  lastModified: string;
  recentLineCount: number; // BOM lines modified in last 90d
  tree: AssemblyTreeNode[];
}

function buildTree(
  bom: BillOfMaterials[],
  byParent: Map<number, BillOfMaterials[]>,
  products: Map<number, Product>,
  parentId: number,
  visited = new Set<number>(),
): AssemblyTreeNode[] {
  if (visited.has(parentId)) return [];
  visited.add(parentId);
  const children = byParent.get(parentId) || [];
  const out = children.map(b => {
    const p = products.get(b.ComponentID);
    const childNodes = buildTree(bom, byParent, products, b.ComponentID, new Set(visited));
    const childCost = childNodes.reduce((s, c) => s + c.totalCost, 0);
    const unitCost = p?.StandardCost ?? 0;
    return {
      componentId: b.ComponentID,
      componentName: p?.Name || `Component #${b.ComponentID}`,
      perAssemblyQty: b.PerAssemblyQty,
      unitCost,
      bomLevel: b.BOMLevel,
      unitMeasureCode: b.UnitMeasureCode,
      modifiedDate: b.ModifiedDate,
      children: childNodes,
      totalCost: unitCost * b.PerAssemblyQty + childCost,
    };
  });
  return out;
}

function treeStats(tree: AssemblyTreeNode[]): {
  depth: number;
  nodeCount: number;
  distinctComponents: number;
  rolledUpCost: number;
} {
  let depth = 0;
  let nodeCount = 0;
  let cost = 0;
  const distinct = new Set<number>();
  const walk = (nodes: AssemblyTreeNode[], d: number) => {
    if (nodes.length && d > depth) depth = d;
    for (const n of nodes) {
      nodeCount += 1;
      distinct.add(n.componentId);
      cost += n.unitCost * n.perAssemblyQty;
      walk(n.children, d + 1);
    }
  };
  walk(tree, 1);
  return { depth, nodeCount, distinctComponents: distinct.size, rolledUpCost: cost };
}

export function buildAllAssemblyStats(
  bom: BillOfMaterials[],
  products: Map<number, Product>,
): AssemblyStats[] {
  const byParent = new Map<number, BillOfMaterials[]>();
  bom.forEach(b => {
    if (!b.ProductAssemblyID) return;
    const list = byParent.get(b.ProductAssemblyID) || [];
    list.push(b);
    byParent.set(b.ProductAssemblyID, list);
  });

  const ninetyDaysAgo = Date.now() - 90 * 86400_000;
  const result: AssemblyStats[] = [];
  for (const [assemblyId, lines] of byParent) {
    const product = products.get(assemblyId);
    const tree = buildTree(bom, byParent, products, assemblyId);
    const stats = treeStats(tree);
    const lastModified = lines.reduce(
      (m, l) => (l.ModifiedDate > m ? l.ModifiedDate : m),
      lines[0].ModifiedDate,
    );
    const recentLineCount = lines.filter(l => Date.parse(l.ModifiedDate) >= ninetyDaysAgo).length;
    result.push({
      assemblyId,
      assemblyName: product?.Name || `Product #${assemblyId}`,
      depth: stats.depth,
      nodeCount: stats.nodeCount,
      distinctComponents: stats.distinctComponents,
      rolledUpCost: stats.rolledUpCost,
      listPrice: product?.ListPrice ?? 0,
      lastModified,
      recentLineCount,
      tree,
    });
  }
  return result;
}

// Map: componentId -> Set of assemblyIds that directly use it
export function buildComponentUsage(bom: BillOfMaterials[]): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  bom.forEach(b => {
    if (!b.ProductAssemblyID) return;
    const set = map.get(b.ComponentID) || new Set<number>();
    set.add(b.ProductAssemblyID);
    map.set(b.ComponentID, set);
  });
  return map;
}

// Effective per-assembly qty for every component within an assembly tree (multi-level multiplied + aggregated)
export function flattenForExplosion(tree: AssemblyTreeNode[]): Map<number, number> {
  const map = new Map<number, number>();
  const walk = (nodes: AssemblyTreeNode[], multiplier: number) => {
    for (const n of nodes) {
      const eff = n.perAssemblyQty * multiplier;
      map.set(n.componentId, (map.get(n.componentId) || 0) + eff);
      if (n.children.length) walk(n.children, eff);
    }
  };
  walk(tree, 1);
  return map;
}

// All paths from the assembly root to occurrences of targetCid in the tree.
// Each result yields the chain of component nodes plus the effective per-assembly
// quantity contributed by that occurrence (product of perAssemblyQty along the path).
export interface ComponentPathStep {
  componentId: number;
  componentName: string;
  perAssemblyQty: number;
  unitMeasureCode: string;
}
export interface ComponentPath {
  steps: ComponentPathStep[];      // from top-level child down to the matching node
  effectivePerAssy: number;        // product of perAssemblyQty along the path
}
export function findComponentPaths(
  tree: AssemblyTreeNode[],
  targetCid: number,
): ComponentPath[] {
  const out: ComponentPath[] = [];
  const walk = (nodes: AssemblyTreeNode[], chain: ComponentPathStep[], mult: number) => {
    for (const n of nodes) {
      const step: ComponentPathStep = {
        componentId: n.componentId,
        componentName: n.componentName,
        perAssemblyQty: n.perAssemblyQty,
        unitMeasureCode: n.unitMeasureCode,
      };
      const nextMult = mult * n.perAssemblyQty;
      const nextChain = [...chain, step];
      if (n.componentId === targetCid) {
        out.push({ steps: nextChain, effectivePerAssy: nextMult });
      }
      if (n.children.length) walk(n.children, nextChain, nextMult);
    }
  };
  walk(tree, [], 1);
  return out;
}

export type WOStatus = 'Planned' | 'Released' | 'Completed' | 'Scrapped';

export function classifyWorkOrder(wo: WorkOrder, activeIds: Set<number>): WOStatus {
  if (wo.ScrappedQty > 0 && wo.StockedQty === 0) return 'Scrapped';
  if (wo.EndDate || wo.StockedQty >= wo.OrderQty) return 'Completed';
  if (activeIds.has(wo.WorkOrderID)) return 'Released';
  if (wo.StockedQty > 0 && wo.StockedQty < wo.OrderQty) return 'Released';
  return 'Planned';
}

export const fmtMoney = (n: number) =>
  n >= 10_000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`;

export const fmtDate = (s: string) => new Date(s).toLocaleDateString();
