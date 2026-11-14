import {
  type EntityId,
  type FieldSchemas,
  hasRefs,
  type KokoStateDef,
  type KokoStateId,
  type KokoStateValues,
  mapRefs,
  schemaOfField,
  stringifyValue,
  type ValueSchema,
} from "@tukurium/eks";
import { BUILTIN, BUILTIN_KOKOSTATES } from "./builtins";
import type {
  EntityBase,
  EntityDef,
  KeepMark,
  OutputDef,
  OutputSystem,
  PrefabDef,
  PrefabEntityDef,
  PrefabEntityOverride,
  ProjectSnapshot,
} from "./schema";

/**
 * プレハブの展開（ADR 0076）。制作データの中のインスタンスを、プレハブの中身に置き換えた並びを作る。
 * 再生・表示・依存の調べなど、Entity を使う所の手前で呼ぶ。展開したあとの制作データは、
 * プレハブがなかったころと同じ形（アウトプットの Entity の並び）なので、使う側はそのまま読める。
 *
 * - インスタンスの Entity が、プレハブのいちばん上の Entity に当たる（ID・名前・親・並び順はインスタンスのもの）
 * - プレハブの中のほかの Entity は、「インスタンスの ID / プレハブの中の Entity の ID」という ID で足す
 * - プレハブの System と「維持」の印は、インスタンスを置いたアウトプットに足し合わせる
 */

/** 展開した Entity の ID の区切り。Entity の ID そのものには使えない */
export const EXPANDED_ID_SEPARATOR = "/";

/**
 * 展開した Entity の ID。インスタンスの ID に、プレハブの中の Entity の ID をつなげる（入れ子は、順につなげる）。
 * 決まった作り方なので、開き直しても、別の人の画面でも同じ ID になる。
 */
export function expandedEntityId(instance: EntityId, ...path: EntityId[]): EntityId {
  return [instance, ...path].join(EXPANDED_ID_SEPARATOR);
}

/** 展開した Entity が、どのプレハブのどの Entity から来たか */
export interface PrefabOrigin {
  /** アウトプットの中のインスタンス（いちばん外側）の Entity の ID */
  instance: EntityId;
  /** この Entity の中身を持っているプレハブ（入れ子なら、いちばん内側） */
  prefab: string;
  /** そのプレハブの中の Entity の ID */
  entity: EntityId;
}

/** 展開したあとの Entity。プレハブから来たものには origin が付く。展開したあとは instanceOf を持たない */
export interface ExpandedEntity extends EntityDef {
  origin?: PrefabOrigin;
}

/** 展開したあとの制作データ。中身は読むだけにする（取っておいた結果を、次の展開でも使うため） */
export interface ExpandedSnapshot extends ProjectSnapshot {
  entities: ExpandedEntity[];
}

/** 展開した Entity が、インスタンスそのもの（プレハブのいちばん上の Entity に当たるもの）か */
export function isInstanceRoot(e: ExpandedEntity): boolean {
  return e.origin?.instance === e.id;
}

/** 編集先の実体インスタンスと、その中の ID。展開した ID の区切りで対応を保つ。 */
export function prefabInstanceAddress(
  snap: ProjectSnapshot,
  id: EntityId,
): { instance: EntityDef | PrefabEntityDef; path: string } | undefined {
  const own = [...snap.entities, ...(snap.prefabEntities ?? [])];
  const exact = own.find((e) => e.id === id);
  if (exact) return exact.instanceOf ? { instance: exact, path: "" } : undefined;
  const instance = own.find((e) => e.instanceOf && id.startsWith(`${e.id}/`));
  return instance ? { instance, path: id.slice(instance.id.length + 1) } : undefined;
}

