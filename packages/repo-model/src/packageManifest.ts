import {
  encodeValue,
  type FieldSchemas,
  isPlainObject,
  type Json,
  type KokoStateDef,
} from "@tukurium/eks";
import { type GraphRef, ProjectDependencyGraph, refKey } from "./dependencyGraph";
import { type PathKind, ResourcePathIndex } from "./resourcePath";
import type { PackageDependency, PrefabDef, PrefabEntityDef, ProjectSnapshot } from "./schema";

/** 公開するプレハブ。中の Entity も、この版の定義に含める。 */
export interface PackagePrefabDefinition extends PrefabDef {
  entities: PrefabEntityDef[];
}

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
  /** 公開元で解決した KokoState の型情報。参照を読み込み先の ID に付け替えるときにも使う。 */
  fieldSchemas?: FieldSchemas;
}

/** ライブラリのアウトプットに含めたリソースの ID（ライブラリでなければ空） */
export function includedResources(snap: ProjectSnapshot, outputId: string): Set<string> {
  const o = snap.outputs.find((x) => x.id === outputId);
  return new Set(o?.kind === "library" ? (o.resources ?? []) : []);
}

/** プレハブを使うために要るリソースも含める。単独で選んだ System などの公開範囲は変えない。 */
export function packageResources(
  snap: ProjectSnapshot,
  outputId: string,
  schemas?: FieldSchemas,
  kokostates: readonly KokoStateDef[] = [],
): Set<string> {
  const exported = includedResources(snap, outputId);
  const graph = ProjectDependencyGraph.fromSnapshot(snap, schemas, kokostates);
  const pending: GraphRef[] = (snap.prefabs ?? [])
    .filter((p) => exported.has(p.id))
    .map((p) => ({ kind: "prefab", id: p.id }));
  const seen = new Set<string>();
  while (pending.length > 0) {
    const ref = pending.pop() as GraphRef;
    if (seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    if (ref.kind === "name" || ref.kind === "entity" || ref.kind === "output") continue;
    exported.add(ref.id);
    pending.push(...graph.dependenciesOf(ref));
  }
  return exported;
}

export function packageManifest(
  snap: ProjectSnapshot,
  outputId: string,
  schemas?: FieldSchemas,
  kokostates: readonly KokoStateDef[] = [],
): PackageManifest {
  const index = ResourcePathIndex.fromSnapshot(snap);
  const exported = packageResources(snap, outputId, schemas, kokostates);
  // 含めた KokoState がフィールドの型で使う、型の定義は、含めていなくても一緒に入れる
  // （ないと、使う側でそのフィールドの型を読めない。ADR 0065）
  for (const k of snap.kokostates)
    if (exported.has(k.id)) for (const id of k.typeDefs ?? []) exported.add(id);
  const defs = new Map<string, unknown>();
  for (const k of snap.kokostates) defs.set(k.id, k);
  for (const s of snap.systems) defs.set(s.id, s);
  for (const t of snap.types ?? []) defs.set(t.id, t);
  for (const m of snap.materials) defs.set(m.id, m);
  for (const a of snap.assets ?? []) defs.set(a.id, a);
  for (const p of snap.prefabs ?? [])
    defs.set(p.id, {
      ...p,
      entities: (snap.prefabEntities ?? [])
        .filter((e) => e.prefab === p.id)
        .sort((a, b) => a.id.localeCompare(b.id)),
    } satisfies PackagePrefabDefinition);
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
  const manifest: PackageManifest = { format: 1, exports };
  if (deps.length > 0) manifest.dependencies = deps;
  if (schemas) {
    const fields = Object.fromEntries(Object.entries(schemas).filter(([id]) => exported.has(id)));
    if (Object.keys(fields).length > 0) manifest.fieldSchemas = fields;
  }
  return manifest;
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
