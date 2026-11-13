import {
  acceptsUndefined,
  decodeValue,
  emptyValueOf,
  type FieldDef,
  type FieldValue,
  type KokoStateDef,
  knownSchema,
  refTargetOf,
  stringifyValue,
  type ValueSchema,
  type Vec3,
  validateValue,
  type World,
} from "@tukurium/eks";
import {
  type AssetKind,
  BASIC_FIELD_TYPES,
  BUILTIN,
  checkFieldValues,
  checkProjectReferences,
  checkProjectStructure,
  compileSystem,
  type Diagnostic,
  gunAndTargetSample,
  isBuiltin,
  KOKO_ROLES,
  newId,
  type PackageDependency,
  type PackageResolution,
  type ProjectDoc,
  REF_TARGET_LABEL,
  RESOURCE_FIELD_KIND,
  ResourcePathIndex,
} from "@tukurium/repo-model";
import {
  buildWorld,
  hostApiDeclarations,
  type LogEntry,
  Simulation,
  worldTransform,
} from "@tukurium/runtime";
import {
  ASSET_TYPES,
  type AssetStore,
  assetBytesMatch,
  MAX_ASSET_BYTES,
} from "../assets/assetStore";
import type { RepoService } from "../repos/service";
import {
  fieldSchemasOf,
  HOST_DECLARATIONS,
  packagesByAlias,
  sharedTypeChecker,
} from "../typecheck";
import type { AgentClient } from "./AgentClient";

/**
 * MCP の道具の中身（ADR 0054）。エージェントが開いたワークスペースの ProjectDoc を、人の画面と
 * 同じ操作で変える。ここでは MCP に依存しない（mcp.ts が道具として並べる）。
 * KokoState・欄・System・アウトプットは、ID でも名前でも指せる。
 */

/** 一覧から選べる型の名前（`BASIC_FIELD_TYPES`）。型は、これか TypeScript の型の文で書く */
export const FIELD_TYPES = BASIC_FIELD_TYPES.map((t) => t.key);

const MAX_SIM_SECONDS = 20;
const MAX_LISTED_ENTITIES = 200;
const MAX_ENTITY_OPS = 200;
const MAX_NEW_ENTITIES = 400;

export class AgentError extends Error {}

export function projectOf(agent: AgentClient): { project: ProjectDoc; workspaceId: string } {
  const w = agent.workspace;
  if (!w) throw new AgentError("ワークスペースを開いていません。open_workspace で開いてください");
  return { project: w.project, workspaceId: w.id };
}

export function writable(agent: AgentClient): ProjectDoc {
  const w = agent.workspace;
  if (!w) throw new AgentError("ワークスペースを開いていません。open_workspace で開いてください");
  if (w.role === "viewer")
    throw new AgentError("このワークスペースは閲覧だけです（共同編集の権限がありません）");
  return w.project;
}

const norm = (s: string) => s.normalize("NFC").toLowerCase();

/** ID か名前で一つに決める。見つからない・曖昧ならエラー */
function pick<T extends { id: string; name: string }>(list: T[], ref: string, what: string): T {
  const byId = list.find((x) => x.id === ref);
  if (byId) return byId;
  const hits = list.filter((x) => norm(x.name) === norm(ref));
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1)
    throw new AgentError(
      `${what}「${ref}」が複数あります。ID で指してください: ${hits.map((h) => h.id).join(", ")}`,
    );
  throw new AgentError(`${what}「${ref}」が見つかりません`);
}

export function kokoOf(project: ProjectDoc, ref: string): KokoStateDef {
  return pick(project.registry().all(), ref, "KokoState");
}

function fieldOf(def: KokoStateDef, ref: string): FieldDef {
  return pick(def.fields, ref, `${def.name} のフィールド`);
}

function outputOf(project: ProjectDoc, ref: string | undefined) {
  const outputs = project.outputs();
  if (!ref) {
    const first = outputs[0];
    if (!first) throw new AgentError("アウトプットがありません");
    return first;
  }
  return pick(outputs, ref, "アウトプット");
}

function entityOf(project: ProjectDoc, ref: string) {
  return pick(project.entities(), ref, "Entity");
}

/** ID か、一意な名前でリソースを一つに決める */
function resolveNamed(list: { id: string; name: string }[], value: string, what: string): string {
  if (list.some((x) => x.id === value)) return value;
  const hits = list.filter((x) => norm(x.name) === norm(value));
  if (hits.length === 1 && hits[0]) return hits[0].id;
  if (hits.length > 1)
    throw new AgentError(
      `${what}「${value}」が複数あります。ID で指してください: ${hits.map((h) => h.id).join(", ")}`,
    );
  throw new AgentError(`${what}「${value}」が見つかりません`);
}

function assetsOf(project: ProjectDoc, kind: AssetKind) {
  return project.assets().filter((a) => a.kind === kind);
}

/** 画像の素材を、ID か一意な名前で決める */
function imageOf(project: ProjectDoc, value: string, what: string): string {
  return resolveNamed(assetsOf(project, "image"), value, what);
}

/**
 * フィールドのスキーマ。Tukurium が用意する型は、型の文から分かる。ほかの型（リスト・レコードなど）は、
 * TypeScript で作る（初めて要るときだけ。ADR 0065）。型エラーで作れないフィールドは undefined。
 */