export function getPrefabOverride(
  snap: ProjectSnapshot,
  id: EntityId,
): PrefabEntityOverride | undefined {
  const address = prefabInstanceAddress(snap, id);
  if (!address) return undefined;
  const explicit = address.instance.prefabOverrides?.[address.path];
  const prefab = snap.prefabs?.find((p) => p.id === address.instance.instanceOf?.prefab);
  const sourceId = address.path ? address.path.split("/").at(-1) : prefab?.root;
  const source = snap.prefabEntities?.find((e) => e.id === sourceId);
  const nested = snap.prefabs?.find((p) => p.id === source?.instanceOf?.prefab);
  const nestedRoot = snap.prefabEntities?.find((e) => e.id === nested?.root);
  const sourceStates = { ...nestedRoot?.states, ...source?.states };
  const local = Object.fromEntries(
    Object.entries(address.path === "" ? address.instance.states : {}).filter(
      ([koko, values]) =>
        koko !== BUILTIN.Transform && sourceStates[koko] && Object.keys(values).length > 0,
    ),
  );
  const added = { ...explicit?.addedStates };
  for (const [koko, values] of Object.entries(added)) {
    if (!sourceStates[koko]) continue;
    if (Object.keys(values).length > 0) local[koko] = { ...local[koko], ...values };
    delete added[koko];
  }
  const states = mergeStateFields(local, explicit?.states);
  for (const [koko, values] of Object.entries(states))
    if (Object.keys(values).length === 0) delete states[koko];
  const result: PrefabEntityOverride = { ...explicit, addedStates: added, states };
  if (Object.keys(states).length === 0) delete result.states;
  if (Object.keys(added).length === 0) delete result.addedStates;
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface ExpandOptions {
  /** TypeScript で作ったフィールドのスキーマ（あれば、入れ子の値の中の参照も付け替える） */
  schemas?: FieldSchemas;
  /** 制作データにない KokoState の定義（依存から取り込んだもの） */
  kokostates?: readonly KokoStateDef[];
  /** 展開の結果を取っておく入れ物。同じものを渡すと、変わっていないプレハブは作り直さない */
  cache?: PrefabExpansionCache;
}

/** テンプレートの中の Entity の参照に付ける印（展開のときに、インスタンスの ID に付け替える） */
const MARK = "\u0000";

const join = (prefix: string, rel: string): string =>
  rel === "" ? prefix : prefix === "" ? rel : `${prefix}${EXPANDED_ID_SEPARATOR}${rel}`;

interface RefField {
  koko: KokoStateId;
  field: string;
  schema: ValueSchema;
}

interface TemplateEntity {
  /** いちばん上の Entity からの ID（いちばん上は ""） */
  rel: string;
  /** 親（いちばん上の Entity だけ null） */
  parent: string | null;
  name: string;
  order: number;
  /** 値。Entity の参照は、印を付けた形（MARK + rel）で持つ */
  states: Record<KokoStateId, KokoStateValues>;
  /** Entity の参照を持つフィールド（展開のたびに付け替える所） */
  refs: RefField[];
  origin: { prefab: string; entity: EntityId };
}

/** プレハブを、入れ子まで開いた形。インスタンスごとに、ID を付け替えて使う */
interface Template {
  /** いちばん上の Entity が先頭。親は子より前 */
  entities: TemplateEntity[];
  systems: OutputSystem[];
  /** entity は rel */
  keep: KeepMark[];
  /** 消えた親から、さらに親へたどるための道（ID は rel） */
  deletedParents: Record<string, string | null>;
}

function mergeStateFields(
  base: Record<KokoStateId, KokoStateValues>,
  fields: Record<KokoStateId, KokoStateValues> | undefined,
): Record<KokoStateId, KokoStateValues> {
  const result = { ...base };
  for (const [koko, values] of Object.entries(fields ?? {}))
    result[koko] = { ...result[koko], ...values };
  return result;
}

/** 入れ子のインスタンスごと消えたときは、その中の道から消えたインスタンスまで戻る。 */
function deletedParentOf(
  id: string,
  parents: ReadonlyMap<string, string | null>,
): string | null | undefined {
  let path = id;
  while (path) {
    if (parents.has(path)) return parents.get(path);
    const at = path.lastIndexOf(EXPANDED_ID_SEPARATOR);
    if (at < 0) break;
    path = path.slice(0, at);
  }
  return undefined;
}

interface CacheEntry {
  template: Template | null;
  /** このテンプレートを作るのに読んだプレハブと、その中身の鍵（ないプレハブは null） */
  read: Map<string, string | null>;
}

/** 展開したインスタンス（インスタンスも、プレハブを開いた形も変わっていなければ、そのまま使う） */
interface Stamp {
  /** インスタンスの中身の鍵 */
  key: string;
  template: Template;
  entities: ExpandedEntity[];
}

/**
 * 展開の結果を取っておく入れ物。プレハブごとに、入れ子まで開いた形を覚えておき、
 * そのプレハブ（と、中で使っているプレハブ）が変わるまで使い回す。インスタンスごとの展開した Entity も
 * 覚えておき、変わったプレハブを使っているインスタンスと、変わったインスタンスだけを展開し直す。
 */
export class PrefabExpansionCache {
  /** @internal */
  entries = new Map<string, CacheEntry>();
  /** @internal インスタンスの ID → 展開したもの */
  stamps = new Map<EntityId, Stamp>();
  /** @internal */
  defsKey = "";
  /** @internal */
  schemas: FieldSchemas | undefined;
  /** プレハブを開いた形を、作り直した回数（計測と確かめ用） */
  builds = 0;
  /** インスタンスを、展開し直した回数（計測と確かめ用） */
  stamped = 0;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    // Map・Set・Date の中身は凍らせられないが、入れ物は凍らせておく
    Object.freeze(value);
    if (Array.isArray(value)) for (const v of value) freeze(v);
    else if (Object.getPrototypeOf(value) === Object.prototype)
      for (const v of Object.values(value)) freeze(v);
  }
  return value;
}

