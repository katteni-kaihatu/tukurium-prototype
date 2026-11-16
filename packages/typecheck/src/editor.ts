/** Worker と画面で共有する、TypeScript の実装に依存しない値。位置は UTF-16 の文字数。 */
export interface EditorLocation {
  fileId: string;
  code: string;
  position: number;
}

export type EditorQuery =
  | (EditorLocation & { kind: "hover" })
  | (EditorLocation & { kind: "completions" })
  | (EditorLocation & { kind: "details"; name: string; source?: string })
  | (EditorLocation & { kind: "definition" });

export interface EditorDocumentation {
  display: string;
  documentation: string;
}

export interface EditorDefinition {
  kind: "koko" | "code";
  id: string;
  position: number;
  line: number;
}

export interface EditorHover extends EditorDocumentation {
  from: number;
  to: number;
  diagnostics: string[];
  definition: EditorDefinition | null;
}

export interface EditorCompletion {
  name: string;
  kind: string;
  sortText: string;
  source?: string;
  insertText?: string;
}

export interface EditorResults {
  hover: EditorHover | null;
  completions: EditorCompletion[];
  details: EditorDocumentation | null;
  definition: EditorDefinition | null;
}