function schemaFor(project: ProjectDoc, kokoId: string, field: FieldDef): ValueSchema | undefined {
  return (
    knownSchema(field.type) ?? fieldSchemasOf(project.snapshot(), new Map())[kokoId]?.[field.id]
  );
}

/**
 * フィールドの型（スキーマ）に合わせて値を確かめる（JSON から来るので、形を直せるものは直す）。
 * 値は、保存する形（タグ付きの JSON。ADR 0065）で受け取る。参照の「なし」は `{"$t":"undefined"}`。
 * JSON には undefined がないので、参照と「なし」にできる型では、null も「なし」として受け取る。
 * 参照（Entity・Material・素材）は、ID でも一意な名前でも指せる。
 */
function coerce(project: ProjectDoc, kokoId: string, field: FieldDef, raw: unknown): FieldValue {
  const bad = (why?: string) =>
    new AgentError(
      `フィールド「${field.name}」（${field.type}）に使えない値です: ${stringifyValue(raw)}${why ? `（${why}）` : ""}`,
    );
  let value: unknown;
  try {
    value = decodeValue(raw);
  } catch {
    throw bad();
  }
  const schema = schemaFor(project, kokoId, field);
  // 型エラーで形が分からないフィールドは、値の形式で表せる値ならそのまま入れる（ADR 0065）
  if (!schema) return value as FieldValue;
  if (value === null && acceptsUndefined(schema)) value = undefined;
  const target = refTargetOf(schema);
  if (target && typeof value === "string") {
    const what = `フィールド「${field.name}」の${REF_TARGET_LABEL[target]}`;
    if (target === "entity") return entityOf(project, value).id;
    if (target === "material") return resolveNamed(project.materials(), value, what);
    return resolveNamed(assetsOf(project, RESOURCE_FIELD_KIND[target] as AssetKind), value, what);
  }
  if (schema.kind === "color" && typeof value === "string") value = value.toLowerCase();
  const why = validateValue(schema, value, { finite: isBuiltin(kokoId) });
  if (why) throw bad(why);
  return value as FieldValue;
}

/** { KokoState: { 欄: 値 } } を ID の形にする */
function toStates(
  project: ProjectDoc,
  states: Record<string, Record<string, unknown>>,
): Record<string, Record<string, FieldValue>> {
  const out: Record<string, Record<string, FieldValue>> = {};
  for (const [kokoRef, values] of Object.entries(states)) {
    const def = kokoOf(project, kokoRef);
    const v: Record<string, FieldValue> = {};
    for (const [fieldRef, raw] of Object.entries(values ?? {})) {
      const f = fieldOf(def, fieldRef);
      v[f.id] = coerce(project, def.id, f, raw);
    }
    out[def.id] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 見る

export function overview(project: ProjectDoc) {
  const snap = project.snapshot();
  const index = ResourcePathIndex.fromSnapshot(snap);
  const registry = project.registry();
  const nameOf = (id: string) => registry.get(id)?.name ?? id;
  return {
    name: snap.name,
    outputs: snap.outputs.map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind,
      systems: o.systems.map((s) => ({
        id: s.id,
        name: project.system(s.id)?.name ?? s.id,
        enabled: s.enabled,
      })),
      entities: project.entities(o.id).map((e) => ({
        id: e.id,
        name: e.name,
        parent: e.parent,
        kokostates: Object.keys(e.states).map(nameOf),
      })),
    })),
    kokostates: snap.kokostates.map((k) => ({
      id: k.id,
      name: k.name,
      path: index.pathOf(k.id),
      fields: k.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, default: f.default })),
    })),
    builtinKokostates: registry
      .all()
      .filter((k) => k.builtin)
      .map((k) => ({
        id: k.id,
        name: k.name,
        fields: k.fields.map((f) => `${f.name}: ${f.type}`),
      })),
    systems: snap.systems.map((s) => ({ id: s.id, name: s.name, path: index.pathOf(s.id) })),
    materials: snap.materials,
    assets: (snap.assets ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    dependencies: snap.dependencies ?? [],
  };
}

export function entityDetail(project: ProjectDoc, ref: string) {
  const e = entityOf(project, ref);
  const registry = project.registry();
  return {
    id: e.id,
    name: e.name,
    output: e.output,
    parent: e.parent,
    states: Object.fromEntries(
      Object.entries(e.states).map(([koko, values]) => {
        const def = registry.get(koko);
        return [
          def?.name ?? koko,
          Object.fromEntries(
            (def?.fields ?? []).map((f) => [f.name, f.id in values ? values[f.id] : f.default]),
          ),
        ];
      }),
    ),
  };
}

export function systemDetail(project: ProjectDoc, ref: string) {
  const s = pick(project.systems(), ref, "System");
  return { id: s.id, name: s.name, code: project.code(s.id)?.toString() ?? "" };
}

/** 制作データの親子から、実行時と同じ行列で世界座標を求める（配置の親は含めない） */
function worldPosition(world: World, id: string, fallback: unknown): Vec3 {
  if (!world.has(id)) return vec3Of(fallback);
  const pose = worldTransform(world, id);
  return [pose.position.x, pose.position.y, pose.position.z];
}

function vec3Of(value: unknown): Vec3 {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    return value as Vec3;
  return [0, 0, 0];
}

/**
 * Entity をまとめて読む。渡した条件はすべて満たすものだけ。
 * 件数の上限を超えても黙って切らず、truncated と全体の件数を返す。
 */