/** System の並びを足し合わせる。同じ System は一つにまとめ、どれかで「入」なら「入」 */
function mergeSystems(into: OutputSystem[], more: readonly OutputSystem[]): void {
  for (const s of more) {
    const at = into.findIndex((x) => x.id === s.id);
    if (at < 0) into.push({ id: s.id, enabled: s.enabled });
    else if (s.enabled && !into[at]?.enabled) into[at] = { id: s.id, enabled: true };
  }
}

const keepKey = (k: KeepMark) => `${k.entity}\u0000${k.koko}\u0000${k.field}`;

class Expander {
  private readonly prefabs = new Map<string, PrefabDef>();
  private readonly prefabEntities = new Map<string, PrefabEntityDef[]>();
  private readonly defs = new Map<string, KokoStateDef>();
  private readonly ownKeys = new Map<string, string | null>();
  private readonly cache: PrefabExpansionCache;

  constructor(
    private readonly snap: ProjectSnapshot,
    private readonly options: ExpandOptions,
  ) {
    for (const p of snap.prefabs ?? []) this.prefabs.set(p.id, p);
    for (const e of snap.prefabEntities ?? []) {
      const list = this.prefabEntities.get(e.prefab);
      if (list) list.push(e);
      else this.prefabEntities.set(e.prefab, [e]);
    }
    for (const k of [...BUILTIN_KOKOSTATES, ...snap.kokostates, ...(options.kokostates ?? [])])
      this.defs.set(k.id, k);
    this.cache = options.cache ?? new PrefabExpansionCache();
    // 参照の付け替えは、フィールドの型で決まる。型が変わったら、取っておいたものは捨てる
    const defsKey = JSON.stringify(
      [...this.defs.values()].map((d) => [d.id, d.fields.map((f) => [f.id, f.type])]),
    );
    if (this.cache.defsKey !== defsKey || this.cache.schemas !== options.schemas) {
      this.cache.entries.clear();
      this.cache.defsKey = defsKey;
      this.cache.schemas = options.schemas;
    }
  }

  /** プレハブの中身の鍵（そのプレハブと、中の Entity。中で使っているプレハブは含めない） */
  private ownKey(prefab: string): string | null {
    let key = this.ownKeys.get(prefab);
    if (key === undefined) {
      const def = this.prefabs.get(prefab);
      key = def ? stringifyValue([def, this.prefabEntities.get(prefab) ?? []]) : null;
      this.ownKeys.set(prefab, key);
    }
    return key;
  }

  /** Entity の参照を持つフィールド */
  private refFields(states: Record<KokoStateId, KokoStateValues>): RefField[] {
    const out: RefField[] = [];
    for (const koko of Object.keys(states))
      for (const f of this.defs.get(koko)?.fields ?? []) {
        const schema = schemaOfField(this.options.schemas, koko, f);
        if (schema && hasRefs(schema)) out.push({ koko, field: f.id, schema });
      }
    return out;
  }

