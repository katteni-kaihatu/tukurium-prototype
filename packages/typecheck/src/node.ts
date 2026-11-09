import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TypeCheckerOptions } from "./checker";

/**
 * Node で TypeScript の標準ライブラリの宣言と、日本語の文を読む（サーバーとテストで使う）。
 * ブラウザでは、Worker が同じものを読み込んで渡す。
 */
export function nodeTypeCheckerOptions(): TypeCheckerOptions {
  const require = createRequire(import.meta.url);
  const lib = join(dirname(require.resolve("typescript6")), "");
  const cache = new Map<string, string | undefined>();
  return {
    readLib(fileName) {
      if (!cache.has(fileName)) {
        try {
          cache.set(fileName, readFileSync(join(lib, fileName), "utf8"));
        } catch {
          cache.set(fileName, undefined);
        }
      }
      return cache.get(fileName);
    },
    messages: JSON.parse(
      readFileSync(join(lib, "ja", "diagnosticMessages.generated.json"), "utf8"),
    ),
  };
}
