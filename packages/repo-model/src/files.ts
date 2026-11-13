import type {
  AssetDef,
  EntityDef,
  FolderDef,
  MaterialDef,
  OutputDef,
  PackageDependency,
  ProjectSnapshot,
  Provenance,
  SystemDef,
  TypeDef,
} from "./schema";
import {
  decodeKokoState,
  decodeStates,
  encodeKokoState,
  encodeStates,
  type StoredKokoState,
  type StoredValues,
} from "./storedValues";

/** リポジトリの中のファイル（パス → 中身） */
export type FileMap = Record<string, string>;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

/** 保存したファイルのパス。画面の差分表示も同じ場所を見る。 */
export function entityFilePath(outputId: string, entityId: string): string {
  return `outputs/${safe(outputId)}/entities/${safe(entityId)}.json`;
}
export function kokoFilePath(id: string): string {
  return `kokostates/${safe(id)}.json`;
}
export function systemMetaPath(id: string): string {
  return `systems/${safe(id)}.json`;
}
export function systemCodePath(id: string): string {
  return `systems/${safe(id)}.ts`;
}
export function typeMetaPath(id: string): string {
  return `types/${safe(id)}.json`;
}
export function typeCodePath(id: string): string {
  return `types/${safe(id)}.d.ts`;
}
export function materialFilePath(id: string): string {
  return `materials/${safe(id)}.json`;
}
export function outputFilePath(id: string): string {
  return `outputs/${safe(id)}/output.json`;
}

/** ファイルに書く Entity（値は保存する形。アウトプットはパスで分かるので書かない） */
type StoredEntity = Omit<EntityDef, "output" | "states"> & {
  states: Record<string, StoredValues>;
};

/**
 * 制作データを、人が差分を読めるファイルの集まりにする（計画 §5）。
 * 1 要素 1 ファイルの JSON と、System のスクリプト（.ts。ADR 0058）。
 * フィールドの値と初期値は、タグ付きの JSON で書く（JSON で表せない値も保存できる。ADR 0065）。
 */
export function toFiles(snap: ProjectSnapshot): FileMap {
  const files: FileMap = {};
  files["tukurium.json"] = json({
    format: 1,
    name: snap.name,
    dependencies: snap.dependencies ?? [],
  });
  for (const k of snap.kokostates) files[kokoFilePath(k.id)] = json(encodeKokoState(k));
  for (const s of snap.systems) {
    files[systemMetaPath(s.id)] = json({ id: s.id, name: s.name } satisfies SystemDef);
    files[systemCodePath(s.id)] = s.code;
  }
  // 型の定義は、.d.ts のファイルとして保存する（ADR 0065）
  for (const t of snap.types ?? []) {
    files[typeMetaPath(t.id)] = json({ id: t.id, name: t.name } satisfies TypeDef);
    files[typeCodePath(t.id)] = t.code;
  }
  for (const m of snap.materials) files[materialFilePath(m.id)] = json(m);
  for (const a of snap.assets ?? []) files[`assets/${safe(a.id)}.json`] = json(a);
  for (const o of snap.outputs) files[outputFilePath(o.id)] = json(o);
  for (const e of snap.entities) {
    const { output, states, ...rest } = e;
    files[entityFilePath(output, e.id)] = json({
      ...rest,
      states: encodeStates(states),
    } satisfies StoredEntity);
  }
  if (snap.provenance?.length) files["provenance.json"] = json(snap.provenance);
  if (snap.folders?.length)
    files["folders.json"] = json({ folders: snap.folders, placement: snap.placement ?? {} });
  return files;
}

/** ファイルの集まりから制作データに戻す（toFiles の逆） */
export function fromFiles(files: FileMap): ProjectSnapshot {
  const parse = <T>(path: string): T => JSON.parse(files[path] ?? "null") as T;
  const meta = parse<{ name?: string; dependencies?: PackageDependency[] } | null>("tukurium.json");
  const snap: ProjectSnapshot = {
    version: 1,
    name: meta?.name ?? "untitled",
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    outputs: [],
    entities: [],
  };
  if (meta?.dependencies?.length) snap.dependencies = meta.dependencies;
  const paths = Object.keys(files).sort();
  for (const p of paths) {
    if (p.startsWith("kokostates/"))
      snap.kokostates.push(decodeKokoState(parse<StoredKokoState>(p)));
    else if (p.startsWith("materials/")) snap.materials.push(parse<MaterialDef>(p));
    else if (p.startsWith("assets/")) snap.assets?.push(parse<AssetDef>(p));
    else if (p.startsWith("systems/") && p.endsWith(".json")) {
      const def = parse<SystemDef>(p);
      // スクリプトは .ts。以前の保存の .js も読む
      const base = p.replace(/\.json$/, "");
      snap.systems.push({ ...def, code: files[`${base}.ts`] ?? files[`${base}.js`] ?? "" });
    } else if (p.startsWith("types/") && p.endsWith(".json")) {
      const def = parse<TypeDef>(p);
      snap.types ??= [];
      snap.types.push({ ...def, code: files[p.replace(/\.json$/, ".d.ts")] ?? "" });
    } else if (/^outputs\/[^/]+\/output\.json$/.test(p)) snap.outputs.push(parse<OutputDef>(p));
  }
  for (const o of snap.outputs) {
    const prefix = `outputs/${safe(o.id)}/entities/`;
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const stored = parse<StoredEntity>(p);
      snap.entities.push({ ...stored, states: decodeStates(stored.states), output: o.id });
    }
  }
  if (files["provenance.json"]) snap.provenance = parse<Provenance[]>("provenance.json");
  if (files["folders.json"]) {
    const f = parse<{ folders?: FolderDef[]; placement?: Record<string, string> }>("folders.json");
    snap.folders = f.folders ?? [];
    snap.placement = f.placement ?? {};
  }
  return snap;
}

export interface FileChange {
  path: string;
  change: "added" | "removed" | "modified";
  add: number;
  del: number;
}

/** 2 つのファイルの集まりの差分（行数は増減のおおよそ） */
export function diffFiles(before: FileMap, after: FileMap): FileChange[] {
  const out: FileChange[] = [];
  const lines = (s: string | undefined) => (s === undefined ? [] : s.split("\n"));
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[path];
    const b = after[path];
    if (a === b) continue;
    const la = lines(a);
    const lb = lines(b);
    // 行の多重集合の差で増減を数える（並び替えは数えない簡易な方式）
    const count = new Map<string, number>();
    for (const l of la) count.set(l, (count.get(l) ?? 0) + 1);
    let add = 0;
    for (const l of lb) {
      const c = count.get(l) ?? 0;
      if (c > 0) count.set(l, c - 1);
      else add++;
    }
    const del = [...count.values()].reduce((x, y) => x + y, 0);
    out.push({
      path,
      change: a === undefined ? "added" : b === undefined ? "removed" : "modified",
      add,
      del,
    });
  }
  return out;
}