export function getEntities(
  project: ProjectDoc,
  args: {
    entities?: string[];
    name?: string;
    kokostate?: string;
    material?: string;
    parent?: string | null;
  },
) {
  let list = project.entities();
  if (args.entities) {
    const ids = new Set(args.entities.map((r) => entityOf(project, r).id));
    list = list.filter((e) => ids.has(e.id));
  }
  if (args.name) {
    const n = norm(args.name);
    list = list.filter((e) => norm(e.name).includes(n));
  }
  if (args.kokostate) {
    const koko = kokoOf(project, args.kokostate).id;
    list = list.filter((e) => koko in e.states);
  }
  if (args.material) {
    const mat = resolveNamed(project.materials(), args.material, "Material");
    list = list.filter((e) => e.states[BUILTIN.Mesh]?.material === mat);
  }
  if (args.parent !== undefined) {
    const parent = args.parent === null ? null : entityOf(project, args.parent).id;
    list = list.filter((e) => e.parent === parent);
  }
  const total = list.length;
  const page = list.slice(0, MAX_LISTED_ENTITIES);
  const worlds = new Map<string, World>();
  const worldOf = (output: string) => {
    let world = worlds.get(output);
    if (!world) {
      world = buildWorld(project.snapshot(), output, project.registry()).world;
      worlds.set(output, world);
    }
    return world;
  };
  return {
    total,
    truncated: total > page.length,
    entities: page.map((e) => ({
      ...entityDetail(project, e.id),
      worldPosition: worldPosition(worldOf(e.output), e.id, e.states[BUILTIN.Transform]?.position),
    })),
  };
}

// ---------------------------------------------------------------------------
// 作る・変える

export interface NamedRef {
  id: string;
  name: string;
}

export function createEntity(
  project: ProjectDoc,
  args: {
    name: string;
    output?: string;
    parent?: string | null;
    states?: Record<string, Record<string, unknown>>;
  },
): NamedRef {
  const output = outputOf(project, args.output);
  const parent = args.parent ? entityOf(project, args.parent).id : null;
  const states = toStates(project, args.states ?? {});
  const id = project.addEntity({ output: output.id, name: args.name, parent, states });
  return { id, name: args.name };
}

export function updateEntity(
  project: ProjectDoc,
  args: {
    entity: string;
    name?: string;
    parent?: string | null;
    states?: Record<string, Record<string, unknown>>;
    removeStates?: string[];
  },
): NamedRef {
  const e = entityOf(project, args.entity);
  const states = toStates(project, args.states ?? {});
  const remove = (args.removeStates ?? []).map((r) => kokoOf(project, r).id);
  project.transact(() => {
    if (args.name !== undefined) project.renameEntity(e.id, args.name);
    if (args.parent !== undefined)
      project.setParent(e.id, args.parent ? entityOf(project, args.parent).id : null);
    for (const [koko, values] of Object.entries(states)) {
      if (!(koko in (project.entity(e.id)?.states ?? {}))) project.addState(e.id, koko, values);
      else for (const [f, v] of Object.entries(values)) project.setField(e.id, koko, f, v);
    }
    for (const koko of remove) project.removeState(e.id, koko);
  });
  return { id: e.id, name: args.name ?? e.name };
}

export function deleteEntity(project: ProjectDoc, ref: string): NamedRef {
  const e = entityOf(project, ref);
  project.removeEntity(e.id);
  return { id: e.id, name: e.name };
}

interface FieldSpec {
  name: string;
  /** 一覧の名前（`FIELD_TYPES`）か、TypeScript の型の文 */
  type: string;
  default?: unknown;
}

/**
 * フィールドの定義を作る。同じ名前のフィールドがあれば、その ID を引き継ぐ（値が切れないように）。
 * 初期値を省いたときは、一覧の型ならその初期値、TypeScript で書いた型なら空の値（「なし」にできる型は
 * undefined、リストは空、数は 0 など）にする。
 */
function toFields(
  project: ProjectDoc,
  kokoId: string,
  specs: FieldSpec[],
  prev: FieldDef[] = [],
): FieldDef[] {
  return specs.map((s) => {
    const id =
      prev.find((p) => norm(p.name) === norm(s.name))?.id ??
      `f_${s.name.replace(/[^A-Za-z0-9_]/g, "") || "field"}_${Math.random().toString(36).slice(2, 6)}`;
    const basic = BASIC_FIELD_TYPES.find((t) => t.key === s.type);
    const base: FieldDef = {
      id,
      name: s.name,
      type: basic?.type ?? s.type,
      default: structuredClone(basic?.default),
    };
    if (s.default !== undefined)
      return { ...base, default: coerce(project, kokoId, base, s.default) };
    if (basic) return base;
    // TypeScript で書いた型：この型だけを持つ仮の定義から、スキーマを作る
    const probe = project.snapshot();
    probe.kokostates = [{ id: "ks_probe", name: "Probe", fields: [base] }];
    const schema = knownSchema(base.type) ?? fieldSchemasOf(probe, new Map()).ks_probe?.[base.id];
    return { ...base, default: schema ? emptyValueOf(schema) : undefined };
  });
}

