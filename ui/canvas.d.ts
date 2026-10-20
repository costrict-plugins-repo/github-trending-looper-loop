export type CanvasGraphNode = {
  id: string;
  kind: string;
  iter: number;
  column: number;
  status: string;
  iterColor: string;
  meta: Record<string, any>;
};

export type CanvasGraphModel = {
  nodes: Map<string, CanvasGraphNode>;
  edges: Array<{ from: string; to: string; kind: string }>;
  layout: Map<string, { x: number; y: number }>;
  maxIter: number;
  observerCount: number;
};

export function mergeActivityHistory(history: any[], tail: any[]): any[];
export function buildGraphModel(state?: any, graph?: any, activity?: any[]): CanvasGraphModel;
export function layoutGraph(model: CanvasGraphModel): Map<string, { x: number; y: number }>;
export function activeNodeId(state: any, model: CanvasGraphModel): string | undefined;
export function tooltipForNode(item: CanvasGraphNode): { title: string; lines: string[] };
export function nodeVisualColor(item?: Partial<CanvasGraphNode>): { hex: string; alpha: number; r: number; g: number; b: number; a: number };
export function edgeWidthAt(kind: string, t: number): number;
export function createCanvasView(nodes: Record<string, any>): {
  update(loopState: any, graph: any, activity: any[]): void;
  resize(): void;
  render(): void;
  centerNode(id: string): void;
  view: Record<string, any>;
  state: Record<string, any>;
};
