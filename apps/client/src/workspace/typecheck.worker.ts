/// <reference lib="webworker" />
import { TypeChecker } from "@tukurium/typecheck";
import messages from "typescript6/lib/ja/diagnosticMessages.generated.json";
import type { TypecheckRequest } from "./typecheckProtocol";
import { TypecheckQueue } from "./typecheckQueue";

/**
 * スクリプトとフィールドの型を確かめ、フィールドのスキーマを作る Worker（ADR 0058・0065）。TypeScript の本体は大きいので、画面とは別に、
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

const queue = new TypecheckQueue(checker, (response) => self.postMessage(response));
self.onmessage = (event: MessageEvent<TypecheckRequest>) => queue.receive(event.data);