export function createKokoState(
  project: ProjectDoc,
  args: { name: string; fields: FieldSpec[]; role?: string },
): NamedRef {
  const id = project.addKokoState(args.name);
  const def = project.kokostate(id);
  if (!def) throw new AgentError("KokoState を作れませんでした");
  project.updateKokoState({
    ...def,
    fields: toFields(project, id, args.fields),
    ...(args.role ? { role: args.role } : {}),
  });
  return { id, name: args.name };
}

export function updateKokoState(
  project: ProjectDoc,
  args: { kokostate: string; name?: string; fields?: FieldSpec[]; role?: string },
): NamedRef {
  const def = kokoOf(project, args.kokostate);
  if (def.builtin) throw new AgentError("Built-in の KokoState は変えられません");
  const name = args.name ?? def.name;
  project.updateKokoState({
    ...def,
    name,
    fields: args.fields ? toFields(project, def.id, args.fields, def.fields) : def.fields,
    ...(args.role !== undefined ? { role: args.role } : {}),
  });
  return { id: def.id, name };
}

export function createSystem(
  project: ProjectDoc,
  args: { name: string; code: string; output?: string; enable?: boolean },
): NamedRef {
  const id = project.addSystem(args.name, args.code);
  if (args.enable !== false) {
    const output = outputOf(project, args.output);
    project.updateOutput({ ...output, systems: [...output.systems, { id, enabled: true }] });
  }
  return { id, name: args.name };
}

export function updateSystem(
  project: ProjectDoc,
  args: { system: string; code?: string; name?: string },
): NamedRef {
  const s = pick(project.systems(), args.system, "System");
  project.transact(() => {
    if (args.name !== undefined) project.renameSystem(s.id, args.name);
    if (args.code !== undefined) {
      const text = project.code(s.id);
      if (!text) throw new AgentError("System のコードが見つかりません");
      text.delete(0, text.length);
      text.insert(0, args.code);
    }
  });
  return { id: s.id, name: args.name ?? s.name };
}

export function setOutputSystems(
  project: ProjectDoc,
  args: { output?: string; systems: { system: string; enabled?: boolean }[] },
): NamedRef {
  const output = outputOf(project, args.output);
  const systems = args.systems.map((s) => ({
    id: pick(project.systems(), s.system, "System").id,
    enabled: s.enabled !== false,
  }));
  project.updateOutput({ ...output, systems });
  return { id: output.id, name: output.name };
}

export function createMaterial(
  project: ProjectDoc,
  args: { name: string; color?: string; roughness?: number; metalness?: number; map?: string },
): NamedRef {
  const map = args.map ? imageOf(project, args.map, "Material の画像") : undefined;
  const id = project.addMaterial(args.name, {
    ...(args.color ? { color: args.color } : {}),
    ...(args.roughness !== undefined ? { roughness: args.roughness } : {}),
    ...(args.metalness !== undefined ? { metalness: args.metalness } : {}),
    ...(map ? { map } : {}),
  });
  return { id, name: args.name };
}

export function updateMaterial(
  project: ProjectDoc,
  args: {
    material: string;
    name?: string;
    color?: string;
    roughness?: number;
    metalness?: number;
    map?: string | null;
  },
): NamedRef {
  const m = pick(project.materials(), args.material, "Material");
  const name = args.name ?? m.name;
  const map =
    args.map === undefined
      ? (m.map ?? null)
      : args.map === null
        ? null
        : imageOf(project, args.map, "Material の画像");
  project.updateMaterial({
    ...m,
    name,
    color: args.color ?? m.color,
    roughness: args.roughness ?? m.roughness,
    metalness: args.metalness ?? m.metalness,
    map,
  });
  return { id: m.id, name };
}

/** 素材を人と同じ置き場へ入れ、制作データの一覧に加える */
export async function importAsset(
  project: ProjectDoc,
  store: AssetStore,
  args: { name: string; contentType: string; data: string },
): Promise<NamedRef & { kind: AssetKind; contentType: string; size: number }> {
  const contentType = args.contentType.split(";")[0]?.trim() ?? "";
  const kind = ASSET_TYPES[contentType];
  if (!kind) throw new AgentError("GLB・PNG・JPEG・WebP・MP3・OGG・WAV のみ受け付けます");
  const bytes = Buffer.from(args.data, "base64");
  if (bytes.length === 0) throw new AgentError("素材の中身が空です");
  if (bytes.length > MAX_ASSET_BYTES) throw new AgentError("素材は 20MB までです");
  if (!assetBytesMatch(contentType, bytes))
    throw new AgentError("ファイルの中身が、指定した種類と違います");
  const name = args.name.trim();
  if (!name) throw new AgentError("素材の名前が空です");
  const id = await store.put(bytes, contentType);
  project.addAsset({ id, name, kind, contentType });
  return { id, name, kind, contentType, size: bytes.length };
}

type StatesIn = Record<string, Record<string, unknown>>;

export type EntityOp =
  | {
      op: "create";
      ref?: string;
      name: string;
      output?: string;
      parent?: string | null;
      states?: StatesIn;
    }
  | {
      op: "update";
      entity: string;
      name?: string;
      parent?: string | null;
      states?: StatesIn;
      removeStates?: string[];
    }
  | { op: "delete"; entity: string }
  | {
      op: "duplicate";
      entity: string;
      copies: {
        ref?: string;
        name?: string;
        position?: Vec3;
        rotation?: Vec3;
        scale?: Vec3;
      }[];
    };

