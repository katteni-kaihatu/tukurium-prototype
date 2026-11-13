import { encodeValue, isPlainObject, type Json } from "@tukurium/eks";
import { type PathKind, ResourcePathIndex } from "./resourcePath";
import type { PackageDependency, ProjectSnapshot } from "./schema";

/**
 * Library Package の中身（ADR 0013・0015・0055）。ライブラリのアウトプットに含めたリソースだけを、
 * 決まった並び（ID の順）で書き出す。Registry（サーバー）は、この stableStringify に SHA-256 をかけて
 * content hash にする。含めていないものは入らないので、内部を変えても hash は変わらない。
 */

export interface PackageExport {
  kind: PathKind;
  id: string;
  /** 公開した時点の論理パス（使う側は @別名/<パス> で import する） */
  path: string;
  /** 定義（System はコードも含む） */
  definition: unknown;
}

export interface PackageManifest {
  /** manifest の形の版。互換性なく変えるときに上げる */
  format: 1;
  exports: PackageExport[];
  /**
   * このライブラリの依存（lock。別名の順）。依存があるときだけ入れる
   * （依存のないライブラリの hash は、これを足す前と同じ）
   */
  dependencies?: PackageDependency[];
}

/** ライブラリのアウトプットに含めたリソースの ID（ライブラリでなければ空） */
export function includedResources(snap: ProjectSnapshot, outputId: string): Set<string> {
  const o = snap.outputs.find((x) => x.id === outputId);
  return new Set(o?.kind === "library" ? (o.resources ?? []) : []);
}

export function packageManifest(snap: ProjectSnapshot, outputId: string): PackageManifest {
  const index = ResourcePathIndex.fromSnapshot(snap);
  const exported = includedResources(snap, outputId);
  const defs = new Map<string, unknown>();
  for (const k of snap.kokostates) defs.set(k.id, k);
  for (const s of snap.systems) defs.set(s.id, s);
  for (const m of snap.materials) defs.set(m.id, m);
  for (const a of snap.assets ?? []) defs.set(a.id, a);
  const exports: PackageExport[] = [];
  for (const id of [...exported].sort()) {
    const entry = index.entry(id);
    const path = index.pathOf(id);
    if (!entry || entry.kind === "folder" || path === null || !defs.has(id)) continue;
    exports.push({ kind: entry.kind, id, path, definition: defs.get(id) });
  }
  const deps = [...(snap.dependencies ?? [])].sort((a, b) =>
    a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0,
  );
  return deps.length > 0 ? { format: 1, exports, dependencies: deps } : { format: 1, exports };
}

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** ふつうの JSON を、キーを並べ替えて書く */
function stableJson(json: Json): string {
  if (json === null || typeof json !== "object") return JSON.stringify(json);
  if (Array.isArray(json)) return `[${json.map(stableJson).join(",")}]`;
  const entries = Object.entries(json).sort(byKey);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/**
 * キーを並べ替えて書く JSON（同じ中身なら、作り方によらず同じ文字列になる）。
 * オブジェクトの、値が undefined のプロパティは書かない（ないのと同じ）。JSON で表せない値
 * （配列の中の undefined・Date・Map・Set・bigint・NaN）は、タグ付きの JSON（ADR 0065）で書く。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value) && !Object.hasOwn(value, "$t")) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(byKey);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return stableJson(encodeValue(value));
}
