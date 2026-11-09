/// <reference lib="webworker" />
import type { PackageResolution, ProjectSnapshot } from "@tukurium/repo-model";
import { TypeChecker } from "@tukurium/typecheck";
import messages from "typescript6/lib/ja/diagnosticMessages.generated.json";

/**
 * スクリプトの型を確かめる Worker（ADR 0058）。TypeScript の本体は大きいので、画面とは別に、
 * ワークスペースで型を確かめるときにだけ読み込む。同じ TypeChecker を使い回し、変わっていない
 * ファイルの解析を使い回す。
 */

// TypeScript の標準ライブラリの宣言（ES2022 までと、そこから参照されるもの）。文字列として同梱する
const libs = import.meta.glob("/node_modules/typescript6/lib/lib.{es,decorators}*.d.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const libByName = new Map(
  Object.entries(libs).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
);

const checker = new TypeChecker({
  readLib: (fileName) => libByName.get(fileName),
  messages: messages as Record<string, string>,
});

export interface TypeCheckRequest {
  id: number;
  snapshot: ProjectSnapshot;
  packages: [string, PackageResolution][];
  hostDeclarations: string;
}

self.onmessage = (event: MessageEvent<TypeCheckRequest>) => {
  const { id, snapshot, packages, hostDeclarations } = event.data;
  try {
    const diagnostics = checker.check({ snapshot, packages: new Map(packages), hostDeclarations });
    self.postMessage({ id, diagnostics });
  } catch (e) {
    self.postMessage({ id, diagnostics: [], error: e instanceof Error ? e.message : String(e) });
  }
};
