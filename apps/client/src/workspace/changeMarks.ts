import type { KokoStateDef } from "@tukurium/eks";
import {
  type EntityDef,
  entityFilePath,
  type FileMap,
  type KeepMark,
  kokoFilePath,
  type MaterialDef,
  materialFilePath,
  type OutputDef,
  outputFilePath,
  systemCodePath,
  systemMetaPath,
} from "@tukurium/repo-model";

/** 最後に保存した内容との差。緑が新しい、黄色が変わった。 */
export type ChangeKind = "added" | "modified";

export interface EntityChange {
  kind: ChangeKind | null;
  name: ChangeKind | null;
  parent: ChangeKind | null;
  /** KokoState ごとの印。fields は、その中で変わったフィールドだけ。 */
  states: Record<string, { kind: ChangeKind; fields: Record<string, ChangeKind> }>;
}

const NO_ENTITY: EntityChange = { kind: null, name: null, parent: null, states: {} };

interface SavedEntity {
  name?: string;
  parent?: string | null;
  states?: Record<string, Record<string, unknown>>;
}

function readJson<T>(files: FileMap, path: string): T | null {
  const raw = files[path];
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** キーの並びが違っても、中身が同じなら同じとみなす。 */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function keepKey(koko: string, field: string): string {
  return `${koko}\0${field}`;
}

function keepSet(marks: KeepMark[], entityId: string): Set<string> {
  const out = new Set<string>();
  for (const k of marks) if (k.entity === entityId) out.add(keepKey(k.koko, k.field));
  return out;
}

/**
 * Entity を、最後に保存したファイルと比べる。
 * 保存がまだ読めていないときは印を出さない（全部を新しく見せないため）。
 * 並び順だけの違いは印にしない。維持の切り替えは、そのフィールドの変化にする。
 */
export function entityChange(
  head: FileMap | null,
  entity: EntityDef,
  keep?: { saved: KeepMark[]; current: KeepMark[] },
): EntityChange {
  if (!head) return NO_ENTITY;
  const saved = readJson<SavedEntity>(head, entityFilePath(entity.output, entity.id));
  const savedKeep = keepSet(keep?.saved ?? [], entity.id);
  const currentKeep = keepSet(keep?.current ?? [], entity.id);
  if (!saved) {
    const states: EntityChange["states"] = {};
    for (const koko of Object.keys(entity.states)) states[koko] = { kind: "added", fields: {} };
    return {
      kind: "added",
      name: "added",
      parent: entity.parent ? "added" : null,
      states,
    };
  }
  const states: EntityChange["states"] = {};
  const beforeStates = saved.states ?? {};
  for (const [koko, values] of Object.entries(entity.states)) {
    const before = beforeStates[koko];
    if (!before) {
      states[koko] = { kind: "added", fields: {} };
      continue;
    }
    const fields: Record<string, ChangeKind> = {};
    for (const fid of new Set([...Object.keys(before), ...Object.keys(values)])) {
      if (!(fid in values)) continue;
      const fresh = !(fid in before);
      const valueChanged = !fresh && !same(before[fid], values[fid]);
      const keepChanged = savedKeep.has(keepKey(koko, fid)) !== currentKeep.has(keepKey(koko, fid));
      if (fresh) fields[fid] = "added";
      else if (valueChanged || keepChanged) fields[fid] = "modified";
    }
    if (Object.keys(fields).length > 0) states[koko] = { kind: "modified", fields };
  }
  const name = saved.name !== entity.name ? "modified" : null;
  const parent = (saved.parent ?? null) !== (entity.parent ?? null) ? "modified" : null;
  const kind = name || parent || Object.keys(states).length > 0 ? "modified" : null;
  return { kind, name, parent, states };
}

export function savedKeep(head: FileMap | null, outputId: string): KeepMark[] {
  if (!head) return [];
  return readJson<OutputDef>(head, outputFilePath(outputId))?.keep ?? [];
}

export interface KokoChange {
  kind: ChangeKind | null;
  name: ChangeKind | null;
  fields: Record<string, ChangeKind>;
}

/** KokoState の定義。Built-in は比べない。 */
export function kokoChange(head: FileMap | null, def: KokoStateDef): KokoChange {
  const empty: KokoChange = { kind: null, name: null, fields: {} };
  if (!head || def.builtin) return empty;
  const saved = readJson<KokoStateDef>(head, kokoFilePath(def.id));
  if (!saved) {
    const fields: Record<string, ChangeKind> = {};
    for (const f of def.fields) fields[f.id] = "added";
    return { kind: "added", name: "added", fields };
  }
  const prev = new Map(saved.fields.map((f) => [f.id, f]));
  const fields: Record<string, ChangeKind> = {};
  for (const f of def.fields) {
    const old = prev.get(f.id);
    if (!old) fields[f.id] = "added";
    else if (old.name !== f.name || old.type !== f.type || !same(old.default, f.default)) {
      fields[f.id] = "modified";
    }
  }
  const name = saved.name !== def.name ? "modified" : null;
  const kind = name || Object.keys(fields).length > 0 ? "modified" : null;
  return { kind, name, fields };
}

export interface SystemChange {
  kind: ChangeKind | null;
  name: ChangeKind | null;
  code: ChangeKind | null;
}

export function systemChange(
  head: FileMap | null,
  id: string,
  name: string,
  code: string,
): SystemChange {
  const empty: SystemChange = { kind: null, name: null, code: null };
  if (!head) return empty;
  const meta = readJson<{ name?: string }>(head, systemMetaPath(id));
  const savedCode = head[systemCodePath(id)];
  if (!meta && savedCode === undefined) return { kind: "added", name: "added", code: "added" };
  const nameKind: ChangeKind | null = !meta ? "added" : meta.name !== name ? "modified" : null;
  const codeKind: ChangeKind | null =
    savedCode === undefined ? "added" : savedCode !== code ? "modified" : null;
  const kind: ChangeKind | null =
    nameKind === "added" && codeKind === "added"
      ? "added"
      : nameKind || codeKind
        ? "modified"
        : null;
  return { kind, name: nameKind, code: codeKind };
}

export interface MaterialChange {
  kind: ChangeKind | null;
  name: ChangeKind | null;
  color: ChangeKind | null;
  roughness: ChangeKind | null;
  metalness: ChangeKind | null;
  map: ChangeKind | null;
}

export function materialChange(head: FileMap | null, material: MaterialDef): MaterialChange {
  const empty: MaterialChange = {
    kind: null,
    name: null,
    color: null,
    roughness: null,
    metalness: null,
    map: null,
  };
  if (!head) return empty;
  const saved = readJson<MaterialDef>(head, materialFilePath(material.id));
  if (!saved) {
    return {
      kind: "added",
      name: "added",
      color: "added",
      roughness: "added",
      metalness: "added",
      map: material.map ? "added" : null,
    };
  }
  const name = saved.name !== material.name ? "modified" : null;
  const color = saved.color !== material.color ? "modified" : null;
  const roughness = saved.roughness !== material.roughness ? "modified" : null;
  const metalness = saved.metalness !== material.metalness ? "modified" : null;
  const map = (saved.map ?? null) !== (material.map ?? null) ? "modified" : null;
  const kind = name || color || roughness || metalness || map ? "modified" : null;
  return { kind, name, color, roughness, metalness, map };
}

export interface OutputChange {
  kind: ChangeKind | null;
  name: ChangeKind | null;
  outputKind: ChangeKind | null;
  exposure: ChangeKind | null;
  guestPolicy: ChangeKind | null;
  /** 並び順を含む、Systems 全体 */
  systems: ChangeKind | null;
  /** System 1 件。追加か、有効・無効の変更 */
  systemRows: Record<string, ChangeKind>;
}

export function outputChange(head: FileMap | null, output: OutputDef): OutputChange {
  const empty: OutputChange = {
    kind: null,
    name: null,
    outputKind: null,
    exposure: null,
    guestPolicy: null,
    systems: null,
    systemRows: {},
  };
  if (!head) return empty;
  const saved = readJson<OutputDef>(head, outputFilePath(output.id));
  if (!saved) {
    const systemRows: Record<string, ChangeKind> = {};
    for (const s of output.systems) systemRows[s.id] = "added";
    return {
      kind: "added",
      name: "added",
      outputKind: "added",
      exposure: "added",
      guestPolicy: output.kind === "world" ? "added" : null,
      systems: output.systems.length > 0 ? "added" : null,
      systemRows,
    };
  }
  const name = saved.name !== output.name ? "modified" : null;
  const outputKind = saved.kind !== output.kind ? "modified" : null;
  const exposure =
    (saved.exposure ?? "interactive") !== (output.exposure ?? "interactive") ? "modified" : null;
  const guestPolicy =
    output.kind === "world" &&
    (saved.guestPolicy ?? "interactive") !== (output.guestPolicy ?? "interactive")
      ? "modified"
      : null;
  const systemRows: Record<string, ChangeKind> = {};
  const prev = new Map(saved.systems.map((s) => [s.id, s]));
  for (const s of output.systems) {
    const old = prev.get(s.id);
    if (!old) systemRows[s.id] = "added";
    else if (old.enabled !== s.enabled) systemRows[s.id] = "modified";
  }
  const systems = !same(saved.systems, output.systems) ? "modified" : null;
  const kind = name || outputKind || exposure || guestPolicy || systems ? "modified" : null;
  return { kind, name, outputKind, exposure, guestPolicy, systems, systemRows };
}

/**
 * 閉じているときに、自分は変わっていなくても、中の変化を丸で見せる。
 * 新しいものが一つでもあれば緑、なければ黄色。
 */
export function treeMark(
  own: ChangeKind | null,
  collapsed: boolean,
  descendants: ChangeKind[],
): { kind: ChangeKind | null; nested: boolean } {
  if (own) return { kind: own, nested: false };
  if (!collapsed) return { kind: null, nested: false };
  if (descendants.includes("added")) return { kind: "added", nested: true };
  if (descendants.includes("modified")) return { kind: "modified", nested: true };
  return { kind: null, nested: false };
}

export type DropMode = "before" | "inside" | "after";

/**
 * ドロップの位置。行の上端・下端は兄弟としての並び替え、真ん中はその子。
 * target が null のときは、いちばん上（親なし）の末尾。
 * 自分の中には入れられない。
 */
export function dropPlacement(
  nodes: { id: string; parent: string | null }[],
  dragId: string,
  targetId: string | null,
  mode: DropMode,
): { parent: string | null; index: number } | null {
  if (targetId === null) {
    if (!canParent(nodes, dragId, null)) return null;
    return {
      parent: null,
      index: nodes.filter((n) => n.parent === null && n.id !== dragId).length,
    };
  }
  const target = nodes.find((n) => n.id === targetId);
  if (!target) return null;
  if (mode === "inside") {
    if (!canParent(nodes, dragId, targetId)) return null;
    return {
      parent: targetId,
      index: nodes.filter((n) => n.parent === targetId && n.id !== dragId).length,
    };
  }
  if (!canParent(nodes, dragId, target.parent)) return null;
  const siblings = nodes.filter((n) => n.parent === target.parent && n.id !== dragId);
  const at = siblings.findIndex((n) => n.id === targetId);
  if (at < 0) return null;
  return { parent: target.parent, index: mode === "before" ? at : at + 1 };
}

/** ドラッグした Entity を、その Entity（またはその中）の子にはできない。 */
export function canParent(
  nodes: { id: string; parent: string | null }[],
  id: string,
  parent: string | null,
): boolean {
  if (parent === id) return false;
  const parents = new Map(nodes.map((n) => [n.id, n.parent]));
  if (!parents.has(id)) return false;
  if (parent !== null && !parents.has(parent)) return false;
  const seen = new Set<string>();
  for (let p = parent; p; p = parents.get(p) ?? null) {
    if (p === id) return false;
    if (seen.has(p)) return true;
    seen.add(p);
  }
  return true;
}

/** id 自身と、その中にある Entity。親子が輪になっていても一周で止める。 */
export function selfAndDescendants(
  nodes: { id: string; parent: string | null }[],
  id: string,
): string[] {
  const out = [id];
  const seen = new Set<string>(out);
  for (let i = 0; i < out.length; i++) {
    for (const n of nodes) {
      const cur = out[i];
      if (n.parent === cur && !seen.has(n.id)) {
        seen.add(n.id);
        out.push(n.id);
      }
    }
  }
  return out;
}