export type ApplyItem =
  | { ok: true; op: "create" | "update" | "delete"; id: string; name: string; ref?: string }
  | {
      ok: true;
      op: "duplicate";
      id: string;
      name: string;
      copies: {
        id: string;
        name: string;
        entities: { id: string; name: string; parent: string | null }[];
      }[];
    }
  | { ok: false; op: EntityOp["op"]; error: string };

interface VEnt {
  id: string;
  name: string;
  parent: string | null;
  output: string;
  states: Record<string, Record<string, FieldValue>>;
  alive: boolean;
}

type Step =
  | {
      kind: "create";
      id: string;
      name: string;
      output: string;
      parent: string | null;
      states: Record<string, Record<string, FieldValue>>;
    }
  | {
      kind: "update";
      id: string;
      name?: string;
      parent?: string | null;
      states: Record<string, Record<string, FieldValue>>;
      remove: string[];
    }
  | { kind: "delete"; id: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function resolveLive(
  live: Map<string, VEnt>,
  refs: Map<string, string>,
  failedRefs: Set<string>,
  token: string,
): VEnt {
  if (failedRefs.has(token))
    throw new AgentError(`「${token}」は、先の操作が失敗したため使えません`);
  const refId = refs.get(token);
  if (refId) {
    const hit = live.get(refId);
    if (hit?.alive) return hit;
    throw new AgentError(`「${token}」は、先の操作が失敗したため使えません`);
  }
  const byId = live.get(token);
  if (byId?.alive) return byId;
  const hits = [...live.values()].filter((e) => e.alive && norm(e.name) === norm(token));
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1)
    throw new AgentError(
      `Entity「${token}」が複数あります。ID で指してください: ${hits.map((h) => h.id).join(", ")}`,
    );
  throw new AgentError(`Entity「${token}」が見つかりません`);
}

function claimRef(ref: string | undefined, refs: Map<string, string>, failedRefs: Set<string>) {
  if (!ref) return;
  if (refs.has(ref) || failedRefs.has(ref))
    throw new AgentError(`別名「${ref}」はすでに使っています`);
}

function parentCycle(live: Map<string, VEnt>, id: string, parent: string | null): boolean {
  const seen = new Set<string>();
  let p = parent;
  while (p) {
    if (p === id) return true;
    if (seen.has(p)) return false;
    seen.add(p);
    const ent = live.get(p);
    if (!ent?.alive) return false;
    p = ent.parent;
  }
  return false;
}

/** 生きている子孫（自分は含まない）。幅優先 */
function liveDescendants(live: Map<string, VEnt>, id: string): VEnt[] {
  const root = live.get(id);
  if (!root?.alive) return [];
  const out: VEnt[] = [];
  const queue = [root];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) break;
    for (const e of live.values()) {
      if (!e.alive || e.parent !== cur.id || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      queue.push(e);
    }
  }
  return out;
}

function killTree(live: Map<string, VEnt>, id: string) {
  for (const child of liveDescendants(live, id)) child.alive = false;
  const root = live.get(id);
  if (root) root.alive = false;
}

function copyRootName(base: string, taken: Set<string>): string {
  for (let n = 1; n < 1000; n++) {
    const extra = n === 1 ? " のコピー" : ` のコピー ${n}`;
    const room = 64 - extra.length;
    if (room < 1) break;
    const name = `${base.slice(0, room)}${extra}`;
    if (!taken.has(norm(name))) {
      taken.add(norm(name));
      return name;
    }
  }
  throw new AgentError("コピーの名前を付けられません");
}

function withPose(
  states: Record<string, Record<string, FieldValue>>,
  pose: { position?: Vec3; rotation?: Vec3; scale?: Vec3 },
): Record<string, Record<string, FieldValue>> {
  if (!pose.position && !pose.rotation && !pose.scale) return states;
  const next = structuredClone(states);
  const t = { ...(next[BUILTIN.Transform] ?? {}) };
  if (pose.position) t.position = pose.position;
  if (pose.rotation) t.rotation = pose.rotation;
  if (pose.scale) t.scale = pose.scale;
  next[BUILTIN.Transform] = t;
  return next;
}

function commitStep(project: ProjectDoc, step: Step) {
  if (step.kind === "create") {
    project.addEntity({
      id: step.id,
      output: step.output,
      name: step.name,
      parent: step.parent,
      states: step.states,
    });
    return;
  }
  if (step.kind === "delete") {
    if (project.entity(step.id)) project.removeEntity(step.id);
    return;
  }
  if (!project.entity(step.id)) return;
  if (step.name !== undefined) project.renameEntity(step.id, step.name);
  if (step.parent !== undefined) project.setParent(step.id, step.parent);
  for (const [koko, values] of Object.entries(step.states)) {
    if (!(koko in (project.entity(step.id)?.states ?? {}))) project.addState(step.id, koko, values);
    else for (const [f, v] of Object.entries(values)) project.setField(step.id, koko, f, v);
  }
  for (const koko of step.remove) project.removeState(step.id, koko);
}

/**
 * Entity をまとめて作る・変える・消す・複製する。
 * 先にすべて検証し、成功したものだけを一つの変更に入れる。失敗は結果に分け、ほかを戻さない。
 */
