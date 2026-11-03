import type { PackageExport, PackageManifest } from "./packageManifest";
import { BUILTIN_PREFIX, normalizeName, validateName } from "./resourcePath";
import type { PackageDependency } from "./schema";

/**
 * プロジェクトの依存と `@別名/...` の import（ADR 0015）。
 *
 * - `@` で始まる書き方はライブラリを指す（`@builtin/` だけは Built-in）。
 * - 依存の中身（manifest）は版ごとに変わらないので、取り出しは呼ぶ側（クライアント）が受け持ち、
 *   ここは取り出した結果（PackageResolution）を受け取って解決するだけにする。
 */

/** 依存の中身を取り出した結果（別名ごと） */
export type PackageResolution =
  | { status: "ready"; dependency: PackageDependency; manifest: PackageManifest }
  | { status: "unavailable"; dependency: PackageDependency; message: string };

/** 別名に使えない書き方なら、その理由 */
export function validateAlias(alias: string): string | null {
  if (validateName(alias) !== null) return "別名に使えない書き方です";
  if (/[\s@]/.test(alias)) return "別名に空白や @ は使えません";
  if (normalizeName(alias) === "builtin") return "builtin は Built-in のための名前です";
  if (alias.length > 64) return "別名が長すぎます";
  return null;
}

/** `@別名/パス` を別名とパスに分ける（`@builtin/` とライブラリでないものは null） */
export function parsePackageSpelling(spelling: string): { alias: string; path: string } | null {
  if (!spelling.startsWith("@") || spelling.startsWith(BUILTIN_PREFIX)) return null;
  const slash = spelling.indexOf("/");
  if (slash < 0) return { alias: spelling.slice(1), path: "" };
  return { alias: spelling.slice(1, slash), path: spelling.slice(slash + 1) };
}

/**
 * 依存から取り込んだリソースの、このプロジェクトでの ID。Package と版で区切るので、
 * フォーク元のライブラリに依存しても、自分のリソースや別の版と ID がぶつからない。
 */
export function packageResourceId(dep: PackageDependency, resourceId: string): string {
  return `pkg:${dep.packageId}@${dep.version}/${resourceId}`;
}

const pathKey = (path: string) =>
  path
    .split("/")
    .filter((s) => s !== "")
    .map(normalizeName)
    .join("/");

/** manifest の中から、書いたパスに当たる公開のリソース（公開していないものは入っていない） */
export function findPackageExport(
  manifest: PackageManifest,
  path: string,
): PackageExport | undefined {
  const key = pathKey(path);
  return manifest.exports.find((e) => pathKey(e.path) === key);
}
