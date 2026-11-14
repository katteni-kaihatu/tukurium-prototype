import {
  decodeValue,
  type EntityId,
  encodeValue,
  equalValues,
  type FieldDef,
  type FieldSchemas,
  type FieldValue,
  hasRefs,
  type Json,
  type KokoStateDef,
  type KokoStateId,
  type KokoStateValues,
  mapRefs,
  schemaOfField,
} from "@tukurium/eks";
import * as Y from "yjs";
import { BUILTIN_KOKOSTATES, buildRegistry, isBuiltin } from "./builtins";
import { assignOrderKeys } from "./orderKey";
import { validateAlias } from "./packageDependency";
import {
  EXPANDED_ID_SEPARATOR,
  type ExpandedEntity,
  expandPrefabForEdit,
  expandPrefabs,
} from "./prefab";
import {
  type PrefabFromEntityOptions,
  type PrefabFromEntityPlan,
  type PrefabFromEntityResult,
  planPrefabFromEntity,
} from "./prefabFromEntity";
import { normalizeName, validateName } from "./resourcePath";
import {
  type AssetDef,
  type EntityBase,
  type EntityDef,
  type FolderDef,
  type MaterialDef,
  newId,
  type OutputDef,
  type OutputKind,
  type OutputSystem,
  type PackageDependency,
  type PrefabDef,
  type PrefabEntityDef,
  type PrefabEntityOverride,
  type PrefabInstanceLink,
  type ProjectSnapshot,
  type SystemDef,
  type TypeDef,
} from "./schema";
import {
  decodeKokoState,
  decodeStates,
  encodeValues,
  type StoredKokoState,
  type StoredValues,
} from "./storedValues";
import { planImportRefactor } from "./systemCompiler";
import { renameTypeName } from "./typeText";

const clone = <T>(v: T): T => structuredClone(v);
const TRANSFORM = "builtin.Transform";

/** Entity の KokoState の値を入れる Y.Map（フィールド ID → 保存する形の値） */
type ValueMap = Y.Map<Json>;
const valueMap = (values: KokoStateValues): ValueMap =>
  new Y.Map<Json>(Object.entries(encodeValues(values)));
/** 参照の「なし」（undefined）を保存する形にしたもの */
const none = (): Json => encodeValue(undefined);

/**
 * KokoState の定義を入れる Y.Map（ADR 0065）。フィールドごとに Y.Map を持つので、
 * 2 人が別のフィールドを同時に変えても、両方の変更が残る（フィールドごとの後勝ち）。
 * - id / name / role / typeDefs（使う型の定義の ID の一覧。一覧まるごとの後勝ち）
 * - fields : Y.Map<フィールドの ID, Y.Map>  name, type, default（保存する形の値）, order（並べ替え用のキー）
 */
type KokoMap = Y.Map<unknown>;
type FieldMap = Y.Map<unknown>;

function fieldMap(f: FieldDef, order: string): FieldMap {
  const m: FieldMap = new Y.Map<unknown>();
  m.set("name", f.name);
  m.set("type", f.type);
  m.set("default", encodeValue(f.default));
  m.set("order", order);
  return m;
}

function kokoMapOf(def: KokoStateDef): KokoMap {
  const m: KokoMap = new Y.Map<unknown>();
  m.set("id", def.id);
  m.set("name", def.name);
  if (def.role !== undefined) m.set("role", def.role);
  if (def.typeDefs !== undefined) m.set("typeDefs", [...def.typeDefs]);
  const fields = new Y.Map<FieldMap>();
  const keys = assignOrderKeys(def.fields.map(() => undefined));
  def.fields.forEach((f, i) => {
    fields.set(f.id, fieldMap(f, keys[i] as string));
  });
  m.set("fields", fields);
  return m;
}

