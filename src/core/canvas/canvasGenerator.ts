import type { CanvasEdge, CanvasFile, CanvasNode } from "./types";

const NODE_WIDTH = 320;
const NODE_HEIGHT = 200;
const RADIUS = 480;

export interface SynthesisCanvasInput {
  synthesisTitle: string;
  synthesisBody: string;
  sourceNotePaths: string[];
}

export function generateSynthesisCanvas(input: SynthesisCanvasInput): CanvasFile {
  const centre: CanvasNode = {
    id: "synthesis",
    type: "text",
    text: `# ${input.synthesisTitle}\n\n${input.synthesisBody}`,
    x: -NODE_WIDTH / 2,
    y: -NODE_HEIGHT / 2,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
  const sources: CanvasNode[] = input.sourceNotePaths.map((path, index) => {
    const angle = (index / Math.max(1, input.sourceNotePaths.length)) * Math.PI * 2;
    return {
      id: `source-${index}`,
      type: "file",
      file: path,
      x: Math.round(Math.cos(angle) * RADIUS) - NODE_WIDTH / 2,
      y: Math.round(Math.sin(angle) * RADIUS) - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const edges: CanvasEdge[] = sources.map((source, index) => ({
    id: `edge-${index}`,
    fromNode: "synthesis",
    toNode: source.id,
  }));
  return { nodes: [centre, ...sources], edges };
}

export interface SearchCanvasInput {
  query: string;
  resultPaths: string[];
}

export function generateSearchResultsCanvas(input: SearchCanvasInput): CanvasFile {
  const queryNode: CanvasNode = {
    id: "query",
    type: "text",
    text: `# Query\n\n${input.query}`,
    x: -NODE_WIDTH / 2,
    y: -NODE_HEIGHT / 2,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
  const results: CanvasNode[] = input.resultPaths.map((path, index) => {
    const angle = (index / Math.max(1, input.resultPaths.length)) * Math.PI * 2;
    return {
      id: `result-${index}`,
      type: "file",
      file: path,
      x: Math.round(Math.cos(angle) * RADIUS) - NODE_WIDTH / 2,
      y: Math.round(Math.sin(angle) * RADIUS) - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const edges: CanvasEdge[] = results.map((result, index) => ({
    id: `edge-${index}`,
    fromNode: "query",
    toNode: result.id,
  }));
  return { nodes: [queryNode, ...results], edges };
}