  /** refs のフィールドの中の、Entity の参照を付け替える（付け替えた所だけ新しく作る） */
  private mapEntityRefs(
    states: Record<KokoStateId, KokoStateValues>,
    refs: readonly RefField[],
    replace: (id: string) => string | undefined,
  ): Record<KokoStateId, KokoStateValues> {
    if (refs.length === 0) return states;
    const out: Record<KokoStateId, KokoStateValues> = { ...states };
    for (const r of refs) {
      const values = out[r.koko];
      if (!values || !Object.hasOwn(values, r.field)) continue;
      const mapped = mapRefs(r.schema, values[r.field], (target, id) =>
        target === "entity" ? replace(id) : undefined,
      ) as KokoStateValues[string];
      out[r.koko] = { ...values, [r.field]: mapped };
    }
    return out;
  }

  /**
   * プレハブを、入れ子まで開く。stack は、いま開いている途中のプレハブ（自分を含むプレハブは開かない）。
   * 開けないとき（プレハブがない・いちばん上の Entity がない）は null。
   */
  private template(
    prefabId: string,
    stack: readonly string[],
    read: Map<string, string | null>,
  ): { template: Template | null; cyclic: boolean } {
    read.set(prefabId, this.ownKey(prefabId));
    const cached = this.cache.entries.get(prefabId);
    if (cached && [...cached.read].every(([id, key]) => this.ownKey(id) === key)) {
      // 取っておいたものが使えても、輪の中なら開かない（stack にあるものを読んでいたら作り直す）
      if (![...cached.read.keys()].some((id) => stack.includes(id))) {
        for (const [id, key] of cached.read) read.set(id, key);
        return { template: cached.template, cyclic: false };
      }
    }
    const mine = new Map<string, string | null>([[prefabId, this.ownKey(prefabId)]]);
    const built = this.build(prefabId, stack, mine);
    for (const [id, key] of mine) read.set(id, key);
    // 輪を避けて作ったものは、開く順で形が変わるので取っておかない
    if (!built.cyclic) this.cache.entries.set(prefabId, { template: built.template, read: mine });
    return built;
  }

