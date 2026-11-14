import type { PackageResolution, ProjectSnapshot } from "@tukurium/repo-model";
import type { EditorQuery, EditorResults, TypeCheckResult } from "@tukurium/typecheck";

export interface CheckRequest {
  kind: "check";
  id: number;
  snapshot: ProjectSnapshot;
  packages: [string, PackageResolution][];
  hostDeclarations: string;
}
export interface QueryRequest {
  kind: "query";
  id: number;
  version: number;
  query: EditorQuery;
}
export type TypecheckRequest = CheckRequest | QueryRequest;
export type TypecheckResponse =
  | { kind: "check"; id: number; result: TypeCheckResult; error?: string }
  | {
      kind: "query";
      id: number;
      version: number;
      result: EditorResults[EditorQuery["kind"]];
      error?: string;
    };