export function applyEntities(project: ProjectDoc, ops: EntityOp[]): ApplyItem[] {
  if (ops.length > MAX_ENTITY_OPS)
    throw new AgentError(`一度に変えられる操作は ${MAX_ENTITY_OPS} までです`);
  const live = new Map<string, VEnt>();
  for (const e of project.entities()) {
    live.set(e.id, {
      id: e.id,
      name: e.name,
      parent: e.parent,
      output: e.output,
      states: structuredClone(e.states),
      alive: true,
    });
  }
  const refs = new Map<string, string>();
  const failedRefs = new Set<string>();
  const results: ApplyItem[] = [];
  const steps: Step[] = [];
  let created = 0;

  const failRefs = (op: EntityOp) => {
    if (op.op === "create" && op.ref) failedRefs.add(op.ref);
    if (op.op === "duplicate") for (const c of op.copies) if (c.ref) failedRefs.add(c.ref);
  };

  for (const op of ops) {
    const saved = new Map([...live].map(([k, v]) => [k, structuredClone(v)] as const));
    const savedRefs = new Map(refs);
    const createdBefore = created;
    const stepsBefore = steps.length;
    try {
      if (op.op === "create") {
        claimRef(op.ref, refs, failedRefs);
        const output = outputOf(project, op.output);
        if (output.kind === "library") throw new AgentError("ライブラリには Entity を作れません");
        let parent: string | null = null;
        if (op.parent) {
          const p = resolveLive(live, refs, failedRefs, op.parent);
          if (p.output !== output.id)
            throw new AgentError("親は同じアウトプットの Entity にしてください");
          parent = p.id;
        }
        if (created + 1 > MAX_NEW_ENTITIES)
          throw new AgentError(`一度に作れる Entity は ${MAX_NEW_ENTITIES} までです`);
        const states = toStates(project, op.states ?? {});
        const id = newId("ent");
        live.set(id, { id, name: op.name, parent, output: output.id, states, alive: true });
        if (op.ref) refs.set(op.ref, id);
        created += 1;
        steps.push({ kind: "create", id, name: op.name, output: output.id, parent, states });
        results.push({
          ok: true,
          op: "create",
          id,
          name: op.name,
          ...(op.ref ? { ref: op.ref } : {}),
        });
      } else if (op.op === "update") {
        const e = resolveLive(live, refs, failedRefs, op.entity);
        let parent: string | null | undefined;
        if (op.parent !== undefined) {
          if (op.parent === null) parent = null;
          else {
            const p = resolveLive(live, refs, failedRefs, op.parent);
            if (p.output !== e.output)
              throw new AgentError("親は同じアウトプットの Entity にしてください");
            if (parentCycle(live, e.id, p.id)) throw new AgentError("自分の子孫を親にはできません");
            parent = p.id;
          }
        }
        const states = toStates(project, op.states ?? {});
        const remove = (op.removeStates ?? []).map((r) => kokoOf(project, r).id);
        if (op.name !== undefined) e.name = op.name;
        if (parent !== undefined) e.parent = parent;
        for (const [koko, values] of Object.entries(states)) {
          e.states[koko] = { ...(e.states[koko] ?? {}), ...values };
        }
        for (const koko of remove) delete e.states[koko];
        steps.push({ kind: "update", id: e.id, name: op.name, parent, states, remove });
        results.push({ ok: true, op: "update", id: e.id, name: e.name });
      } else if (op.op === "delete") {
        const e = resolveLive(live, refs, failedRefs, op.entity);
        killTree(live, e.id);
        steps.push({ kind: "delete", id: e.id });
        results.push({ ok: true, op: "delete", id: e.id, name: e.name });
      } else {
        const source = resolveLive(live, refs, failedRefs, op.entity);
        const kids = liveDescendants(live, source.id);
        if (created + (1 + kids.length) * op.copies.length > MAX_NEW_ENTITIES)
          throw new AgentError(`一度に作れる Entity は ${MAX_NEW_ENTITIES} までです`);
        if (source.parent && !live.get(source.parent)?.alive)
          throw new AgentError("複製元の親がありません");
        const taken = new Set([...live.values()].filter((e) => e.alive).map((e) => norm(e.name)));
        const made: {
          id: string;
          name: string;
          entities: { id: string; name: string; parent: string | null }[];
        }[] = [];
        for (const copy of op.copies) {
          claimRef(copy.ref, refs, failedRefs);
          const rootName = copy.name ?? copyRootName(source.name, taken);
          if (copy.name) taken.add(norm(copy.name));
          const rootId = newId("ent");
          const map = new Map<string, string>([[source.id, rootId]]);
          const nodes: VEnt[] = [
            {
              id: rootId,
              name: rootName,
              parent: source.parent,
              output: source.output,
              states: withPose(structuredClone(source.states), copy),
              alive: true,
            },
          ];
          for (const kid of kids) {
            const id = newId("ent");
            map.set(kid.id, id);
            nodes.push({
              id,
              name: kid.name,
              parent: map.get(kid.parent ?? "") ?? rootId,
              output: kid.output,
              states: structuredClone(kid.states),
              alive: true,
            });
          }
          for (const node of nodes) {
            live.set(node.id, node);
            created += 1;
            steps.push({
              kind: "create",
              id: node.id,
              name: node.name,
              output: node.output,
              parent: node.parent,
              states: node.states,
            });
          }
          if (copy.ref) refs.set(copy.ref, rootId);
          made.push({
            id: rootId,
            name: rootName,
            entities: nodes.map((n) => ({ id: n.id, name: n.name, parent: n.parent })),
          });
        }
        const first = made[0];
        if (!first) throw new AgentError("複製するコピーがありません");
        results.push({ ok: true, op: "duplicate", id: first.id, name: first.name, copies: made });
      }
    } catch (e) {
      live.clear();
      for (const [k, v] of saved) live.set(k, v);
      refs.clear();
      for (const [k, v] of savedRefs) refs.set(k, v);
      created = createdBefore;
      steps.length = stepsBefore;
      failRefs(op);
      results.push({ ok: false, op: op.op, error: errText(e) });
    }
  }

  if (steps.length > 0) {
    project.transact(() => {
      for (const step of steps) commitStep(project, step);
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 確かめる

/** 依存のライブラリの中身（エージェントの利用者の許可で取り出す。クライアントと同じ形） */
export async function resolvePackages(
  repos: RepoService | null,
  user: { id: string } | null,
  deps: readonly PackageDependency[],
): Promise<{ direct: Map<string, PackageResolution>; pool: PackageResolution[] }> {
  const direct = new Map<string, PackageResolution>();
  const below: PackageResolution[] = [];
  for (const dep of deps) {
    try {
      if (!repos) throw new Error("ライブラリを取り出せません");
      const got = await repos.packageVersion(user, dep.packageId, dep.version);
      if (got.contentHash !== dep.contentHash) {
        direct.set(dep.alias, {
          status: "unavailable",
          dependency: dep,
          message: `v${dep.version} の中身が、足したときと違います`,
        });
        continue;
      }
      direct.set(dep.alias, { status: "ready", dependency: dep, manifest: got.manifest });
      below.push(...got.dependencies);
    } catch (e) {
      direct.set(dep.alias, {
        status: "unavailable",
        dependency: dep,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { direct, pool: [...direct.values(), ...below] };
}

const showDiagnostic = (d: Diagnostic) => ({
  severity: d.severity,
  code: d.code,
  message: d.message,
  subject: d.subject,
  ...(d.location ? { location: d.location } : {}),
  ...(d.detail ? { detail: d.detail } : {}),
});

/**
 * 作っている途中の問題：構造・参照・System の書き方と import・型の誤り
 * （スクリプトの実行時の問題は simulate で）。型の誤りがあっても simulate は動く。
 */
export async function check(
  project: ProjectDoc,
  packages: Map<string, PackageResolution>,
): Promise<ReturnType<typeof showDiagnostic>[]> {
  const snap = project.snapshot();
  const index = ResourcePathIndex.fromSnapshot(snap);
  // スクリプトとフィールドの型を確かめ、フィールドのスキーマを作る（ADR 0058・0065）
  const types = sharedTypeChecker().checkAll({
    snapshot: snap,
    packages,
    hostDeclarations: HOST_DECLARATIONS,
  });
  const out: Diagnostic[] = [
    ...checkProjectStructure(snap, index),
    ...checkProjectReferences(snap, types.schemas),
    ...checkFieldValues(snap, types.schemas),
  ];
  for (const s of snap.systems) {
    const compiled = compileSystem(s.id, s.code, index, packages);
    if (!compiled.ok) out.push(...compiled.diagnostics);
  }
  out.push(...types.diagnostics);
  return out.map(showDiagnostic);
}

export interface SimInput {
  at: number;
  action: string;
  phase?: "down" | "up";
  origin?: Vec3;
  direction?: Vec3;
}

/**
 * 試しに動かす：アウトプットを、手元（サーバー）の Simulation で決まった時間だけ動かし、
 * System の状態（止まった理由）・ログ・Entity の状態を返す。人の再生（Play）とは別で、誰にも見えない。
 */
export async function simulate(
  project: ProjectDoc,
  workspaceId: string,
  pool: PackageResolution[],
  args: {
    output?: string;
    seconds?: number;
    inputs?: SimInput[];
    watch?: string[];
    equip?: string[];
  },
) {
  const output = outputOf(project, args.output);
  const seconds = Math.min(Math.max(args.seconds ?? 2, 0), MAX_SIM_SECONDS);
  const logs: LogEntry[] = [];
  const snapshot = project.snapshot();
  const sim = await Simulation.create(snapshot, output.id, {
    realm: `agent:${workspaceId}`,
    onLog: (l) => logs.push(l),
    packages: pool,
    schemas: fieldSchemasOf(snapshot, packagesByAlias(pool)),
  });
  try {
    // 道具（EquipmentTool）を、始める前にエージェントが装備する（撃つなどの入力は装備した道具に届く）
    for (const ref of args.equip ?? []) {
      const id = entityOf(project, ref).id;
      const tool = sim.world.get(id, BUILTIN.EquipmentTool);
      if (!tool) throw new AgentError(`「${ref}」は道具（EquipmentTool）ではありません`);
      tool.player = "agent";
    }
    const dt = 1 / 60;
    const inputs = [...(args.inputs ?? [])].sort((a, b) => a.at - b.at);
    const frames = Math.round(seconds / dt);
    for (let i = 0; i < frames; i++) {
      const t = i * dt;
      while (inputs[0] && inputs[0].at <= t) {
        const ev = inputs.shift() as SimInput;
        sim.input({
          action: ev.action,
          phase: ev.phase ?? "down",
          origin: ev.origin ?? [0, 1.6, 0],
          direction: ev.direction ?? [0, 0, -1],
          player: "agent",
          playerName: "エージェント",
        });
      }
      sim.step(dt);
    }
    const registry = project.registry();
    const watch = args.watch?.map((r) => entityOf(project, r).id);
    const matched = project.entities(output.id).filter((e) => !watch || watch.includes(e.id));
    const entities = matched.slice(0, MAX_LISTED_ENTITIES).map((e) => ({
      id: e.id,
      name: e.name,
      states: Object.fromEntries(
        sim.world.statesOf(e.id).map((koko) => {
          const def = registry.get(koko);
          const values = sim.world.get(e.id, koko) ?? {};
          return [
            def?.name ?? koko,
            Object.fromEntries((def?.fields ?? []).map((f) => [f.name, values[f.id]])),
          ];
        }),
      ),
    }));
    return {
      output: output.name,
      seconds,
      systems: sim.systemStatus(),
      logs: logs.slice(-50),
      total: matched.length,
      truncated: matched.length > entities.length,
      entities,
    };
  } finally {
    sim.dispose();
  }
}

// ---------------------------------------------------------------------------
// 手引き

export function guide(): string {
  const sample = gunAndTargetSample();
  const shoot = sample.systems.find((s) => s.name === "Shoot")?.code ?? "";
  return [
    "# Tukurium で作るための手引き（エージェント向け）",
    "",
    "## 考え方",
    "- プロジェクトは、アウトプット（アイテム・ワールド・ライブラリ）と、その中の Entity の木でできている。",
    "- Entity には KokoState（続く状態。フィールドを持つ）を付ける。Transform・Mesh・Collider・RigidBody などは Built-in。",
    "- Collider が、プレイヤーと RigidBody の両方がぶつかる形。Mesh だけではすり抜ける。sensor が true なら押し返さず、当たったことだけが onCollision に届く。",
    "- Collider の shape が mesh（初期値）のときは Mesh の形。size が 0,0,0（初期値）のときは Mesh の大きさ。box / sphere / cylinder / capsule / plane と size で、見た目と別の当たり判定にできる。offset で中心からずらす。",
    "- RigidBody が無い Collider は動かない（壁・床・坂）。type は dynamic（重力で落ちる。初期値）/ kinematic（Transform に付いて動く）/ fixed。gravityScale を 0 にすると落ちない。高さ 0 の地面でも dynamic は止まる（原点からおよそ 200m の範囲）。",
    "- 街や地形では、歩かせたい床・止めたい壁・上れる坂に Collider を付ける。段差はおよそ 35cm までならプレイヤーが上れる。",
    "- 動きは System（TypeScript）で書く。System はアウトプットに入れて有効にすると動く。",
    '- KokoState は import して使う（例：import Gun from "./Gun.koko";、Built-in は @builtin/Transform.koko、ライブラリは @別名/...）。Query の with・without にも import した値を書く（"Gun" のような名前の文字列は使えない）。',
    "- Entity の値は e.get(Gun) で読み書きする。e.get() に渡せるのは、その System の query.with に書いた KokoState だけ。",
    "- 型の判定は厳しい（TypeScript の strict）。check が型エラーも返す（出どころ types）。型エラーがあっても simulate は動くが、直してから人に渡す。",
    "- 変更は、人の画面にそのまま届く。保存（コミット）は人が行う。エージェントは保存できない。",
    "",
    "## 進め方のおすすめ",
    "1. get_project で全体を見る。フィールドの値が要る Entity は get_entities でまとめて読む（世界座標も付く）。",
    "2. 足りない KokoState を create_kokostate で作り、Entity は apply_entities でまとめて作る・変える・消す・複製する。",
    "   - 同じ呼び出しの中では ref で親を指す。複製は画面の「中も含めて複製」と同じで、根の名前は「のコピー」が付く。",
    "   - 成功と失敗は操作ごとに分かれる。成功時は id と name が返る。",
    "3. 画像や GLB は import_asset で取り込み、create_material / update_material の map で材質に貼る。Mesh の model には GLB を、material には材質を、名前か ID で入れる。",
    "4. create_system で System を書く（既定でアウトプットに入り、有効になる）。",
    "5. check で問題を確かめ、simulate で試しに動かす。見た目は preview で、開いているブラウザの画面を指定した位置から撮る。",
    "   - simulate は total と truncated を返す。200 件を超えると、続きは含まれない。",
    "   - 銃などの道具（EquipmentTool）への入力（fire など）は、装備した人にだけ届く。simulate の equip に道具の Entity を渡すと、エージェントが装備した状態で始まる。",
    "   - preview は、人がワークスペースを開いている必要がある。再生中なら再生の画面、編集中なら制作データの見た目が写る。",
    "6. 終わったら、人に「保存してください」と伝える。",
    "",
    `## KokoState の役割（role）: ${KOKO_ROLES.map((r) => `${r.id}=${r.label}`).join(", ")}`,
    `## フィールドの型: ${FIELD_TYPES.join(", ")}。または TypeScript の型の文（例：\`{ suit: string; rank: number }[]\`、\`Record<string, number>\`、\`EntityRef | undefined\`）。「なし」は undefined（null は使えない）`,
    "",
    "## System の書き方（見本：サンプル「銃と的」の Shoot）",
    "```ts",
    shoot.trim(),
    "```",
    "",
    "## Host API（System から使える world.* などの型）",
    "```ts",
    hostApiDeclarations(),
    "```",
  ].join("\n");
}