/** フィールドを、並べ替え用のキーの順に読む（同じキーは、ID の順） */
function readFields(fields: Y.Map<FieldMap>): (FieldDef & { order: string })[] {
  const list = [...fields.entries()].map(([id, f]) => ({
    id,
    name: String(f.get("name") ?? id),
    type: String(f.get("type") ?? ""),
    default: decodeValue(f.get("default")) as FieldValue,
    order: String(f.get("order") ?? ""),
  }));
  return list.sort((a, b) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/** 定義を読む。前の形（定義まるごとが一つの値）で入っているものも読める */
function readKoko(stored: KokoMap | StoredKokoState): KokoStateDef {
  if (!(stored instanceof Y.Map)) return decodeKokoState(stored);
  const role = stored.get("role");
  const typeDefs = stored.get("typeDefs");
  return {
    id: String(stored.get("id")),
    name: String(stored.get("name")),
    ...(typeof role === "string" ? { role } : {}),
    ...(Array.isArray(typeDefs) ? { typeDefs: typeDefs.map(String) } : {}),
    fields: readFields(stored.get("fields") as Y.Map<FieldMap>).map(({ order: _order, ...f }) => f),
  };
}

type OverrideStore = Y.Map<Json>;
interface OverrideTarget {
  owner: Y.Map<unknown>;
  path: string;
  entity: ExpandedEntity;
  base: ExpandedEntity;
}
const overrideKey = (...parts: string[]): string => JSON.stringify(parts);

/** 1 フィールドを 1 キーにする。最初の同時編集でも、途中の入れ物の作成が競合しない。 */
function overridesMap(overrides: Record<string, PrefabEntityOverride>): OverrideStore {
  const out = new Y.Map<Json>();
  for (const [path, value] of Object.entries(overrides)) {
    for (const key of ["name", "parent", "order"] as const)
      if (Object.hasOwn(value, key)) out.set(overrideKey(path, key), encodeValue(value[key]));
    for (const group of ["states", "addedStates"] as const)
      for (const [koko, values] of Object.entries(value[group] ?? {})) {
        if (group === "addedStates") out.set(overrideKey(path, group, koko), true);
        for (const [field, v] of Object.entries(values))
          out.set(overrideKey(path, group, koko, field), encodeValue(v));
      }
  }
  return out;
}

function readOverrides(map: OverrideStore): Record<string, PrefabEntityOverride> {
  const out: Record<string, PrefabEntityOverride> = {};
  for (const [key, stored] of map) {
    const [path, group, koko, field] = JSON.parse(key) as string[];
    if (path === undefined || group === undefined) continue;
    out[path] ??= {};
    const value = out[path];
    if (group === "name" || group === "parent" || group === "order") {
      Object.assign(value, { [group]: decodeValue(stored) });
    } else if ((group === "states" || group === "addedStates") && koko !== undefined) {
      value[group] ??= {};
      const states = value[group];
      states[koko] ??= {};
      const values = states[koko];
      if (field !== undefined) values[field] = decodeValue(stored) as FieldValue;
    }
  }
  return out;
}

/**
 * ワークスペースの制作データ（編集中）。Y.Doc の上に載せ、共同編集でそのまま同期できるようにする。
 *
 * 構造：
 * - meta        : Y.Map            name
 * - kokostates  : Y.Map<Y.Map>          利用者定義（Built-in は含めない）。フィールドごとの Y.Map を持つ
 * - systems     : Y.Map<SystemDef>
 * - code        : Y.Map<Y.Text>         System のスクリプトと、型の定義の中身（文字単位で共同編集）
 * - types       : Y.Map<TypeDef>        型の定義（ADR 0065）
 * - materials   : Y.Map<MaterialDef>
 * - outputs     : Y.Map<OutputDef>
 * - entities    : Y.Map<Y.Map>          id, name, parent, output, order, states(Y.Map<Y.Map<Json>>),
 *                                       instanceOf, prefabOverrides（パス・KokoState・フィールドをキーにする Y.Map）
 * - prefabs     : Y.Map<PrefabDef>      プレハブ（ADR 0076）
 * - prefabEntities : Y.Map<Y.Map>       プレハブの中の Entity。entities と同じ形で、output の代わりに prefab
 *
 * フィールドの値と初期値は、タグ付きの JSON（ADR 0065）で入れる。JSON で表せない値
 * （undefined・Date・Map など）も、そのまま同期・保存できる。読むときに値へ戻す。
 *
 * 変更はすべて transact でまとめ、利用者の 1 操作が 1 つの更新になるようにする。
 */
export class ProjectDoc {
  readonly doc: Y.Doc;
  /**
   * 依存から取り込んだ KokoState の定義（ADR 0015）。各クライアントが依存の中身から作る派生データで、
   * Y.Doc には入れない（同期も保存もしない）。Entity に付けたり、Inspector で値を入れたりするために使う。
   */
  private packageDefs: KokoStateDef[] = [];

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
  }

  private get meta() {
    return this.doc.getMap<string>("meta");
  }
  private get kokoMap() {
    return this.doc.getMap<KokoMap | StoredKokoState>("kokostates");
  }
  private get systemMap() {
    return this.doc.getMap<SystemDef>("systems");
  }
  private get codeMap() {
    return this.doc.getMap<Y.Text>("code");
  }
  /** 型の定義（ADR 0065）。コードは、System と同じ code に入れる */
  private get typeMap() {
    return this.doc.getMap<TypeDef>("types");
  }
  private get materialMap() {
    return this.doc.getMap<MaterialDef>("materials");
  }
  private get assetMap() {
    return this.doc.getMap<AssetDef>("assets");
  }
  private get folderMap() {
    return this.doc.getMap<FolderDef>("folders");
  }
  /** リソース ID → フォルダ ID */
  private get placementMap() {
    return this.doc.getMap<string>("placement");
  }
  /** 使うライブラリ（別名 → 依存。ADR 0015） */
  private get dependencyMap() {
    return this.doc.getMap<PackageDependency>("dependencies");
  }
  private get outputMap() {
    return this.doc.getMap<OutputDef>("outputs");
  }
  private get entityMap() {
    return this.doc.getMap<Y.Map<unknown>>("entities");
  }
  private get prefabMap() {
    return this.doc.getMap<PrefabDef>("prefabs");
  }
  /** プレハブの中の Entity（ADR 0076）。アウトプットの Entity とは別に持つ */
  private get prefabEntityMap() {
    return this.doc.getMap<Y.Map<unknown>>("prefabEntities");
  }
  /** アウトプットの Entity か、プレハブの中の Entity（ID は両方を通して一つ） */
  private node(id: EntityId): Y.Map<unknown> | undefined {
    return this.entityMap.get(id) ?? this.prefabEntityMap.get(id);
  }
  /** すべての Entity（アウトプットのものと、プレハブの中のもの） */
  private nodes(): Y.Map<unknown>[] {
    return [...this.entityMap.values(), ...this.prefabEntityMap.values()];
  }

  transact(fn: () => void, origin: unknown = "local"): void {
    this.doc.transact(fn, origin);
  }

  /** 変更を購読する。戻り値で解除。 */
  observe(fn: (origin: unknown) => void): () => void {
    const handler = (_u: Uint8Array, origin: unknown) => fn(origin);
    this.doc.on("update", handler);
    return () => this.doc.off("update", handler);
  }

  // ---------- 名前 ----------
  get name(): string {
    return this.meta.get("name") ?? "untitled";
  }
  setName(name: string): void {
    this.meta.set("name", name);
  }

  // ---------- KokoState 定義 ----------
  kokostates(): KokoStateDef[] {
    return [...this.kokoMap.values()].map(readKoko);
  }
  kokostate(id: KokoStateId): KokoStateDef | undefined {
    const d = this.kokoMap.get(id);
    return d ? readKoko(d) : undefined;
  }
  registry() {
    return buildRegistry([...this.kokostates(), ...this.packageDefs]);
  }
  /** 依存から取り込んだ KokoState の定義を入れ替える（packageKokoStates の結果） */
  setPackageKokoStates(defs: readonly KokoStateDef[]): void {
    this.packageDefs = defs.map(clone);
  }
  packageKokoStates(): KokoStateDef[] {
    return this.packageDefs.map(clone);
  }
  addKokoState(name: string): KokoStateId {
    this.assertKokoName(name, null);
    const id = newId("ks");
    this.kokoMap.set(id, kokoMapOf({ id, name, fields: [] }));
    return id;
  }
  /** 定義を書き換える。フィールドを消した・型を変えた場合、Entity の値も合わせる。 */
  updateKokoState(def: KokoStateDef): void {
    const renamed = this.kokostate(def.id)?.name !== def.name;
    if (renamed) this.refactoring(() => this.updateKokoStateNow(def));
    else this.updateKokoStateNow(def);
  }
  private updateKokoStateNow(def: KokoStateDef): void {
    if (isBuiltin(def.id)) throw new Error("Built-in の KokoState は変更できません");
    this.assertKokoName(def.name, def.id);
    const ids = new Set<string>();
    for (const f of def.fields) {
      if (ids.has(f.id)) throw new Error(`フィールド ID が重複しています: ${f.id}`);
      ids.add(f.id);
    }
    const names = def.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) throw new Error("フィールド名が重複しています");
    // 名前を変えたら、型の文でこの KokoState を指している所（`KokoStateRef<Health>`）も書き直す。
    // 同じ名前の KokoState がほかにあるときは、どれを指しているか決まらないので書き直さない
    const before = this.kokostate(def.id);
    const rename =
      before &&
      before.name !== def.name &&
      this.kokostates().filter((k) => k.name === before.name).length === 1
        ? { from: before.name, to: def.name }
        : null;
    const renamed = (type: string) =>
      rename ? renameTypeName(type, rename.from, rename.to) : type;
    if (rename) def = { ...def, fields: def.fields.map((f) => ({ ...f, type: renamed(f.type) })) };
    this.transact(() => {
      const stored = this.kokoMap.get(def.id);
      const prev = stored ? readKoko(stored) : undefined;
      if (!(stored instanceof Y.Map)) {
        this.kokoMap.set(def.id, kokoMapOf(def));
      } else {
        // 変わった所だけを書く。同時に別のフィールドを変えた人の変更を、上書きしない
        if (prev?.name !== def.name) stored.set("name", def.name);
        if (prev?.role !== def.role) {
          if (def.role === undefined) stored.delete("role");
          else stored.set("role", def.role);
        }
        if (!equalValues(prev?.typeDefs, def.typeDefs)) {
          if (def.typeDefs === undefined) stored.delete("typeDefs");
          else stored.set("typeDefs", [...def.typeDefs]);
        }
        const fields = stored.get("fields") as Y.Map<FieldMap>;
        for (const id of [...fields.keys()]) if (!ids.has(id)) fields.delete(id);
        const current = new Map(readFields(fields).map((f) => [f.id, f]));
        const keys = assignOrderKeys(def.fields.map((f) => current.get(f.id)?.order));
        def.fields.forEach((f, i) => {
          const key = keys[i] as string;
          const m = fields.get(f.id);
          const old = current.get(f.id);
          if (!m || !old) {
            fields.set(f.id, fieldMap(f, key));
            return;
          }
          if (old.name !== f.name) m.set("name", f.name);
          if (old.type !== f.type) m.set("type", f.type);
          if (!equalValues(old.default, f.default)) m.set("default", encodeValue(f.default));
          if (old.order !== key) m.set("order", key);
        });
      }
      // ほかの KokoState の型の文も、新しい名前に合わせる（値には触れない）
      if (rename)
        for (const [otherId, other] of this.kokoMap) {
          if (otherId === def.id || !(other instanceof Y.Map)) continue;
          for (const m of (other.get("fields") as Y.Map<FieldMap>).values()) {
            const type = String(m.get("type") ?? "");
            if (renamed(type) !== type) m.set("type", renamed(type));
          }
        }
      if (!prev) return;
      // Entity が持っている値を新しい定義に合わせる：消えたフィールドは削除、足したフィールドと
      // 型が変わったフィールドは初期値。ほかのフィールドの値には触れない（同時に値を変えた人の変更を残す）
      for (const e of this.nodes()) {
        const overrides = e.get("prefabOverrides") as OverrideStore | undefined;
        for (const [key] of overrides ?? []) {
          const [path, group, koko, field] = JSON.parse(key) as string[];
          if (koko !== def.id || (group !== "states" && group !== "addedStates")) continue;
          if (field === undefined && group === "addedStates" && path !== undefined) {
            for (const f of def.fields) {
              const old = prev.fields.find((p) => p.id === f.id);
              const fieldKey = overrideKey(path, group, koko, f.id);
              if (!old || renamed(old.type) !== f.type || !overrides?.has(fieldKey))
                overrides?.set(fieldKey, encodeValue(f.default));
            }
          } else if (field !== undefined) {
            const f = def.fields.find((f) => f.id === field);
            const old = prev.fields.find((f) => f.id === field);
            if (!f) overrides?.delete(key);
            else if (!old || renamed(old.type) !== f.type)
              overrides?.set(key, encodeValue(f.default));
          }
        }
        const states = e.get("states") as Y.Map<ValueMap>;
        const values = states.get(def.id);
        if (!values) continue;
        for (const field of [...values.keys()]) if (!ids.has(field)) values.delete(field);
        for (const f of def.fields) {
          const old = prev.fields.find((p) => p.id === f.id);
          // 名前の書き直しだけなら、型は変わっていない
          if (old && renamed(old.type) === f.type && values.has(f.id)) continue;
          values.set(f.id, encodeValue(f.default));
        }
      }
    });
  }
  removeKokoState(id: KokoStateId): void {
    this.transact(() => {
      this.kokoMap.delete(id);
      for (const e of this.nodes()) {
        (e.get("states") as Y.Map<unknown>).delete(id);
        this.deleteStoredOverrides(
          e,
          (parts) => (parts[1] === "states" || parts[1] === "addedStates") && parts[2] === id,
        );
      }
    });
  }
  private assertKokoName(name: string, self: KokoStateId | null): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("KokoState の名前は英字で始まる英数字と _ にしてください");
    }
    // Built-in と同じ名前は、移行の間の名前での書き方（with: ["Transform"]）が曖昧になるので拒む
    if (BUILTIN_KOKOSTATES.some((b) => b.name === name))
      throw new Error(`名前「${name}」は Built-in の KokoState が使っています`);
    // 名前はプロジェクト全体で一つでなくてよい（同一性は ID。ADR 0010）。同じ場所の中だけで一つにする
    if (self !== null && this.kokostate(self)?.name !== name) this.assertSiblingName(name, self);
  }

  // ---------- System ----------
  systems(): SystemDef[] {
    return [...this.systemMap.values()].map(clone);
  }
  system(id: string): SystemDef | undefined {
    const s = this.systemMap.get(id);
    return s ? clone(s) : undefined;
  }
  code(id: string): Y.Text | undefined {
    return this.codeMap.get(id);
  }
  addSystem(name: string, code: string): string {
    const id = newId("sys");
    this.transact(() => {
      this.systemMap.set(id, { id, name });
      const text = new Y.Text();
      text.insert(0, code);
      this.codeMap.set(id, text);
    });
    return id;
  }
  renameSystem(id: string, name: string): void {
    const s = this.systemMap.get(id);
    if (!s || s.name === name) return;
    this.assertSiblingName(name, id);
    this.systemMap.set(id, { ...s, name });
  }
  removeSystem(id: string): void {
    this.transact(() => {
      this.systemMap.delete(id);
      this.codeMap.delete(id);
      for (const e of this.nodes()) {
        const systems = e.get("instanceSystems") as OutputSystem[] | undefined;
        if (systems?.some((s) => s.id === id)) {
          const left = systems.filter((s) => s.id !== id);
          if (left.length > 0) e.set("instanceSystems", left);
          else e.delete("instanceSystems");
        }
      }
      for (const o of this.outputMap.values()) {
        if (o.systems.some((s) => s.id === id)) {
          this.outputMap.set(o.id, { ...o, systems: o.systems.filter((s) => s.id !== id) });
        }
      }
      for (const p of this.prefabMap.values()) {
        if (p.systems.some((s) => s.id === id)) {
          this.prefabMap.set(p.id, { ...p, systems: p.systems.filter((s) => s.id !== id) });
        }
      }
    });
  }

  // ---------- 型の定義（ADR 0065） ----------
  typeDefs(): TypeDef[] {
    return [...this.typeMap.values()].map(clone);
  }
  typeDef(id: string): TypeDef | undefined {
    const t = this.typeMap.get(id);
    return t ? clone(t) : undefined;
  }
  addTypeDef(name: string, code: string): string {
    const id = newId("td");
    this.transact(() => {
      this.typeMap.set(id, { id, name });
      const text = new Y.Text();
      text.insert(0, code);
      this.codeMap.set(id, text);
    });
    return id;
  }
  /** 名前を変える。KokoState は ID で結び付いているので、使っている所は切れない */
  renameTypeDef(id: string, name: string): void {
    const t = this.typeMap.get(id);
    if (!t || t.name === name) return;
    this.assertSiblingName(name, id);
    this.refactoring(() => this.typeMap.set(id, { ...t, name }));
  }
  /** 型の定義を消す。使っていた KokoState の一覧からも外す（その型を使うフィールドは、型エラーになる） */
  removeTypeDef(id: string): void {
    this.transact(() => {
      this.typeMap.delete(id);
      this.codeMap.delete(id);
      for (const k of this.kokoMap.values()) {
        if (!(k instanceof Y.Map)) continue;
        const uses = k.get("typeDefs");
        if (Array.isArray(uses) && uses.includes(id))
          k.set(
            "typeDefs",
            uses.filter((x) => x !== id),
          );
      }
    });
  }
  /** 型の定義の名前とコードを、渡した形にする（なければ作る）。開いているエディタはそのまま使える */
  restoreTypeDef(def: TypeDef, code: string): void {
    this.transact(() => {
      this.typeMap.set(def.id, { id: def.id, name: def.name });
      this.setCode(def.id, code);
    });
  }
  private setCode(id: string, code: string): void {
    let text = this.codeMap.get(id);
    if (!text) {
      text = new Y.Text();
      this.codeMap.set(id, text);
    }
    if (text.toString() !== code) {
      text.delete(0, text.length);
      text.insert(0, code);
    }
  }

  // ---------- マテリアル ----------
  materials(): MaterialDef[] {
    return [...this.materialMap.values()].map(clone);
  }
  material(id: string): MaterialDef | undefined {
    const m = this.materialMap.get(id);
    return m ? clone(m) : undefined;
  }
  addMaterial(name: string, init: Partial<Omit<MaterialDef, "id" | "name">> = {}): string {
    const id = newId("mat");
    this.materialMap.set(id, { id, name, color: "#d8d2c6", roughness: 0.6, metalness: 0, ...init });
    return id;
  }
  updateMaterial(m: MaterialDef): void {
    const prev = this.materialMap.get(m.id);
    if (prev && prev.name !== m.name) this.assertSiblingName(m.name, m.id);
    this.materialMap.set(m.id, clone(m));
  }
  removeMaterial(id: string): void {
    this.transact(() => {
      this.materialMap.delete(id);
      for (const e of this.nodes()) {
        const states = e.get("states") as Y.Map<ValueMap>;
        const mesh = states.get("builtin.Mesh");
        if (mesh?.get("material") === id) mesh.set("material", none());
        this.replaceStoredOverrideValues(
          e,
          (parts, value) => parts[2] === "builtin.Mesh" && parts[3] === "material" && value === id,
        );
      }
    });
  }

  // ---------- 素材 ----------
  assets(): AssetDef[] {
    return [...this.assetMap.values()].map(clone);
  }
  asset(id: string): AssetDef | undefined {
    const a = this.assetMap.get(id);
    return a ? clone(a) : undefined;
  }
  /** 素材を加える（同じ中身はすでにあれば名前だけ更新） */
  addAsset(a: AssetDef): void {
    this.assetMap.set(a.id, clone(a));
  }
  /** 素材の名前を変える（同じ場所に同じ名前があれば拒む） */
  renameAsset(id: string, name: string): void {
    const a = this.assetMap.get(id);
    const next = name.trim();
    if (!a || !next || a.name === next) return;
    this.assertSiblingName(next, id);
    this.assetMap.set(id, { ...a, name: next });
  }
  removeAsset(id: string): void {
    this.transact(() => {
      this.assetMap.delete(id);
      for (const m of this.materialMap.values()) {
        if (m.map === id) this.materialMap.set(m.id, { ...m, map: null });
      }
      for (const e of this.nodes()) {
        const states = e.get("states") as Y.Map<ValueMap>;
        for (const values of states.values()) {
          for (const [field, value] of values) if (value === id) values.set(field, none());
        }
        this.replaceStoredOverrideValues(e, (_parts, value) => value === id);
      }
    });
  }

  // ---------- アウトプット ----------
  outputs(): OutputDef[] {
    return [...this.outputMap.values()].map(clone);
  }
  output(id: string): OutputDef | undefined {
    const o = this.outputMap.get(id);
    return o ? clone(o) : undefined;
  }
  addOutput(name: string, kind: OutputKind): string {
    const id = newId("out");
    this.outputMap.set(id, {
      id,
      name,
      kind,
      systems: [],
      keep: [],
      ...(kind === "library" ? { resources: [] } : {}),
    });
    return id;
  }
  updateOutput(o: OutputDef): void {
    this.outputMap.set(o.id, clone(o));
  }

  // ---------- Entity ----------
  entities(output?: string): EntityDef[] {
    const out: EntityDef[] = [];
    for (const e of this.entityMap.values()) {
      const def = this.toEntityDef(e);
      if (output === undefined || def.output === output) out.push(def);
    }
    return out.sort((a, b) => a.order - b.order);
  }
  entity(id: EntityId): EntityDef | undefined {
    const e = this.entityMap.get(id);
    return e ? this.toEntityDef(e) : undefined;
  }
  addEntity(init: {
    output: string;
    name: string;
    parent?: EntityId | null;
    states?: Record<KokoStateId, KokoStateValues>;
    id?: EntityId;
    /** プレハブのインスタンスにする（ADR 0076） */
    instanceOf?: PrefabInstanceLink;
  }): EntityId {
    if (this.outputMap.get(init.output)?.kind === "library")
      throw new Error("ライブラリには Entity を作れません");
    const id = init.id ?? newId("ent");
    assertEntityId(id);
    const registry = this.registry();
    const parent = init.parent ?? null;
    if (parent !== null) {
      const target = this.expandedPeers(parent).find((e) => e.id === parent);
      if (!target || target.output !== init.output)
        throw new Error("親は、同じアウトプットの中の Entity にしてください");
    }
    this.transact(() => {
      const e = new Y.Map<unknown>();
      const siblings = this.expandedPeers(parent ?? id).filter(
        (s) => s.output === init.output && s.parent === parent,
      );
      e.set("id", id);
      e.set("name", init.name);
      e.set("parent", init.parent ?? null);
      e.set("output", init.output);
      e.set("order", siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.order)) + 1);
      const states = new Y.Map<ValueMap>();
      for (const [koko, values] of Object.entries(init.states ?? {})) {
        states.set(koko, valueMap(registry.createValues(koko, values)));
      }
      e.set("states", states);
      if (init.instanceOf) {
        e.set("instanceOf", clone(init.instanceOf));
        e.set("prefabOverrides", overridesMap({}));
      }
      this.entityMap.set(id, e);
    });
    return id;
  }
  /** アウトプットの Entity か、プレハブの中の Entity（ID は両方を通して一つ） */
  findEntity(id: EntityId): EntityDef | PrefabEntityDef | undefined {
    return this.entity(id) ?? this.prefabEntity(id);
  }
  renameEntity(id: EntityId, name: string): void {
    const target = this.overrideTarget(id);
    if (target && target.path !== "") {
      this.writeOverride(target, "name", name);
      return;
    }
    this.node(id)?.set("name", name);
  }
  /** 親を変える。プレハブの中では、親なし（null）は「いちばん上の Entity の下」になる */
  setParent(id: EntityId, parent: EntityId | null): void {
    const target = this.overrideTarget(id);
    if (target && target.path !== "") {
      this.assertExpandedParent(id, parent);
      this.writeOverride(target, "parent", parent);
      return;
    }
    const e = this.node(id);
    if (!e) return;
    const to = this.parentIn(e, parent);
    this.assertCanParent(id, to);
    e.set("parent", to);
  }

  /**
   * 親と、その兄弟の中の位置をまとめて変える。
   * index は、動かした Entity を除いた並びの何番目に入れるか（0 が先頭）。
   * 兄弟は、同じ持ち主（同じアウトプットか、同じプレハブ）の中で数える。
   */
  placeEntity(id: EntityId, parent: EntityId | null, index: number): void {
    const target = this.overrideTarget(id);
    const e = this.node(id);
    if (!e && !target) return;
    const to = e ? this.parentIn(e, parent) : parent;
    this.assertExpandedParent(id, to);
    const peers = this.expandedPeers(id);
    const self = peers.find((p) => p.id === id);
    if (!self) return;
    const siblings = peers
      .filter((p) => p.parent === to && p.id !== id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const at = Math.max(0, Math.min(index, siblings.length));
    const order = [
      ...siblings.slice(0, at).map((p) => p.id),
      id,
      ...siblings.slice(at).map((p) => p.id),
    ];
    const current = peers
      .filter((p) => p.parent === to)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((p) => p.id);
    if (self.parent === to && current.join("\0") === order.join("\0")) return;
    this.transact(() => {
      if (self.parent !== to) {
        if (target && target.path !== "") this.writeOverride(target, "parent", to);
        else e?.set("parent", to);
      }
      for (const [i, eid] of order.entries()) {
        if (peers.find((p) => p.id === eid)?.order === i) continue;
        const changed = this.overrideTarget(eid);
        if (changed && changed.path !== "") this.writeOverride(changed, "order", i);
        else this.node(eid)?.set("order", i);
      }
    });
  }
  /**
   * Entity を削除する（子も削除）。状態維持のマークも外す。
   * プレハブのいちばん上の Entity は消せない（インスタンスの Entity が、これに当たるため）。
   */
  removeEntity(id: EntityId): void {
    if (this.isPrefabRoot(id)) throw new Error("プレハブのいちばん上の Entity は消せません");
    const target = this.overrideTarget(id);
    if (target && target.path !== "") throw new Error("プレハブから来た Entity は消せません");
    const definition = this.prefabEntity(id);
    this.transact(() => {
      const before = new Map(this.expandedPeers(id).map((e) => [e.id, e]));
      const ids = new Set(this.descendants(id));
      // インスタンスを消すときは、外へ親を変えた中身も、その中で足した Entity も消す。
      for (const e of before.values())
        if (e.origin && ids.has(e.origin.instance))
          for (const child of this.descendants(e.id)) ids.add(child);
      // 消すのが追加 Entity なら、その下へ移したプレハブ由来の枝は残す。
      const kept = [...before.values()].filter(
        (e) => ids.has(e.id) && e.origin && !ids.has(e.origin.instance),
      );
      for (const e of kept) for (const child of this.descendants(e.id)) ids.delete(child);
      for (const e of kept) {
        if (e.parent === null || !ids.has(e.parent)) continue;
        let parent: EntityId | null = e.parent;
        const seen = new Set<EntityId>();
        while (parent !== null && ids.has(parent) && !seen.has(parent)) {
          seen.add(parent);
          parent = before.get(parent)?.parent ?? null;
        }
        const inherited = this.overrideTarget(e.id);
        if (inherited) this.writeOverride(inherited, "parent", parent);
      }
      if (definition) {
        const prefab = this.prefabMap.get(definition.prefab);
        if (prefab) {
          const deletedParents = { ...prefab.deletedParents };
          for (const eid of ids) {
            const removed = this.prefabEntity(eid);
            if (removed?.prefab === prefab.id) deletedParents[eid] = removed.parent;
          }
          this.prefabMap.set(prefab.id, { ...prefab, deletedParents });
        }
      }
      for (const eid of ids) {
        this.entityMap.delete(eid);
        this.prefabEntityMap.delete(eid);
      }
      // 消した Entity と、その中（展開した Entity。ID は「/」でつないである）を指す印も外す（ADR 0076）。
      // インスタンスを消したときのアウトプットの印と、プレハブの中の Entity を消したときのプレハブの印
      const gone = (entity: EntityId) =>
        entity.split(EXPANDED_ID_SEPARATOR).some((part) => ids.has(part));
      for (const o of this.outputMap.values()) {
        if (o.keep.some((k) => gone(k.entity))) {
          this.outputMap.set(o.id, { ...o, keep: o.keep.filter((k) => !gone(k.entity)) });
        }
      }
      for (const p of this.prefabMap.values()) {
        if (p.keep.some((k) => gone(k.entity))) {
          this.prefabMap.set(p.id, { ...p, keep: p.keep.filter((k) => !gone(k.entity)) });
        }
      }
    });
  }
  /**
   * Entity を複製する。同じ親の下に「名前 のコピー」を作り、作った Entity の ID を返す。
   * withChildren なら、中の Entity も写す。インスタンスを複製すると、同じプレハブのインスタンスが一つ増える。
   * プレハブのいちばん上の Entity は複製できない（いちばん上は一つだけ）。
   */
  duplicateEntity(
    id: EntityId,
    withChildren: boolean,
    schemas?: FieldSchemas,
  ): EntityId | undefined {
    const e = this.node(id);
    const inherited = this.overrideTarget(id);
    if (!e && !inherited) return undefined;
    if (this.isPrefabRoot(id)) throw new Error("プレハブのいちばん上の Entity は複製できません");
    const root = inherited?.entity ?? (e ? readEntityBase(e) : undefined);
    if (!root) return undefined;
    const prefab = e?.get("prefab") as string | undefined;
    const output = inherited?.entity.output ?? (e?.get("output") as string);
    const peers = inherited ? this.expandedPeers(id) : e ? this.peersOf(e) : [];
    const created = new Map<EntityId, EntityId>();
    const instanceRoot = Boolean(e?.get("instanceOf"));
    const sourceRoot = e ? readEntityBase(e) : root;
    const copy = (src: EntityBase, parent: EntityId | null, rename: boolean) => {
      const next = newId("ent");
      const rebase = (value: string | null) =>
        value === null
          ? null
          : value === src.id
            ? next
            : value.startsWith(`${src.id}/`)
              ? `${next}${value.slice(src.id.length)}`
              : value;
      const rebaseStates = (states: Record<KokoStateId, KokoStateValues> | undefined) => {
        if (!states) return undefined;
        const copy = clone(states);
        for (const [koko, values] of Object.entries(copy)) {
          const def = this.registry().get(koko);
          for (const field of def?.fields ?? []) {
            const schema = schemaOfField(schemas, koko, field);
            if (!schema || !hasRefs(schema) || !Object.hasOwn(values, field.id)) continue;
            values[field.id] = mapRefs(schema, values[field.id], (target, ref) =>
              target === "entity" ? (rebase(ref) ?? undefined) : undefined,
            ) as FieldValue;
          }
        }
        return copy;
      };
      const copied = {
        id: next,
        name: rename ? `${src.name} のコピー` : src.name,
        states: src.instanceOf ? rebaseStates(src.states) : src.states,
        ...(src.instanceOf ? { instanceOf: src.instanceOf } : {}),
      };
      if (prefab !== undefined)
        this.addPrefabEntity({ ...copied, prefab, ...(parent !== null ? { parent } : {}) });
      else this.addEntity({ ...copied, output, parent });
      created.set(src.id, next);
      const to = this.node(next);
      if (to && src.prefabOverrides) {
        const overrides = Object.fromEntries(
          Object.entries(src.prefabOverrides).map(([path, v]) => [
            path,
            {
              ...v,
              ...(Object.hasOwn(v, "parent") ? { parent: rebase(v.parent ?? null) } : {}),
              ...(v.states ? { states: rebaseStates(v.states) } : {}),
              ...(v.addedStates ? { addedStates: rebaseStates(v.addedStates) } : {}),
            },
          ]),
        );
        to.set("prefabOverrides", overridesMap(overrides));
      }
      if (to && src.instanceSystems) to.set("instanceSystems", clone(src.instanceSystems));
    };
    this.transact(() => {
      copy(sourceRoot, root.parent, true);
      if (!withChildren) return;
      // インスタンスの中身は参照から展開される。実体として足した Entity だけを複製する。
      const source = instanceRoot && e ? this.peersOf(e) : peers;
      const pending = [id];
      for (let i = 0; i < pending.length; i++) {
        const old = pending[i] as EntityId;
        const parent = created.get(old);
        if (parent === undefined) continue;
        for (const kid of source) {
          const nestedParent =
            instanceRoot && kid.parent?.startsWith(`${id}/`)
              ? `${created.get(id)}${kid.parent.slice(id.length)}`
              : null;
          if ((kid.parent !== old && !(old === id && nestedParent)) || created.has(kid.id))
            continue;
          copy(kid, nestedParent ?? parent, false);
          pending.push(kid.id);
        }
      }
    });
    return created.get(id);
  }
  addState(id: EntityId, koko: KokoStateId, values?: KokoStateValues): void {
    this.transact(() => this.addStateNow(id, koko, values));
  }
  private addStateNow(id: EntityId, koko: KokoStateId, values?: KokoStateValues): void {
    const target = this.overrideTarget(id);
    if (target) {
      if (Object.hasOwn(target.entity.states, koko)) return;
      const value = this.registry().createValues(koko, values);
      if (target.path === "") this.statesOf(id).set(koko, valueMap(value));
      else {
        const store = this.overrideStore(target);
        store.set(overrideKey(target.path, "addedStates", koko), true);
        for (const [field, v] of Object.entries(value))
          store.set(overrideKey(target.path, "addedStates", koko, field), encodeValue(v));
      }
      return;
    }
    const states = this.statesOf(id);
    if (!states.has(koko)) states.set(koko, valueMap(this.registry().createValues(koko, values)));
  }
  removeState(id: EntityId, koko: KokoStateId): void {
    this.transact(() => this.removeStateNow(id, koko));
  }
  private removeStateNow(id: EntityId, koko: KokoStateId): void {
    const target = this.overrideTarget(id);
    if (target) {
      if (Object.hasOwn(target.base.states, koko))
        throw new Error("プレハブから来た KokoState は外せません");
      if (target.path === "") this.statesOf(id).delete(koko);
      else {
        this.deleteOverrides(target, (parts) => parts[1] === "addedStates" && parts[2] === koko);
      }
      return;
    }
    this.statesOf(id).delete(koko);
  }
  /** フィールドの値を変える（他のフィールドはそのまま）。 */
  setField(id: EntityId, koko: KokoStateId, field: string, value: FieldValue): void {
    this.transact(() => this.setFieldNow(id, koko, field, value));
  }
  private setFieldNow(id: EntityId, koko: KokoStateId, field: string, value: FieldValue): void {
    const target = this.overrideTarget(id);
    if (target && !(target.path === "" && koko === TRANSFORM)) {
      if (!Object.hasOwn(target.entity.states, koko))
        throw new Error(`Entity ${id} は ${koko} を持っていません`);
      if (target.path === "" && !Object.hasOwn(target.base.states, koko)) {
        this.statesOf(id).get(koko)?.set(field, encodeValue(value));
        return;
      }
      const group = Object.hasOwn(target.base.states, koko) ? "states" : "addedStates";
      const store = this.overrideStore(target);
      const key = overrideKey(target.path, group, koko, field);
      if (group === "states" && equalValues(value, target.base.states[koko]?.[field]))
        store.delete(key);
      else store.set(key, encodeValue(value));
      return;
    }
    const values = this.statesOf(id).get(koko);
    if (!values) throw new Error(`Entity ${id} は ${koko} を持っていません`);
    values.set(field, encodeValue(value));
  }

  /** 一つのフィールドを、いまのプレハブの値に戻す。 */
  revertPrefabField(id: EntityId, koko: KokoStateId, field: string): void {
    const target = this.overrideTarget(id);
    if (!target) return;
    this.overrideStore(target).delete(overrideKey(target.path, "states", koko, field));
  }

  /** 名前・親・並び順・足した KokoState を、一つずつプレハブの形に戻す。 */
  revertPrefabEntity(
    id: EntityId,
    kind: "name" | "parent" | "order" | "state",
    koko?: KokoStateId,
  ): void {
    this.transact(() => this.revertPrefabEntityNow(id, kind, koko));
  }
  private revertPrefabEntityNow(
    id: EntityId,
    kind: "name" | "parent" | "order" | "state",
    koko?: KokoStateId,
  ): void {
    const target = this.overrideTarget(id);
    if (!target) return;
    if (kind === "state" && koko) {
      if (target.path === "" && !Object.hasOwn(target.base.states, koko))
        this.statesOf(id).delete(koko);
      else {
        this.deleteOverrides(
          target,
          (parts) => (parts[1] === "states" || parts[1] === "addedStates") && parts[2] === koko,
        );
      }
    } else this.overrideStore(target).delete(overrideKey(target.path, kind));
  }

  /** インスタンスで足す System の並び。プレハブから来たものは、この一覧では外さない。 */
  setInstanceSystems(id: EntityId, systems: readonly OutputSystem[]): void {
    const e = this.node(id);
    if (!e?.get("instanceOf")) throw new Error("インスタンスを選んでください");
    const unique = new Set<string>();
    const added = systems.filter((s) => !unique.has(s.id) && Boolean(unique.add(s.id)));
    if (added.length > 0) e.set("instanceSystems", clone(added));
    else e.delete("instanceSystems");
  }

  // ---------- プレハブ（ADR 0076） ----------
  prefabs(): PrefabDef[] {
    return [...this.prefabMap.values()].map(clone);
  }
  prefab(id: string): PrefabDef | undefined {
    const p = this.prefabMap.get(id);
    return p ? clone(p) : undefined;
  }
  /** 空のプレハブを作る。いちばん上の Entity を一つだけ持つ（インスタンスの Entity が、これに当たる） */
  addPrefab(name: string): string {
    const id = newId("pf");
    const root = newId("ent");
    this.transact(() => {
      this.prefabMap.set(id, { id, name, root, systems: [], keep: [] });
      this.prefabEntityMap.set(
        root,
        entityNode({
          id: root,
          name,
          parent: null,
          prefab: id,
          order: 0,
          states: { [TRANSFORM]: this.registry().createValues(TRANSFORM) },
        }),
      );
    });
    return id;
  }
  /** 名前を変える。インスタンスは ID で結び付いているので、切れない */
  renamePrefab(id: string, name: string): void {
    const p = this.prefabMap.get(id);
    const next = name.trim();
    if (!p || !next || p.name === next) return;
    this.assertSiblingName(next, id);
    this.prefabMap.set(id, { ...p, name: next });
  }
  /** System の並び・「維持」の印・編集する場所を変える（ID と、いちばん上の Entity は変えられない） */
  updatePrefab(def: PrefabDef): void {
    const p = this.prefabMap.get(def.id);
    if (!p) return;
    this.prefabMap.set(def.id, { ...clone(def), root: p.root });
  }
  /** プレハブを、中の Entity ごと、渡した形に置き直す（なければ作る）。値は、そのまま入れる */
  restorePrefab(def: PrefabDef, entities: readonly PrefabEntityDef[]): void {
    this.transact(() => {
      this.prefabMap.set(def.id, clone(def));
      const keep = new Set(entities.map((e) => e.id));
      for (const [eid, e] of [...this.prefabEntityMap.entries()])
        if (e.get("prefab") === def.id && !keep.has(eid)) this.prefabEntityMap.delete(eid);
      for (const e of entities)
        this.prefabEntityMap.set(e.id, entityNode({ ...e, prefab: def.id }));
    });
  }
  /** プレハブと、その中の Entity を消す。インスタンスは残る（問題として出る） */
  removePrefab(id: string): void {
    this.transact(() => {
      this.prefabMap.delete(id);
      for (const [eid, e] of [...this.prefabEntityMap.entries()])
        if (e.get("prefab") === id) this.prefabEntityMap.delete(eid);
    });
  }
  /** プレハブの中の Entity（並び順）。prefab を省くと、すべてのプレハブのもの */
  prefabEntities(prefab?: string): PrefabEntityDef[] {
    const out: PrefabEntityDef[] = [];
    for (const e of this.prefabEntityMap.values()) {
      const def = this.toPrefabEntityDef(e);
      if (prefab === undefined || def.prefab === prefab) out.push(def);
    }
    return out.sort((a, b) => a.order - b.order);
  }
  prefabEntity(id: EntityId): PrefabEntityDef | undefined {
    const e = this.prefabEntityMap.get(id);
    return e ? this.toPrefabEntityDef(e) : undefined;
  }
  /** プレハブの中に Entity を作る。親を省くと、いちばん上の Entity の下に入る */
  addPrefabEntity(init: {
    prefab: string;
    name: string;
    parent?: EntityId;
    states?: Record<KokoStateId, KokoStateValues>;
    id?: EntityId;
    /** 別のプレハブのインスタンスにする（入れ子） */
    instanceOf?: PrefabInstanceLink;
  }): EntityId {
    const prefab = this.prefabMap.get(init.prefab);
    if (!prefab) throw new Error(`プレハブがありません: ${init.prefab}`);
    const parent = init.parent ?? prefab.root;
    if (this.expandedPeers(parent).find((e) => e.id === parent)?.output !== init.prefab)
      throw new Error("親は、同じプレハブの中の Entity にしてください");
    const id = init.id ?? newId("ent");
    assertEntityId(id);
    if (this.node(id)) throw new Error(`Entity の ID が重複しています: ${id}`);
    const registry = this.registry();
    this.transact(() => {
      const siblings = this.expandedPeers(parent).filter((s) => s.parent === parent);
      const states: Record<KokoStateId, KokoStateValues> = {};
      for (const [koko, values] of Object.entries(init.states ?? {}))
        states[koko] = registry.createValues(koko, values);
      this.prefabEntityMap.set(
        id,
        entityNode({
          id,
          name: init.name,
          parent,
          prefab: init.prefab,
          order: siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.order)) + 1,
          states,
          ...(init.instanceOf ? { instanceOf: init.instanceOf } : {}),
        }),
      );
    });
    return id;
  }
  /**
   * プレハブのインスタンスを、アウトプットに置く。場所・向き・大きさは、インスタンスそのものの
   * Transform に持つ（初めは、プレハブのいちばん上の Entity の向きと大きさを写す）。
   */
  addInstance(init: {
    output: string;
    prefab: string;
    name?: string;
    parent?: EntityId | null;
    position?: [number, number, number];
    id?: EntityId;
  }): EntityId {
    const prefab = this.prefabMap.get(init.prefab);
    if (!prefab) throw new Error(`プレハブがありません: ${init.prefab}`);
    const root = this.prefabEntity(prefab.root);
    const transform: KokoStateValues = { ...root?.states[TRANSFORM] };
    if (init.position) transform.position = [...init.position];
    return this.addEntity({
      output: init.output,
      name: init.name ?? prefab.name,
      parent: init.parent ?? null,
      states: { [TRANSFORM]: transform },
      instanceOf: { prefab: init.prefab },
      ...(init.id ? { id: init.id } : {}),
    });
  }
  /** あるプレハブのインスタンス（アウトプットの中と、ほかのプレハブの中） */
  instancesOf(prefab: string): (EntityDef | PrefabEntityDef)[] {
    return [...this.entities(), ...this.prefabEntities()].filter(
      (e) => e.instanceOf?.prefab === prefab,
    );
  }
  /**
   * アウトプットの Entity からプレハブを作る計画（何を移し、何を書き換えるか）を作る。制作データは変えない。
   * 確認の画面は、これを見せる。プレハブの名前は、省くと、Entity の名前から（いちばん上で空いている名前）。
   */
  planPrefabFromEntity(
    id: EntityId,
    options: Omit<PrefabFromEntityOptions, "kokostates"> = {},
  ): PrefabFromEntityResult {
    const base = this.entityMap.get(id)?.get("name");
    const usable = typeof base === "string" && validateName(base) === null ? base : "プレハブ";
    return planPrefabFromEntity(this.snapshot(), id, {
      ...options,
      name: options.name ?? this.freeName(usable, null),
      kokostates: this.packageDefs,
    });
  }
  /**
   * アウトプットの Entity（中の Entity を含む）から、プレハブを作る（ADR 0076 の 10）。
   * 選んだ Entity は、ID を引き継いで、そのプレハブのインスタンスになる。中身は、新しい ID でプレハブに移す。
   * ほかの Entity から中の Entity への参照と「維持」の印は、切れないように書き換える。
   * 一つの transaction で行う（共同編集の相手に、途中の形が見えない）。変換できないときは、わけを投げる。
   */
  makePrefabFromEntity(
    id: EntityId,
    options: Omit<PrefabFromEntityOptions, "kokostates"> = {},
  ): PrefabFromEntityPlan {
    const result = this.planPrefabFromEntity(id, options);
    if (!result.ok) throw new Error(result.reason);
    const plan = result.plan;
    this.assertSiblingName(plan.prefab.name, plan.prefab.id);
    this.transact(() => {
      this.prefabMap.set(plan.prefab.id, clone(plan.prefab));
      for (const e of plan.prefabEntities) this.prefabEntityMap.set(e.id, entityNode(e));
      // 中の Entity は、プレハブへ移した。選んだ Entity は、Transform だけを持つインスタンスにする
      for (const m of plan.moved) if (m.from !== plan.entity) this.entityMap.delete(m.from);
      const self = this.entityMap.get(plan.entity);
      if (self) {
        const states = self.get("states") as Y.Map<ValueMap>;
        for (const koko of [...states.keys()])
          if (!Object.hasOwn(plan.instance.states, koko)) states.delete(koko);
        self.set("instanceOf", clone(plan.instance.instanceOf));
        self.set("prefabOverrides", overridesMap({}));
      }
      for (const r of plan.rewrites)
        (this.node(r.entity)?.get("states") as Y.Map<ValueMap> | undefined)
          ?.get(r.koko)
          ?.set(r.field, encodeValue(r.value));
      const output = this.outputMap.get(plan.output);
      if (output && plan.keepMoved.length > 0)
        this.outputMap.set(output.id, { ...output, keep: clone(plan.outputKeep) });
    });
    return plan;
  }

  // ---------- 保存した形に戻す ----------

  /** Entity を、渡した形に丸ごと置き直す（なければ作る）。値は定義に合わせ直さず、そのまま入れる。 */
  restoreEntity(def: EntityDef): void {
    this.transact(() => {
      const e = this.entityMap.get(def.id) ?? new Y.Map<unknown>();
      if (!this.entityMap.has(def.id)) this.entityMap.set(def.id, e);
      e.set("id", def.id);
      e.set("name", def.name);
      e.set("parent", def.parent ?? null);
      e.set("output", def.output);
      e.set("order", def.order);
      const states = new Y.Map<ValueMap>();
      for (const [k, v] of Object.entries(def.states)) states.set(k, valueMap(v));
      e.set("states", states);
      if (def.instanceOf) e.set("instanceOf", clone(def.instanceOf));
      else e.delete("instanceOf");
      if (def.instanceOf) e.set("prefabOverrides", overridesMap(def.prefabOverrides ?? {}));
      else e.delete("prefabOverrides");
      if (def.instanceSystems) e.set("instanceSystems", clone(def.instanceSystems));
      else e.delete("instanceSystems");
      this.makeRoomAfter(def.id);
    });
  }
  /** KokoState の値を丸ごと置き直す。null なら外す。 */
  restoreState(id: EntityId, koko: KokoStateId, values: KokoStateValues | null): void {
    const target = this.overrideTarget(id);
    if (target && !(target.path === "" && koko === TRANSFORM)) {
      this.transact(() => {
        if (values === null) {
          this.removeState(id, koko);
          return;
        }
        const inherited = Object.hasOwn(target.base.states, koko);
        if (inherited) {
          this.deleteOverrides(target, (parts) => parts[1] === "states" && parts[2] === koko);
          for (const [field, value] of Object.entries(values))
            this.setField(id, koko, field, value);
        } else if (target.path === "") this.statesOf(id).set(koko, valueMap(values));
        else {
          this.deleteOverrides(target, (parts) => parts[1] === "addedStates" && parts[2] === koko);
          const store = this.overrideStore(target);
          store.set(overrideKey(target.path, "addedStates", koko), true);
          for (const [field, value] of Object.entries(values))
            store.set(overrideKey(target.path, "addedStates", koko, field), encodeValue(value));
        }
      });
      return;
    }
    const states = this.statesOf(id);
    this.transact(() => {
      if (values === null) {
        states.delete(koko);
        return;
      }
      states.set(koko, valueMap(values));
    });
  }
  /** 親・アウトプット・並び順を、渡した値にする。 */
  restorePlace(id: EntityId, place: { parent: EntityId | null; output: string; order: number }) {
    const target = this.overrideTarget(id);
    if (target && target.path !== "") {
      if (place.output !== target.entity.output) throw new Error("別のアウトプットへは移せません");
      this.assertExpandedParent(id, place.parent);
      this.transact(() => {
        this.writeOverride(target, "parent", place.parent);
        this.writeOverride(target, "order", place.order);
      });
      return;
    }
    const e = this.entityMap.get(id);
    if (!e) return;
    if (place.parent !== null) this.assertCanParent(id, place.parent);
    this.transact(() => {
      e.set("parent", place.parent);
      e.set("output", place.output);
      e.set("order", place.order);
      this.makeRoomAfter(id);
    });
  }
  /**
   * 兄弟の並び番号が id と重なったら、id より後ろの兄弟を、重ならなくなるところまで一つずつずらす
   * （一つだけ戻したときに、並びが同じ番号で重なって崩れないように。離れている番号は動かさない）。
   */
  private makeRoomAfter(id: EntityId): void {
    const self = this.entity(id);
    if (!self) return;
    let prev = self.order;
    const after = this.entities(self.output)
      .filter((s) => s.parent === self.parent && s.id !== id && s.order >= self.order)
      .sort((a, b) => a.order - b.order);
    for (const s of after) {
      if (s.order > prev) break;
      prev += 1;
      this.entityMap.get(s.id)?.set("order", prev);
    }
  }
  /** System の名前とコードを、渡した形にする（なければ作る）。開いているエディタはそのまま使える。 */
  restoreSystem(def: SystemDef, code: string): void {
    this.transact(() => {
      this.systemMap.set(def.id, { id: def.id, name: def.name });
      this.setCode(def.id, code);
    });
  }
  /** アウトプットと、その中の Entity を消す。 */
  removeOutput(id: string): void {
    this.transact(() => {
      this.outputMap.delete(id);
      for (const [eid, e] of [...this.entityMap.entries()]) {
        if (e.get("output") === id) this.entityMap.delete(eid);
      }
    });
  }

  // ---------- 丸ごと ----------
  snapshot(): ProjectSnapshot {
    const resources = new Set([
      ...this.kokostates().map((k) => k.id),
      ...this.systems().map((x) => x.id),
      ...this.typeDefs().map((t) => t.id),
      ...this.materials().map((m) => m.id),
      ...this.assets().map((a) => a.id),
      ...this.prefabs().map((p) => p.id),
    ]);
    const folders = this.folders();
    const folderIds = new Set(folders.map((f) => f.id));
    // 消えたリソース・消えたフォルダへの割り当ては残さない
    const placement = Object.fromEntries(
      [...this.placementMap.entries()].filter(([r, f]) => resources.has(r) && folderIds.has(f)),
    );
    return {
      version: 1,
      name: this.name,
      kokostates: this.kokostates(),
      systems: this.systems().map((s) => ({ ...s, code: this.code(s.id)?.toString() ?? "" })),
      types: this.typeDefs().map((t) => ({ ...t, code: this.code(t.id)?.toString() ?? "" })),
      materials: this.materials(),
      assets: this.assets(),
      // 消えたリソースは、ライブラリの含めるリソースに残さない
      outputs: this.outputs().map((o) =>
        o.resources ? { ...o, resources: o.resources.filter((r) => resources.has(r)) } : o,
      ),
      entities: this.entities(),
      provenance: clone(
        (this.meta.get("provenance") as unknown as ProjectSnapshot["provenance"]) ?? [],
      ),
      folders,
      placement,
      dependencies: this.dependencies(),
      prefabs: this.prefabs(),
      prefabEntities: this.prefabEntities(),
    };
  }

  /**
   * snap にあって、いまない（ID で比べる）ものを足す。いまあるものは書き換えない（取り込み。ADR 0052）。
   * 抽出（extractInto）で今の中身に足した結果を、共同編集中のデータへ一度に入れるために使う。
   * 由来（provenance）は snap のものにする。
   */
  mergeAdditions(snap: ProjectSnapshot): void {
    this.transact(() => {
      for (const f of snap.folders ?? [])
        if (!this.folderMap.has(f.id)) this.folderMap.set(f.id, clone(f));
      for (const k of snap.kokostates)
        if (!this.kokoMap.has(k.id)) this.kokoMap.set(k.id, kokoMapOf(k));
      for (const x of snap.systems) {
        if (this.systemMap.has(x.id)) continue;
        this.systemMap.set(x.id, { id: x.id, name: x.name });
        const text = new Y.Text();
        text.insert(0, x.code);
        this.codeMap.set(x.id, text);
      }
      for (const t of snap.types ?? []) {
        if (this.typeMap.has(t.id)) continue;
        this.typeMap.set(t.id, { id: t.id, name: t.name });
        this.setCode(t.id, t.code);
      }
      for (const m of snap.materials)
        if (!this.materialMap.has(m.id)) this.materialMap.set(m.id, clone(m));
      for (const a of snap.assets ?? [])
        if (!this.assetMap.has(a.id)) this.assetMap.set(a.id, clone(a));
      for (const o of snap.outputs)
        if (!this.outputMap.has(o.id)) this.outputMap.set(o.id, clone(o));
      for (const e of snap.entities) if (!this.entityMap.has(e.id)) this.restoreEntity(e);
      for (const p of snap.prefabs ?? [])
        if (!this.prefabMap.has(p.id)) this.prefabMap.set(p.id, clone(p));
      for (const e of snap.prefabEntities ?? [])
        if (!this.prefabEntityMap.has(e.id)) this.prefabEntityMap.set(e.id, entityNode(e));
      for (const [r, f] of Object.entries(snap.placement ?? {}))
        if (!this.placementMap.has(r)) this.placementMap.set(r, f);
      for (const d of snap.dependencies ?? [])
        if (!this.dependencyMap.has(d.alias)) this.dependencyMap.set(d.alias, clone(d));
      this.meta.set("provenance", clone(snap.provenance ?? []) as unknown as string);
    });
  }

  /** 中身を丸ごと置き換える（サンプルの読み込み、コミットからの復元など）。 */
  load(snap: ProjectSnapshot): void {
    this.transact(() => {
      for (const m of [
        this.kokoMap,
        this.systemMap,
        this.typeMap,
        this.codeMap,
        this.materialMap,
        this.assetMap,
        this.outputMap,
        this.entityMap,
        this.prefabMap,
        this.prefabEntityMap,
        this.folderMap,
        this.placementMap,
        this.dependencyMap,
      ]) {
        m.clear();
      }
      for (const f of snap.folders ?? []) this.folderMap.set(f.id, clone(f));
      for (const [r, f] of Object.entries(snap.placement ?? {})) this.placementMap.set(r, f);
      for (const d of snap.dependencies ?? []) this.dependencyMap.set(d.alias, clone(d));
      this.meta.set("name", snap.name);
      this.meta.set("provenance", (snap.provenance ?? []) as unknown as string);
      for (const k of snap.kokostates) this.kokoMap.set(k.id, kokoMapOf(k));
      for (const s of snap.systems) {
        this.systemMap.set(s.id, { id: s.id, name: s.name });
        const text = new Y.Text();
        text.insert(0, s.code);
        this.codeMap.set(s.id, text);
      }
      for (const t of snap.types ?? []) {
        this.typeMap.set(t.id, { id: t.id, name: t.name });
        const text = new Y.Text();
        text.insert(0, t.code);
        this.codeMap.set(t.id, text);
      }
      for (const m of snap.materials) this.materialMap.set(m.id, clone(m));
      for (const a of snap.assets ?? []) this.assetMap.set(a.id, clone(a));
      for (const o of snap.outputs) this.outputMap.set(o.id, clone(o));
      for (const e of snap.entities) this.entityMap.set(e.id, entityNode(e));
      for (const p of snap.prefabs ?? []) this.prefabMap.set(p.id, clone(p));
      for (const e of snap.prefabEntities ?? []) this.prefabEntityMap.set(e.id, entityNode(e));
    });
  }

  // ---------- Resources のフォルダ ----------

  folders(): FolderDef[] {
    return [...this.folderMap.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name));
  }

  addFolder(name: string, parent: string | null): string {
    const id = newId("fld");
    this.folderMap.set(id, { id, name: name.trim() || "新しいフォルダ", parent });
    return id;
  }

  renameFolder(id: string, name: string): void {
    const f = this.folderMap.get(id);
    const next = name.trim();
    if (!f || !next || f.name === next) return;
    this.assertSiblingName(next, id);
    this.refactoring(() => this.folderMap.set(id, { ...f, name: next }));
  }

  /**
   * 名前の変更・移動をして、import のパスを新しい場所に合わせて書き直す（ADR 0010 §3）。
   * 変更と書き直しは一つの transaction にする（共同編集の相手にも一度に届く）。
   */
  private refactoring(change: () => void): void {
    const prev = this.snapshot();
    this.transact(() => {
      change();
      const edits = planImportRefactor(prev, this.snapshot()).sort((a, b) => b.start - a.start);
      for (const e of edits) {
        const text = this.codeMap.get(e.systemId);
        if (!text) continue;
        text.delete(e.start, e.end - e.start);
        text.insert(e.start, e.text);
      }
    });
  }

  /** フォルダ・リソースが入っている親（フォルダは親のフォルダ、リソースは置き場所） */
  private parentOf(id: string): string | null {
    const f = this.folderMap.get(id);
    if (f) return f.parent && this.folderMap.has(f.parent) ? f.parent : null;
    return this.folderOf(id);
  }

  /** 親の直下にあるフォルダとリソース（Built-in の KokoState は除く） */
  private siblingsIn(parent: string | null): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = [];
    for (const f of this.folderMap.values()) if (this.parentOf(f.id) === parent) out.push(f);
    const resources: { id: string; name: string }[] = [
      ...this.kokostates(),
      ...this.systemMap.values(),
      ...this.typeMap.values(),
      ...this.materialMap.values(),
      ...this.assetMap.values(),
      ...this.prefabMap.values(),
    ];
    for (const r of resources) if (this.folderOf(r.id) === parent) out.push(r);
    return out;
  }

  /**
   * 同じ親の直下で、その名前がほかのもの（self 以外）に使われているか。
   * 種類をまたいで比べ、NFC・大文字小文字の違いは同じとみなす（ADR 0010）。
   */
  siblingNameTaken(name: string, parent: string | null, self?: string): boolean {
    const key = normalizeName(name.trim());
    return this.siblingsIn(parent).some((s) => s.id !== self && normalizeName(s.name) === key);
  }

  /** 親の直下で空いている名前（「名前」「名前 2」…）。format で番号の付け方を変えられる */
  freeName(
    base: string,
    parent: string | null,
    format: (base: string, n: number) => string = (b, n) => (n === 1 ? b : `${b} ${n}`),
  ): string {
    const taken = new Set(this.siblingsIn(parent).map((s) => normalizeName(s.name)));
    for (let n = 1; ; n++) {
      const name = format(base, n);
      if (!taken.has(normalizeName(name))) return name;
    }
  }

  /** 名前を変えるときの検査：使えない名前・同じ親の直下での衝突を拒む */
  private assertSiblingName(name: string, self: string): void {
    const problem = validateName(name);
    if (problem) throw new Error(`名前「${name}」は使えません`);
    if (this.siblingNameTaken(name, this.parentOf(self), self))
      throw new Error(`同じ場所に「${name.trim()}」という名前があります`);
  }

  /** フォルダを消す。中のフォルダとリソースは、ひとつ上へ移す */
  removeFolder(id: string): void {
    const f = this.folderMap.get(id);
    if (!f) return;
    this.refactoring(() => {
      for (const c of this.folderMap.values())
        if (c.parent === id) this.folderMap.set(c.id, { ...c, parent: f.parent });
      for (const [r, fid] of this.placementMap.entries()) {
        if (fid !== id) continue;
        if (f.parent) this.placementMap.set(r, f.parent);
        else this.placementMap.delete(r);
      }
      this.folderMap.delete(id);
    });
  }

  /** フォルダを別のフォルダへ移す（自分の中へは移せない） */
  moveFolder(id: string, parent: string | null): void {
    const f = this.folderMap.get(id);
    if (!f) return;
    for (let p = parent; p; p = this.folderMap.get(p)?.parent ?? null) if (p === id) return;
    this.refactoring(() => this.folderMap.set(id, { ...f, parent }));
  }

  /**
   * ライブラリのアウトプットに、リソースを含める・外す（含めたものだけを使う側から import できる。
   * ADR 0015・0055）。フォルダと Built-in は含められない。
   */
  setIncluded(outputId: string, resourceId: string, included: boolean): void {
    const o = this.outputMap.get(outputId);
    if (o?.kind !== "library") return;
    const now = o.resources ?? [];
    if (now.includes(resourceId) === included) return;
    const resources = included ? [...now, resourceId].sort() : now.filter((r) => r !== resourceId);
    this.outputMap.set(outputId, { ...clone(o), resources });
  }

  // ---------- 依存（ADR 0015） ----------
  /** 使うライブラリ（別名の順） */
  dependencies(): PackageDependency[] {
    return [...this.dependencyMap.values()]
      .map(clone)
      .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  }

  /**
   * ライブラリを使う。版と content hash を固定する。同じライブラリの別の版は、別の別名で共存できる
   * （ID が版で区切られているので、ぶつからない。混ざっていることは注意で知らせる）
   */
  addDependency(dep: PackageDependency): void {
    const problem = validateAlias(dep.alias);
    if (problem) throw new Error(problem);
    if (this.dependencyMap.has(dep.alias))
      throw new Error(`別名「${dep.alias}」はもう使われています`);
    for (const d of this.dependencyMap.values())
      if (d.packageId === dep.packageId && d.version === dep.version)
        throw new Error(`このライブラリの v${dep.version} はもう「@${d.alias}」で使っています`);
    this.dependencyMap.set(dep.alias, clone(dep));
  }

  removeDependency(alias: string): void {
    this.dependencyMap.delete(alias);
  }

  /** リソースが入っているフォルダ（null はいちばん上） */
  folderOf(resourceId: string): string | null {
    const f = this.placementMap.get(resourceId);
    return f && this.folderMap.has(f) ? f : null;
  }

  /** リソースをフォルダへ移す（null はいちばん上） */
  moveResource(resourceId: string, folder: string | null): void {
    const target = folder && this.folderMap.has(folder) ? folder : null;
    if (this.folderOf(resourceId) === target) return;
    this.refactoring(() => {
      if (target) this.placementMap.set(resourceId, target);
      else this.placementMap.delete(resourceId);
    });
  }

  /** いま見えている Entity。プレハブの編集中なら、そのプレハブの中で展開する。 */
  private expandedPeers(id: EntityId, snapshot = this.snapshot()): ExpandedEntity[] {
    const head = id.split(EXPANDED_ID_SEPARATOR)[0] ?? id;
    const owner = this.prefabEntityMap.get(head)?.get("prefab") as string | undefined;
    return owner
      ? (expandPrefabForEdit(snapshot, owner, { kokostates: this.packageDefs })?.entities ?? [])
      : expandPrefabs(snapshot, { kokostates: this.packageDefs }).entities;
  }

  /** 展開した ID を、上書きを持つ実体のインスタンスと、中の道に分ける。 */
  private overrideTarget(id: EntityId): OverrideTarget | undefined {
    const head = id.split(EXPANDED_ID_SEPARATOR)[0] ?? id;
    const owner = this.node(head);
    if (!owner?.get("instanceOf")) return undefined;
    const snapshot = this.snapshot();
    const entity = this.expandedPeers(id, snapshot).find((e) => e.id === id);
    if (!entity?.origin) return undefined;
    const clear = <T extends EntityBase>(e: T): T => {
      if (e.id !== head) return e;
      const { prefabOverrides: _overrides, instanceSystems: _systems, ...rest } = e;
      return {
        ...rest,
        states: e.states[TRANSFORM] ? { [TRANSFORM]: e.states[TRANSFORM] } : {},
      } as T;
    };
    const base = this.expandedPeers(id, {
      ...snapshot,
      entities: snapshot.entities.map(clear),
      prefabEntities: snapshot.prefabEntities?.map(clear),
    }).find((e) => e.id === id);
    if (!base) return undefined;
    return { owner, path: id === head ? "" : id.slice(head.length + 1), entity, base };
  }

  private overrideStore(target: OverrideTarget): OverrideStore {
    const store = target.owner.get("prefabOverrides") as OverrideStore | undefined;
    if (store) return store;
    // 前の保存形式からインスタンスにしたときも、次のフィールド変更より先に共有される。
    const created = overridesMap({});
    target.owner.set("prefabOverrides", created);
    return created;
  }

  private deleteStoredOverrides(
    owner: Y.Map<unknown>,
    matches: (parts: string[]) => boolean,
  ): void {
    const store = owner.get("prefabOverrides") as OverrideStore | undefined;
    for (const key of [...(store?.keys() ?? [])])
      if (matches(JSON.parse(key) as string[])) store?.delete(key);
  }

  private replaceStoredOverrideValues(
    owner: Y.Map<unknown>,
    matches: (parts: string[], value: Json) => boolean,
  ): void {
    const store = owner.get("prefabOverrides") as OverrideStore | undefined;
    for (const [key, value] of store ?? []) {
      const parts = JSON.parse(key) as string[];
      if (parts.length === 4 && matches(parts, value)) store?.set(key, none());
    }
  }

  private deleteOverrides(target: OverrideTarget, matches: (parts: string[]) => boolean): void {
    const store = this.overrideStore(target);
    for (const key of [...store.keys()]) {
      const parts = JSON.parse(key) as string[];
      if (parts[0] === target.path && matches(parts)) store.delete(key);
    }
  }

  private writeOverride(
    target: OverrideTarget,
    key: "name" | "parent" | "order",
    value: string | number | null,
  ): void {
    const store = this.overrideStore(target);
    if (equalValues(value, target.base[key])) store.delete(overrideKey(target.path, key));
    else store.set(overrideKey(target.path, key), encodeValue(value));
  }

  private assertExpandedParent(id: EntityId, parent: EntityId | null): void {
    const peers = this.expandedPeers(id);
    const self = peers.find((e) => e.id === id);
    const to = peers.find((e) => e.id === parent);
    if (parent !== null && (!to || self?.output !== to.output))
      throw new Error("親は、同じ持ち主の中の Entity にしてください");
    this.assertCanParent(id, parent);
  }

  /** 自分の子孫を親にはできない。親子が輪になっていても、ここで止まって落ちない。 */
  private assertCanParent(id: EntityId, parent: EntityId | null): void {
    const seen = new Set<EntityId>();
    const peers = new Map(this.expandedPeers(id).map((e) => [e.id, e]));
    const parentOf = (p: EntityId) =>
      peers.get(p)?.parent ?? (this.node(p)?.get("parent") as EntityId | null) ?? null;
    for (let p = parent; p !== null; p = parentOf(p)) {
      if (p === id) throw new Error("自分の子孫を親にはできません");
      if (seen.has(p)) return;
      seen.add(p);
    }
  }

  /** プレハブのいちばん上の Entity か */
  private isPrefabRoot(id: EntityId): boolean {
    const prefab = this.prefabEntityMap.get(id)?.get("prefab") as string | undefined;
    return prefab !== undefined && this.prefabMap.get(prefab)?.root === id;
  }

  /**
   * 親にする相手を確かめて返す。親は、同じ持ち主（同じアウトプットか、同じプレハブ）の中の Entity。
   * プレハブの中では、親なし（null）は「いちばん上の Entity の下」。いちばん上の Entity は、ほかの下に付けられない。
   */
  private parentIn(e: Y.Map<unknown>, parent: EntityId | null): EntityId | null {
    const prefab = e.get("prefab") as string | undefined;
    if (prefab === undefined) {
      if (parent !== null) {
        const to = this.expandedPeers(parent).find((p) => p.id === parent);
        if (!to || to.output !== e.get("output") || this.prefabEntityMap.has(parent))
          throw new Error("親は、同じアウトプットの中の Entity にしてください");
      }
      return parent;
    }
    const root = this.prefabMap.get(prefab)?.root;
    if (e.get("id") === root) {
      if (parent === null) return null;
      throw new Error("プレハブのいちばん上の Entity は、ほかの Entity の下に付けられません");
    }
    const to = parent ?? root;
    if (to === undefined || this.expandedPeers(to).find((p) => p.id === to)?.output !== prefab)
      throw new Error("親は、同じプレハブの中の Entity にしてください");
    return to;
  }

  /** 同じ持ち主（同じアウトプットか、同じプレハブ）の Entity。並び順 */
  private peersOf(e: Y.Map<unknown>): EntityBase[] {
    const prefab = e.get("prefab") as string | undefined;
    return prefab !== undefined
      ? this.prefabEntities(prefab)
      : this.entities(e.get("output") as string);
  }

  /** その Entity と、中の Entity の ID（アウトプットの Entity でも、プレハブの中の Entity でも） */
  private descendants(id: EntityId): EntityId[] {
    const all = [
      ...this.expandedPeers(id),
      ...this.nodes().map((e) => ({
        id: e.get("id") as EntityId,
        parent: (e.get("parent") as EntityId | null) ?? null,
      })),
    ];
    const out = [id];
    const visited = new Set<EntityId>(out);
    for (let i = 0; i < out.length; i++) {
      for (const e of all) {
        if (e.parent === out[i] && !visited.has(e.id)) {
          visited.add(e.id);
          out.push(e.id);
        }
      }
    }
    return out;
  }

  private statesOf(id: EntityId): Y.Map<ValueMap> {
    const e = this.node(id);
    if (!e) throw new Error(`Unknown entity: ${id}`);
    return e.get("states") as Y.Map<ValueMap>;
  }

  private toEntityDef(e: Y.Map<unknown>): EntityDef {
    return { ...readEntityBase(e), output: e.get("output") as string };
  }

  private toPrefabEntityDef(e: Y.Map<unknown>): PrefabEntityDef {
    return { ...readEntityBase(e), prefab: e.get("prefab") as string };
  }
}

