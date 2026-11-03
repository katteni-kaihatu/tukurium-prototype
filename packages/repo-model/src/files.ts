import type { KokoStateDef } from "@tukurium/eks";
import type {
  AssetDef,
  EntityDef,
  FolderDef,
  MaterialDef,
  OutputDef,
  ProjectSnapshot,
  Provenance,
  SystemDef,
} from "./schema";

/** リポジトリの中のファイル（パス → 中身） */
export type FileMap = Record<string, string>;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * 制作データを、人が差分を読めるファイルの集まりにする（計画 §5）。
 * 1 要素 1 ファイルの JSON と、System のスクリプト（.js）。
 */
export function toFiles(snap: ProjectSnapshot): FileMap {
  const files: FileMap = {};
  files["tukurium.json"] = json({ format: 1, name: snap.name, dependencies: [] });
  for (const k of snap.kokostates) files[`kokostates/${safe(k.id)}.json`] = json(k);
  for (const s of snap.systems) {
    files[`systems/${safe(s.id)}.json`] = json({ id: s.id, name: s.name } satisfies SystemDef);
    files[`systems/${safe(s.id)}.js`] = s.code;
  }
  for (const m of snap.materials) files[`materials/${safe(m.id)}.json`] = json(m);
  for (const a of snap.assets ?? []) files[`assets/${safe(a.id)}.json`] = json(a);
  for (const o of snap.outputs) files[`outputs/${safe(o.id)}/output.json`] = json(o);
  for (const e of snap.entities) {
    const { output, ...rest } = e;
    files[`outputs/${safe(output)}/entities/${safe(e.id)}.json`] = json(rest);
  }
  if (snap.provenance?.length) files["provenance.json"] = json(snap.provenance);
  if (snap.folders?.length)
    files["folders.json"] = json({ folders: snap.folders, placement: snap.placement ?? {} });
  return files;
}

/** ファイルの集まりから制作データに戻す（toFiles の逆） */
export function fromFiles(files: FileMap): ProjectSnapshot {
  const parse = <T>(path: string): T => JSON.parse(files[path] ?? "null") as T;
  const meta = parse<{ name?: string } | null>("tukurium.json");
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
  const paths = Object.keys(files).sort();
  for (const p of paths) {
    if (p.startsWith("kokostates/")) snap.kokostates.push(parse<KokoStateDef>(p));
    else if (p.startsWith("materials/")) snap.materials.push(parse<MaterialDef>(p));
    else if (p.startsWith("assets/")) snap.assets?.push(parse<AssetDef>(p));
    else if (p.startsWith("systems/") && p.endsWith(".json")) {
      const def = parse<SystemDef>(p);
      snap.systems.push({ ...def, code: files[p.replace(/\.json$/, ".js")] ?? "" });
    } else if (/^outputs\/[^/]+\/output\.json$/.test(p)) snap.outputs.push(parse<OutputDef>(p));
  }
  for (const o of snap.outputs) {
    const prefix = `outputs/${safe(o.id)}/entities/`;
    for (const p of paths) {
      if (p.startsWith(prefix))
        snap.entities.push({ ...parse<Omit<EntityDef, "output">>(p), output: o.id });
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
