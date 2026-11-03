import type { KokoStateDef } from "@tukurium/eks";
import type { PackageExport, PackageManifest } from "./packageManifest";
import { BUILTIN_PREFIX, normalizeName, validateName } from "./resourcePath";
import type { FolderDef, PackageDependency, ProjectSnapshot } from "./schema";

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

/** 依存から取り込んだリソースの ID か（`pkg:` で始まる） */
export function isPackageResourceId(id: string): boolean {
  return id.startsWith("pkg:");
}

/** 取り込んだ ID が、この依存（Package と版）のものか */
export function belongsToDependency(id: string, dep: PackageDependency): boolean {
  return id.startsWith(`pkg:${dep.packageId}@${dep.version}/`);
}

/**
 * 依存から取り込む KokoState の定義（ID は Package と版で区切ったもの）。
 * 同じ Package・同じ版なら、どのプロジェクトから使っても同じ ID になる（置いた物どうしで共有する）。
 */
export function packageKokoStates(resolutions: Iterable<PackageResolution>): KokoStateDef[] {
  const out: KokoStateDef[] = [];
  for (const r of resolutions) {
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as Partial<KokoStateDef> | null;
      if (e.kind !== "kokostate" || typeof def?.name !== "string" || !Array.isArray(def.fields))
        continue;
      out.push({
        id: packageResourceId(r.dependency, e.id),
        name: def.name,
        fields: structuredClone(def.fields),
      });
    }
  }
  return out;
}

const sameLock = (a: PackageDependency, b: PackageDependency) =>
  a.packageId === b.packageId && a.version === b.version && a.contentHash === b.contentHash;

/**
 * 制作データの依存ごとの解決（別名 → 結果）。実行するときに使う。
 * 届いた結果が lock と違う（別の版・別の hash）か、届いていなければ、使えないものにする。
 */
export function resolutionMap(
  deps: readonly PackageDependency[] | undefined,
  resolutions: readonly PackageResolution[] | undefined,
): Map<string, PackageResolution> {
  const out = new Map<string, PackageResolution>();
  for (const dep of deps ?? []) {
    const r = resolutions?.find((x) => x.dependency.alias === dep.alias);
    out.set(
      dep.alias,
      r && sameLock(r.dependency, dep)
        ? r
        : { status: "unavailable", dependency: dep, message: "ライブラリの中身が届いていません" },
    );
  }
  return out;
}

/** 取り込んだ ID を Package ID・版・元の ID に分ける（`pkg:` でなければ null） */
export function parsePackageResourceId(
  id: string,
): { packageId: string; version: number; resourceId: string } | null {
  const m = /^pkg:(.+)@(\d+)\/(.+)$/.exec(id);
  if (!m) return null;
  return { packageId: m[1] as string, version: Number(m[2]), resourceId: m[3] as string };
}

/** 依存から使える System（アウトプットに入れる候補。ID は Package と版で区切ったもの） */
export interface PackageSystem {
  id: string;
  name: string;
  code: string;
  /** 依存の別名 */
  alias: string;
}

export function packageSystems(resolutions: Iterable<PackageResolution>): PackageSystem[] {
  const out: PackageSystem[] = [];
  for (const r of resolutions) {
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as { name?: unknown; code?: unknown } | null;
      if (e.kind !== "system" || typeof def?.name !== "string" || typeof def.code !== "string")
        continue;
      out.push({
        id: packageResourceId(r.dependency, e.id),
        name: def.name,
        code: def.code,
        alias: r.dependency.alias,
      });
    }
  }
  return out;
}

/**
 * ライブラリの版の中身から、公開したものだけの制作データを組み立て直す（ID は Package と版で区切る）。
 * ライブラリの System の import（`./Health.koko` など）を、ライブラリの中の論理パスで解決するのに使う。
 * 公開していないものは入らないので、それを import した System は「見つからない」になる。
 */
export function librarySnapshot(
  r: Extract<PackageResolution, { status: "ready" }>,
): ProjectSnapshot {
  const dep = r.dependency;
  const snap: ProjectSnapshot = {
    version: 1,
    name: dep.alias,
    kokostates: [],
    systems: [],
    materials: [],
    outputs: [],
    entities: [],
    folders: [],
    placement: {},
  };
  const folderId = (path: string) => `pkgdir:${dep.packageId}@${dep.version}:${path}`;
  const folders = new Map<string, FolderDef>();
  for (const e of r.manifest.exports) {
    const segments = e.path.split("/").filter((s) => s !== "");
    let parent: string | null = null;
    let prefix = "";
    for (const seg of segments.slice(0, -1)) {
      prefix += `/${seg}`;
      const id = folderId(prefix);
      if (!folders.has(id)) folders.set(id, { id, name: seg, parent });
      parent = id;
    }
    const id = packageResourceId(dep, e.id);
    const def = e.definition as Record<string, unknown> | null;
    if (typeof def?.name !== "string") continue;
    if (e.kind === "kokostate" && Array.isArray(def.fields))
      snap.kokostates.push({ id, name: def.name, fields: structuredClone(def.fields) });
    else if (e.kind === "system" && typeof def.code === "string")
      snap.systems.push({ id, name: def.name, code: def.code });
    else continue;
    if (parent && snap.placement) snap.placement[id] = parent;
  }
  snap.folders = [...folders.values()];
  return snap;
}