/** Entity の ID に「/」は使えない（展開した Entity の ID の区切りに使う。ADR 0076） */
function assertEntityId(id: EntityId): void {
  if (id === "" || id.includes("/")) throw new Error(`Entity の ID に使えない書き方です: ${id}`);
}

/** Entity を入れる Y.Map を作る（値は定義に合わせ直さず、そのまま入れる） */
function entityNode(def: EntityDef | PrefabEntityDef): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("id", def.id);
  map.set("name", def.name);
  map.set("parent", def.parent ?? null);
  if ("output" in def) map.set("output", def.output);
  else map.set("prefab", def.prefab);
  map.set("order", def.order);
  const states = new Y.Map<ValueMap>();
  for (const [k, v] of Object.entries(def.states)) states.set(k, valueMap(v));
  map.set("states", states);
  if (def.instanceOf) map.set("instanceOf", clone(def.instanceOf));
  if (def.instanceOf) map.set("prefabOverrides", overridesMap(def.prefabOverrides ?? {}));
  if (def.instanceSystems) map.set("instanceSystems", clone(def.instanceSystems));
  return map;
}

function readEntityBase(e: Y.Map<unknown>): EntityBase {
  const states = e.get("states") as Y.Map<ValueMap>;
  const instanceOf = e.get("instanceOf") as PrefabInstanceLink | undefined;
  return {
    id: e.get("id") as string,
    name: e.get("name") as string,
    parent: (e.get("parent") as string | null) ?? null,
    order: (e.get("order") as number) ?? 0,
    states: decodeStates(states.toJSON() as Record<KokoStateId, StoredValues>),
    ...(instanceOf ? { instanceOf: clone(instanceOf) } : {}),
    ...((e.get("prefabOverrides") as OverrideStore | undefined)?.size
      ? { prefabOverrides: readOverrides(e.get("prefabOverrides") as OverrideStore) }
      : {}),
    ...(e.get("instanceSystems")
      ? { instanceSystems: clone(e.get("instanceSystems") as OutputSystem[]) }
      : {}),
  };
}