  private build(
    prefabId: string,
    stack: readonly string[],
    read: Map<string, string | null>,
  ): { template: Template | null; cyclic: boolean } {
    this.cache.builds++;
    const def = this.prefabs.get(prefabId);
    const all = this.prefabEntities.get(prefabId) ?? [];
    const byId = new Map(all.map((e) => [e.id, e]));
    const root = def ? byId.get(def.root) : undefined;
    if (!def || !root) return { template: null, cyclic: false };

    let cyclic = false;
    const inside = [...stack, prefabId];
    /** プレハブの中の ID を、いちばん上からの ID にする（このプレハブの Entity でなければ undefined） */
    const relOf = (id: string): string | undefined => {
      const cut = id.indexOf(EXPANDED_ID_SEPARATOR);
      const head = cut < 0 ? id : id.slice(0, cut);
      if (!byId.has(head)) return undefined;
      if (head !== root.id) return id;
      return cut < 0 ? "" : id.slice(cut + 1);
    };
    const marked = (states: Record<KokoStateId, KokoStateValues>) => {
      const refs = this.refFields(states);
      return {
        refs,
        states: this.mapEntityRefs(states, refs, (id) => {
          const rel = relOf(id);
          return rel === undefined ? undefined : MARK + rel;
        }),
      };
    };

    // 親ごとの子（並び順）。親が見つからないものは、いちばん上の Entity の下に付ける
    const kids = new Map<string, PrefabEntityDef[]>();
    for (const e of all) {
      if (e.id === root.id) continue;
      const parent = e.parent !== null && byId.has(e.parent) ? e.parent : root.id;
      const list = kids.get(parent);
      if (list) list.push(e);
      else kids.set(parent, [e]);
    }
    for (const list of kids.values())
      list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const entities: TemplateEntity[] = [];
    const systems: OutputSystem[] = def.systems.map((s) => ({ id: s.id, enabled: s.enabled }));
    const keep: KeepMark[] = [];
    const deletedParents: Record<string, string | null> = {};
    for (const [id, parent] of Object.entries(def.deletedParents ?? {}))
      deletedParents[id] = parent === root.id ? "" : parent;
    for (const k of def.keep) {
      const rel = relOf(k.entity);
      if (rel !== undefined) keep.push({ ...k, entity: rel });
    }

    const visited = new Set<string>();
    const visit = (e: PrefabEntityDef, parent: string | null) => {
      if (visited.has(e.id)) return; // 親子が輪になっている（壊れたデータ）
      visited.add(e.id);
      const rel = e.id === root.id ? "" : e.id;
      const own = marked(e.states);
      mergeSystems(systems, e.unpackedSystems ?? []);
      const origin = { prefab: prefabId, entity: e.id };
      const link = e.id === root.id ? undefined : e.instanceOf;
      let nested: Template | null = null;
      if (link) {
        if (inside.includes(link.prefab)) cyclic = true;
        else {
          const got = this.template(link.prefab, inside, read);
          nested = got.template;
          cyclic ||= got.cyclic;
        }
      }
      const nestedRoot = nested?.entities[0];
      if (!nested || !nestedRoot) {
        entities.push({
          rel,
          parent: e.parent?.includes("/") ? (relOf(e.parent) ?? parent) : parent,
          name: e.name,
          order: e.order,
          ...own,
          origin,
        });
      } else {
        // 入れ子のインスタンス：中のプレハブの Entity を、この Entity の下の ID に付け替えて足す
        const rebase = (t: TemplateEntity) =>
          this.mapEntityRefs(t.states, t.refs, (id) =>
            id.startsWith(MARK) ? MARK + join(rel, id.slice(MARK.length)) : undefined,
          );
        const states = mergeStateFields(rebase(nestedRoot), own.states);
        entities.push({
          rel,
          parent: e.parent?.includes("/") ? (relOf(e.parent) ?? parent) : parent,
          name: e.name,
          order: e.order,
          states,
          refs: this.refFields(states),
          origin: nestedRoot.origin,
        });
        for (const t of nested.entities.slice(1))
          entities.push({
            rel: join(rel, t.rel),
            parent: join(rel, t.parent ?? ""),
            name: t.name,
            order: t.order,
            states: rebase(t),
            refs: t.refs,
            origin: t.origin,
          });
        mergeSystems(systems, nested.systems);
        for (const k of nested.keep) keep.push({ ...k, entity: join(rel, k.entity) });
        for (const [id, parent] of Object.entries(nested.deletedParents))
          deletedParents[join(rel, id)] = parent === null ? rel : join(rel, parent);
      }
      for (const kid of kids.get(e.id) ?? []) visit(kid, rel);
      // 解除した Entity も、元の追加分は子の System のあとに置く。
      mergeSystems(systems, e.instanceSystems ?? []);
    };
    visit(root, null);

    // 内側の上書きは template の中で済んでいる。外側のインスタンスの分を最後に重ねる。
    for (const e of all) {
      if (!e.instanceOf || e.id === root.id) continue;
      for (const [path, patch] of Object.entries(e.prefabOverrides ?? {})) {
        const at = entities.findIndex((t) => t.rel === join(e.id, path));
        const before = entities[at];
        if (!before) continue;
        const values = marked(
          mergeStateFields(mergeStateFields(before.states, patch.addedStates), patch.states),
        );
        entities[at] = {
          ...before,
          ...values,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.order === undefined ? {} : { order: patch.order }),
          ...(patch.parent === undefined
            ? {}
            : { parent: patch.parent === null ? e.id : (relOf(patch.parent) ?? patch.parent) }),
        };
      }
    }

    const present = new Set(entities.map((e) => e.rel));
    const removed = new Map(Object.entries(deletedParents));
    for (const t of entities) {
      let parent = t.parent;
      const seen = new Set<string>();
      while (parent !== null && !present.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        parent = deletedParentOf(parent, removed) ?? "";
      }
      if (t.rel !== "") t.parent = parent;
    }

