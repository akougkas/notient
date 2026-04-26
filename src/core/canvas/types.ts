export interface CanvasFile {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type CanvasNode =
  | {
      id: string;
      type: "text";
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
    }
  | {
      id: string;
      type: "file";
      file: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
    };

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
  color?: string;
}