    for (const t of entities) freeze(t.states);
    return { template: { entities, systems, keep, deletedParents }, cyclic };
  }

  /** インスタンスを、テンプレートから展開する */
  private stamp(instance: EntityDef, template: Template): ExpandedEntity[] {
    const out: ExpandedEntity[] = [];
    const replace = (id: string) =>
      id.startsWith(MARK) ? join(instance.id, id.slice(MARK.length)) : undefined;
    for (const t of template.entities) {
      let states = this.mapEntityRefs(t.states, t.refs, replace);
      const patch = instance.prefabOverrides?.[t.rel];
      states = mergeStateFields(mergeStateFields(states, patch?.addedStates), patch?.states);
      const origin: PrefabOrigin = { instance: instance.id, ...t.origin };
      if (t.rel === "") {
        const {
          instanceOf: _link,
          prefabOverrides: _overrides,
          instanceSystems: _systems,
          unpackedSystems: _unpacked,
          ...rest
        } = instance;
        // いちばん上の Entity：ID・名前・親・並び順と、場所・向き・大きさは、インスタンスのもの
        states = mergeStateFields(this.mapEntityRefs(t.states, t.refs, replace), instance.states);
        states = mergeStateFields(mergeStateFields(states, patch?.addedStates), patch?.states);
        out.push({ ...rest, states, origin });
      } else {
        out.push({
          id: join(instance.id, t.rel),
          name: patch?.name ?? t.name,
          parent:
            patch?.parent === undefined
              ? join(instance.id, t.parent ?? "")
              : (patch.parent ?? instance.id),
          output: instance.output,
          order: patch?.order ?? t.order,
          states,
          origin,
        });
      }
    }
    return out;
  }

  /** stack は、いま開いている途中のプレハブ（プレハブを編集用に開くときの、そのプレハブ） */
  run(stack: readonly string[] = []): ExpandedSnapshot {
    const snap = this.snap;
    if (
      !snap.entities.some(
        (e) => e.instanceOf || e.unpackedSystems?.length || e.instanceSystems?.length,
      )
    )
      return snap;

    const entities: ExpandedEntity[] = [];
    /** アウトプット → その中のインスタンス（制作データの並び） */
    const used = new Map<string, { instance: EntityDef; template: Template }[]>();
    // 取っておく入れ物を渡されたときだけ、インスタンスごとの結果も取っておく
    const stamps = this.options.cache ? new Map<EntityId, Stamp>() : null;
    for (const e of snap.entities) {
      // 開いている途中のプレハブを含むインスタンス（輪）は、展開しない
      const template =
        e.instanceOf && !stack.includes(e.instanceOf.prefab)
          ? this.template(e.instanceOf.prefab, stack, new Map()).template
          : null;
      if (!e.instanceOf || !template) {
        // プレハブがないインスタンスは、そのまま残す（問題として出す）
        if (e.instanceOf) entities.push(e);
        else {
          const { unpackedSystems: _unpacked, instanceSystems: _systems, ...rest } = e;
          entities.push(rest);
        }
        continue;
      }
      const key = stamps ? stringifyValue(e) : "";
      const had = stamps ? this.cache.stamps.get(e.id) : undefined;
      let stamped = had?.entities;
      if (!had || !stamped || had.key !== key || had.template !== template) {
        stamped = this.stamp(e, template);
        this.cache.stamped++;
      }
      stamps?.set(e.id, { key, template, entities: stamped });
      for (const x of stamped) entities.push(x);
      const list = used.get(e.output);
      if (list) list.push({ instance: e, template });
      else used.set(e.output, [{ instance: e, template }]);
    }

    // プレハブで消えた親を指す追加 Entity と、親の上書きは、残っている最も近い祖先へ付ける。
    const parents = new Map<string, string | null>();
    for (const list of used.values())
      for (const { instance, template } of list) {
        for (const [id, parent] of Object.entries(template.deletedParents))
          parents.set(
            join(instance.id, id),
            parent === null ? instance.id : join(instance.id, parent),
          );
      }
    const present = new Map(entities.map((e) => [e.id, e]));
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e || e.parent === null) continue;
      let parent = e.parent;
      const seen = new Set<string>([e.id]);
      while (!present.has(parent) && !seen.has(parent)) {
        const next = deletedParentOf(parent, parents);
        if (next === undefined) break;
        seen.add(parent);
        parent = next ?? "";
      }
      if (parent && parent !== e.parent) {
        const next = { ...e, parent };
        entities[i] = next;
        present.set(e.id, next);
      }
    }
    // 壊れた・同時編集されたデータでも親子の輪を表示側へ渡さない。
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e) continue;
      const seen = new Set<string>([e.id]);
      let parent = e.parent;
      while (parent !== null) {
        if (seen.has(parent)) {
          const root = e.origin?.instance;
          const next = { ...e, parent: root && root !== e.id && !seen.has(root) ? root : null };
          entities[i] = next;
          present.set(e.id, next);
          break;
        }
        seen.add(parent);
        parent = present.get(parent)?.parent ?? null;
      }
    }

    const outputs = snap.outputs.map((o) => {
      const list = used.get(o.id) ?? [];
      const source = new Map(snap.entities.filter((e) => e.output === o.id).map((e) => [e.id, e]));
      const templates = new Map(list.map(({ instance, template }) => [instance.id, template]));
      // アウトプットのものが先。解除したプレハブ本体は子より前、元の追加分は子よりあとに置く。
      const extra: OutputSystem[] = [];
      walkHierarchy(
        entities.filter((e) => e.output === o.id),
        (id) => {
          const e = source.get(id);
          if (!e) return;
          mergeSystems(extra, e.unpackedSystems ?? []);
          mergeSystems(extra, templates.get(id)?.systems ?? []);
        },
        (id) => mergeSystems(extra, source.get(id)?.instanceSystems ?? []),
      );
      const own = new Set(o.systems.map((s) => s.id));
      const systems = [...o.systems, ...extra.filter((s) => !own.has(s.id))];
      // 「維持」の印：プレハブの中で付けたものを、展開した Entity の ID にして足す
      const keep = [...o.keep];
      const seen = new Set(keep.map(keepKey));
      for (const { instance, template } of list)
        for (const k of template.keep) {
          const mark = { ...k, entity: join(instance.id, k.entity) };
          if (seen.has(keepKey(mark))) continue;
          seen.add(keepKey(mark));
          keep.push(mark);
        }
      return { ...o, systems, keep } satisfies OutputDef;
    });
    // いまないインスタンスの分は、捨てる
    if (stamps) this.cache.stamps = stamps;
    return { ...snap, entities, outputs };
  }
}

/** Hierarchy の子に入る前と、子を出たあとに呼ぶ。壊れた親子の輪も一度ずつたどる。 */
function walkHierarchy(
  entities: readonly EntityBase[],
  enter: (id: EntityId) => void,
  leave: (id: EntityId) => void,
): void {
  const ids = new Set(entities.map((e) => e.id));
  const kids = new Map<string | null, EntityBase[]>();
  for (const e of entities) {
    const parent = e.parent !== null && ids.has(e.parent) ? e.parent : null;
    const list = kids.get(parent);
    if (list) list.push(e);
    else kids.set(parent, [e]);
  }
  const seen = new Set<EntityId>();
  const walk = (parent: string | null) => {
    const list = [...(kids.get(parent) ?? [])].sort(
      (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      enter(e.id);
      walk(e.id);
      leave(e.id);
    }
  };
  walk(null);
  // 親子が輪になっていて届かなかったものは、あとに回す
  for (const e of entities) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    enter(e.id);
    walk(e.id);
    leave(e.id);
  }
}

/**
 * インスタンスを、プレハブの中身に置き換えた制作データを作る。インスタンスがなければ、渡したものをそのまま返す。
 * 展開したものをもう一度渡しても、同じものが返る（展開したあとは、インスタンスの印がない）。
 *
 * 自分を含むプレハブ（輪）と、プレハブがないインスタンスは、展開せずに残す（`prefabProblems` で分かる）。
 */
export function expandPrefabs(
  snap: ProjectSnapshot,
  options: ExpandOptions = {},
): ExpandedSnapshot {
  return new Expander(snap, options).run();
}

/**
 * プレハブを、編集用の Entity の並びにする（ADR 0076）。プレハブを開いて直すときの
 * Hierarchy・Inspector・空間の表示が読む。アウトプットを展開したものと同じ形なので、`buildWorld` にそのまま渡せる。
 *
 * - プレハブの中の Entity は、そのままの ID。`output` には、プレハブの ID を入れる
 * - いちばん上の Entity だけが親を持たない。親が見つからない Entity は、いちばん上の Entity の下に付ける
 * - 中に置いた別のプレハブのインスタンス（入れ子）は、「その Entity の ID / 中の ID」で展開する（origin が付く）。
 *   このプレハブを含むもの（輪）は、展開しない
 * - `outputs` は、このプレハブを表す一つだけ（ID はプレハブの ID。System と「維持」の印は、入れ子の分を足し合わせたもの）
 *
 * プレハブか、そのいちばん上の Entity がなければ null。取っておく入れ物（cache）は、
 * アウトプットの展開（`expandPrefabs`）のものとは分ける（インスタンスごとの結果が、互いを捨て合うため）。
 */
export function expandPrefabForEdit(
  snap: ProjectSnapshot,
  prefabId: string,
  options: ExpandOptions = {},
): ExpandedSnapshot | null {
  const prefab = snap.prefabs?.find((p) => p.id === prefabId);
  const own = (snap.prefabEntities ?? []).filter((e) => e.prefab === prefabId);
  if (!prefab || !own.some((e) => e.id === prefab.root)) return null;
  const ids = new Set(own.map((e) => e.id));
  const entities: EntityDef[] = own.map(({ prefab: _prefab, ...e }) => {
    if (e.id !== prefab.root) {
      let parent = e.parent;
      const seen = new Set<string>();
      while (parent !== null && !ids.has(parent) && !parent.includes("/") && !seen.has(parent)) {
        seen.add(parent);
        parent = prefab.deletedParents?.[parent] ?? prefab.root;
      }
      return {
        ...e,
        parent: parent !== null && ids.has(parent.split("/")[0] ?? parent) ? parent : prefab.root,
        output: prefabId,
      };
    }
    // いちばん上の Entity が持つインスタンスの印は、使わない（展開でも数えない）
    const { instanceOf: _link, ...root } = e;
    return { ...root, parent: null, output: prefabId };
  });
  const output: OutputDef = {
    id: prefabId,
    name: prefab.name,
    kind: "item",
    systems: prefab.systems,
    keep: prefab.keep,
  };
  return new Expander({ ...snap, entities, outputs: [output] }, options).run([prefabId]);
}

export type PrefabProblem =
  /** プレハブがない（消した・取り込んでいない） */
  | { kind: "missing"; owner: PrefabOwner; entity: EntityId; prefab: string }
  /** プレハブが、自分を含んでいる。path は、たどった順（最後が owner のプレハブ） */
  | { kind: "cycle"; owner: PrefabOwner; entity: EntityId; prefab: string; path: string[] };

/** インスタンスを持っているもの（アウトプットか、プレハブ） */
export type PrefabOwner = { kind: "output"; id: string } | { kind: "prefab"; id: string };

/** インスタンスの問題：プレハブがない・プレハブが自分を含んでいる */
export function prefabProblems(snap: ProjectSnapshot): PrefabProblem[] {
  const prefabs = new Map((snap.prefabs ?? []).map((p) => [p.id, p]));
  const out: PrefabProblem[] = [];
  /** プレハブ → 中で使っているプレハブ（いちばん上の Entity のものは数えない） */
  const uses = new Map<string, Set<string>>();
  for (const e of snap.prefabEntities ?? []) {
    if (!e.instanceOf || prefabs.get(e.prefab)?.root === e.id) continue;
    const set = uses.get(e.prefab) ?? new Set<string>();
    set.add(e.instanceOf.prefab);
    uses.set(e.prefab, set);
  }
  /** from から to へ、使っている順にたどれるなら、その道（from と to を含む） */
  const pathTo = (from: string, to: string): string[] | null => {
    const seen = new Set<string>();
    const walk = (at: string): string[] | null => {
      if (at === to) return [at];
      if (seen.has(at)) return null;
      seen.add(at);
      for (const next of uses.get(at) ?? []) {
        const rest = walk(next);
        if (rest) return [at, ...rest];
      }
      return null;
    };
    return walk(from);
  };
  for (const e of snap.entities) {
    if (e.instanceOf && !prefabs.has(e.instanceOf.prefab))
      out.push({
        kind: "missing",
        owner: { kind: "output", id: e.output },
        entity: e.id,
        prefab: e.instanceOf.prefab,
      });
  }
  for (const e of snap.prefabEntities ?? []) {
    if (!e.instanceOf || prefabs.get(e.prefab)?.root === e.id) continue;
    const owner: PrefabOwner = { kind: "prefab", id: e.prefab };
    const target = e.instanceOf.prefab;
    if (!prefabs.has(target)) {
      out.push({ kind: "missing", owner, entity: e.id, prefab: target });
      continue;
    }
    const path = pathTo(target, e.prefab);
    if (path) out.push({ kind: "cycle", owner, entity: e.id, prefab: target, path });
  }
  return out;
}
