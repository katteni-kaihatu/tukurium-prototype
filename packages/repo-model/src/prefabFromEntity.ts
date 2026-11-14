import {
  type EntityId,
  type FieldSchemas,
  type FieldValue,
  hasRefs,
  type KokoStateDef,
  type KokoStateId,
  type KokoStateValues,
  mapRefs,
  schemaOfField,
  type ValueSchema,
} from "@tukurium/eks";
import { BUILTIN, BUILTIN_KOKOSTATES } from "./builtins";
import {
  EXPANDED_ID_SEPARATOR,
  expandPrefabForEdit,
  expandPrefabs,
  type PrefabOwner,
} from "./prefab";
import { prefabUsePath } from "./prefabNesting";
import {
  type EntityBase,
  type EntityDef,
  type KeepMark,
  newId,
  type OutputSystem,
  type PrefabDef,
  type PrefabEntityDef,
  type ProjectSnapshot,
} from "./schema";

/**
 * アウトプットか、プレハブの中の Entity から、プレハブを作る（ADR 0076 の 10）。
 *
 * ここでは「何を移し、何を書き換えるか」の計画だけを作る（制作データは変えない）。確認の画面は、
 * この計画を見せる。実行は `ProjectDoc.makePrefabFromEntity()`。
 *
 * - 選んだ Entity は、ID・名前・親・並び順・Transform を持ったまま、インスタンスになる
 * - 中身（選んだ Entity の KokoState と、中の Entity）は、新しい ID を付けてプレハブに移す
 * - プレハブに移した Entity どうしの参照は、プレハブの中の ID に書き換える
 * - ほかの Entity から中の Entity への参照は、展開したあとの ID（インスタンスの ID / 中の ID）に書き換える
 */

export interface PrefabFromEntityOptions {
  /** TypeScript で作ったフィールドのスキーマ（あれば、入れ子の値の中の参照も書き換える） */
  schemas?: FieldSchemas;
  /** 制作データにない KokoState の定義（依存から取り込んだもの） */
  kokostates?: readonly KokoStateDef[];
  /** プレハブの名前。省くと、Entity の名前 */
  name?: string;
  /**
   * プレハブにも入れる System（アウトプットで動かしているものから選ぶ）。アウトプットの並びには残すので、
   * 動く順と「入・切」は変わらない。省くと、入れない
   */
  systems?: readonly string[];
  /**
   * 前に作った計画の ID を使い続ける（確認の画面に出した ID のまま変換する）。
   * entities は、元の Entity の ID → プレハブの中の ID
   */
  ids?: { prefab?: string; entities?: Readonly<Record<EntityId, EntityId>> };
}

/** プレハブに移す Entity と、その対応 */
export interface MovedEntity {
  /** 元の Entity の ID */
  from: EntityId;
  /** プレハブの中の ID（選んだ Entity は、いちばん上の Entity の ID） */
  to: EntityId;
  /** 変換のあと、アウトプットを展開したときの ID（選んだ Entity は、元の ID のまま） */
  expanded: EntityId;
  name: string;
  /** 選んだ Entity（0）からの深さ */
  depth: number;
}

/** 書き換える参照：プレハブに移さない Entity のフィールドが、移す Entity を指している所 */
export interface RefRewrite {
  /** その Entity の持ち主（アウトプットか、ほかのプレハブ） */
  owner: PrefabOwner;
  entity: EntityId;
  entityName: string;
  koko: KokoStateId;
  kokoName: string;
  field: string;
  fieldName: string;
  /** 指す先の付け替え（元の ID → 展開したあとの ID） */
  targets: { from: EntityId; to: EntityId }[];
  /** 書き換えたあとの、フィールドの値 */
  value: FieldValue;
  /** インスタンスの上書きの中にある参照。ないときは Entity 自身の値。 */
  override?: { path: string; added: boolean };
}

/** プレハブに移す Entity が、プレハブに移さない Entity を指している所（ほかのアウトプットに置くと、切れる） */
export interface OutsideRef {
  /** 元の Entity の ID */
  entity: EntityId;
  entityName: string;
  kokoName: string;
  fieldName: string;
  target: EntityId;
  targetName: string;
}

/** System のコードに、プレハブに移す Entity の ID が書いてある所（ID が変わるので、利用者が直す） */
export interface ScriptMention {
  system: string;
  name: string;
  entities: { id: EntityId; name: string; expanded: EntityId }[];
}

export interface PrefabFromEntityPlan {
  /** 選んだ Entity（インスタンスになる。ID はそのまま） */
  entity: EntityId;
  owner: PrefabOwner;
  /** 作るプレハブ */
  prefab: PrefabDef;
  /** プレハブの中の Entity（いちばん上の Entity が先頭） */
  prefabEntities: PrefabEntityDef[];
  /** 変換のあとの、選んだ Entity（インスタンス） */
  instance: EntityDef | PrefabEntityDef;
  /** プレハブに移す Entity（選んだ Entity が先頭。Hierarchy の並び） */
  moved: MovedEntity[];
  /** 書き換える参照 */
  rewrites: RefRewrite[];
  /** プレハブに移す「維持」の印（from：持ち主の印、to：新しいプレハブの印） */
  keepMoved: { from: KeepMark; to: KeepMark; entityName: string }[];
  /** 変換のあとの、元の持ち主の「維持」の印 */
  ownerKeep: KeepMark[];
  /** ほかの持ち主にある、展開した Entity を指す「維持」の印も書き換える */
  keepRewrites: {
    owner: PrefabOwner;
    keep: KeepMark[];
    changes: { from: KeepMark; to: KeepMark }[];
  }[];
  structureRewrites: {
    owner: PrefabOwner;
    entity: string;
    name: string;
    kind: string;
    from: string;
    to: string;
  }[];
  /** 実行は P5 と同じ、フィールドごとの書き込みを使う。 */
  before: ProjectSnapshot;
  after: ProjectSnapshot;
  outsideRefs: OutsideRef[];
  scriptMentions: ScriptMention[];
}

export type PrefabFromEntityResult =
  | { ok: true; plan: PrefabFromEntityPlan }
  /** 変換できない。reason は、利用者に見せるわけ */
  | { ok: false; reason: string };

/** ID の頭（「/」でつないだ、展開した ID の、いちばん外側） */
const headOf = (id: string): string => {
  const cut = id.indexOf(EXPANDED_ID_SEPARATOR);
  return cut < 0 ? id : id.slice(0, cut);
};
const restOf = (id: string): string => {
  const cut = id.indexOf(EXPANDED_ID_SEPARATOR);
  return cut < 0 ? "" : id.slice(cut);
};

const byOrder = (a: EntityBase, b: EntityBase) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const refuse = (reason: string): PrefabFromEntityResult => ({ ok: false, reason });

/**
 * Entity からプレハブを作る計画を作る。変換できないときは、わけを返す。
 * 新しい ID は、ここで決める（`options.ids` を渡すと、その ID を使う）。
 */
export function planPrefabFromEntity(
  snap: ProjectSnapshot,
  entityId: EntityId,
  options: PrefabFromEntityOptions = {},
): PrefabFromEntityResult {
  const source =
    snap.entities.find((e) => e.id === entityId) ??
    snap.prefabEntities?.find((e) => e.id === entityId);
  if (!source) {
    if (entityId.includes(EXPANDED_ID_SEPARATOR))
      return refuse(
        "プレハブから来た Entity は、プレハブにできません（中身は、プレハブのものです）",
      );
    return refuse("Entity がありません");
  }
  if (source.instanceOf) return refuse("この Entity は、すでにプレハブのインスタンスです");
  const owner: PrefabOwner =
    "prefab" in source
      ? { kind: "prefab", id: source.prefab }
      : { kind: "output", id: source.output };
  const definition =
    owner.kind === "prefab"
      ? snap.prefabs?.find((p) => p.id === owner.id)
      : snap.outputs.find((o) => o.id === owner.id);
  if (!definition) return refuse("Entity の持ち主がありません");
  if ("kind" in definition && definition.kind === "library")
    return refuse("ライブラリのアウトプットの Entity は、プレハブにできません");
  if ("root" in definition && definition.root === source.id)
    return refuse("プレハブのいちばん上の Entity は、プレハブにできません");

  // 選んだ Entity と、中の Entity（同じ持ち主の中で、親をたどる）。Hierarchy の並びにする
  const peers: (EntityDef | PrefabEntityDef)[] =
    owner.kind === "prefab"
      ? (snap.prefabEntities ?? []).filter((e) => e.prefab === owner.id)
      : snap.entities.filter((e) => e.output === owner.id);
  const kids = new Map<EntityId, (EntityDef | PrefabEntityDef)[]>();
  for (const e of peers) {
    if (e.parent === null || e.id === source.id) continue;
    const list = kids.get(e.parent);
    if (list) list.push(e);
    else kids.set(e.parent, [e]);
  }
  const taken = new Set<EntityId>([
    ...snap.entities.map((e) => e.id),
    ...(snap.prefabEntities ?? []).map((e) => e.id),
  ]);
  const fresh = (from: EntityId): EntityId => {
    const given = options.ids?.entities?.[from];
    const id = given !== undefined && !taken.has(given) ? given : newId("ent");
    taken.add(id);
    return id;
  };
  /** 元の ID → プレハブの中の ID */
  const inside = new Map<EntityId, EntityId>();
  const moving: { def: EntityDef | PrefabEntityDef; depth: number }[] = [];
  const walk = (e: EntityDef | PrefabEntityDef, depth: number) => {
    if (inside.has(e.id)) return; // 親子が輪になっている（壊れたデータ）
    inside.set(e.id, fresh(e.id));
    moving.push({ def: e, depth });
    for (const kid of [...(kids.get(e.id) ?? [])].sort(byOrder)) walk(kid, depth + 1);
    if (e.instanceOf)
      for (const kid of peers.filter((p) => p.parent?.startsWith(`${e.id}/`)).sort(byOrder))
        walk(kid, depth + 1);
  };
  walk(source, 0);

  const rootId = inside.get(source.id) as EntityId;
  /** プレハブの中での ID（プレハブに移さないものは undefined）。中のインスタンスの中（D/x）も、頭を付け替える */
  const insideId = (id: string): string | undefined => {
    const to = inside.get(headOf(id));
    return to === undefined ? undefined : to + restOf(id);
  };
  if (
    moving.some(({ def }) =>
      Object.values(def.prefabOverrides ?? {}).some((p) => p.parent !== undefined),
    )
  ) {
    const view =
      owner.kind === "prefab"
        ? expandPrefabForEdit(snap, owner.id, options)
        : expandPrefabs(snap, options);
    for (const { def } of moving) {
      for (const [path, patch] of Object.entries(def.prefabOverrides ?? {})) {
        if (patch.parent === undefined || path === "") continue;
        const entity = view?.entities.find((e) => e.id === `${def.id}/${path}`);
        const parent = entity?.parent ?? patch.parent;
        if (parent === null || insideId(parent) !== undefined) continue;
        const parentName = view?.entities.find((e) => e.id === parent)?.name ?? parent;
        return refuse(
          `「${entity?.name ?? path}」の親「${parentName}」がプレハブに移すまとまりの外にあります。中の Entity に付け替えてからプレハブにしてください`,
        );
      }
    }
  }
  /** 変換後の ID。ほかのプレハブやアウトプットにある、この持ち主のインスタンスの中も書き換える。 */
  const expandedId = (id: string): string | undefined => {
    const parts = id.split(EXPANDED_ID_SEPARATOR);
    const at = parts.findIndex((part) => part !== source.id && inside.has(part));
    if (at < 0) return inside.has(parts[0] ?? "") ? id : undefined;
    const to = inside.get(parts[at] ?? "") as string;
    return [...parts.slice(0, at), source.id, to, ...parts.slice(at + 1)].join(
      EXPANDED_ID_SEPARATOR,
    );
  };

  const defs = new Map<string, KokoStateDef>();
  for (const k of [...BUILTIN_KOKOSTATES, ...snap.kokostates, ...(options.kokostates ?? [])])
    defs.set(k.id, k);
  /** Entity の参照を持つフィールド */
  const refFields = (states: Record<KokoStateId, KokoStateValues>) => {
    const out: { def: KokoStateDef; field: { id: string; name: string }; schema: ValueSchema }[] =
      [];
    for (const koko of Object.keys(states)) {
      const def = defs.get(koko);
      for (const f of def?.fields ?? []) {
        const schema = schemaOfField(options.schemas, koko, f);
        if (def && schema && hasRefs(schema)) out.push({ def, field: f, schema });
      }
    }
    return out;
  };
  const nameOf = new Map<EntityId, string>();
  for (const e of peers) nameOf.set(e.id, e.name);

  // プレハブの中の Entity：参照を、プレハブの中の ID に書き換える
  const outsideRefs: OutsideRef[] = [];
  const insideStates = (e: EntityDef | PrefabEntityDef): Record<KokoStateId, KokoStateValues> => {
    const states = structuredClone(e.states);
    for (const r of refFields(states)) {
      const values = states[r.def.id];
      if (!values || !Object.hasOwn(values, r.field.id)) continue;
      values[r.field.id] = mapRefs(r.schema, values[r.field.id], (target, id) => {
        if (target !== "entity") return undefined;
        const to = insideId(id);
        if (to === undefined && nameOf.has(headOf(id)))
          outsideRefs.push({
            entity: e.id,
            entityName: e.name,
            kokoName: r.def.name,
            fieldName: r.field.name,
            target: id,
            targetName: nameOf.get(headOf(id)) ?? id,
          });
        return to ?? expandedId(id);
      }) as FieldValue;
    }
    return states;
  };
  const prefabId = options.ids?.prefab ?? newId("pf");
  if (snap.prefabs?.some((p) => p.id === prefabId))
    return refuse("新しいプレハブの ID が、すでに使われています");
  const prefabEntities: PrefabEntityDef[] = moving.map(({ def }) => {
    const states = insideStates(def);
    if (def.id !== source.id)
      return {
        id: inside.get(def.id) as EntityId,
        name: def.name,
        parent: insideId(def.parent ?? "") ?? rootId,
        order: def.order,
        states,
        prefab: prefabId,
        ...(def.instanceOf ? { instanceOf: structuredClone(def.instanceOf) } : {}),
        ...(def.prefabOverrides
          ? {
              prefabOverrides: Object.fromEntries(
                Object.entries(def.prefabOverrides).map(([path, patch]) => [
                  path,
                  {
                    ...structuredClone(patch),
                    ...(patch.parent === undefined || patch.parent === null
                      ? {}
                      : { parent: insideId(patch.parent) ?? patch.parent }),
                    ...(patch.states
                      ? { states: insideStates({ ...def, states: patch.states }) }
                      : {}),
                    ...(patch.addedStates
                      ? { addedStates: insideStates({ ...def, states: patch.addedStates }) }
                      : {}),
                  },
                ]),
              ),
            }
          : {}),
        ...(def.instanceSystems ? { instanceSystems: structuredClone(def.instanceSystems) } : {}),
        ...(def.unpackedSystems ? { unpackedSystems: structuredClone(def.unpackedSystems) } : {}),
      };
    // いちばん上の Entity：向きと大きさは写す（あとで置くインスタンスが、同じ見た目になる）。場所は原点
    const transform = states[BUILTIN.Transform];
    if (transform) states[BUILTIN.Transform] = { ...transform, position: [0, 0, 0] };
    return {
      id: rootId,
      name: def.name,
      parent: null,
      order: 0,
      states,
      prefab: prefabId,
      ...(def.instanceSystems ? { instanceSystems: structuredClone(def.instanceSystems) } : {}),
      ...(def.unpackedSystems ? { unpackedSystems: structuredClone(def.unpackedSystems) } : {}),
    };
  });

  // 値は Transform だけ残す。空の KokoState は、同じ Y.Map への同時編集を受け取るために残す。
  const { instanceSystems: _systems, unpackedSystems: _unpacked, ...sourceBase } = source;
  const instance: EntityDef | PrefabEntityDef = {
    ...sourceBase,
    states: Object.fromEntries(
      Object.entries(source.states).map(([koko, values]) => [
        koko,
        koko === BUILTIN.Transform ? structuredClone(values) : {},
      ]),
    ),
    instanceOf: { prefab: prefabId },
    prefabOverrides: {},
  };

  // プレハブに移さない Entity の値・上書き・親を、新しい展開 ID に付け替える。
  const rewrites: RefRewrite[] = [];
  const structureRewrites: PrefabFromEntityPlan["structureRewrites"] = [];
  const rewriteStates = (
    e: EntityBase,
    owner: PrefabOwner,
    states: typeof e.states,
    override?: RefRewrite["override"],
  ) => {
    const rewritten = structuredClone(states);
    for (const r of refFields(states)) {
      const values = rewritten[r.def.id];
      if (!values || !Object.hasOwn(values, r.field.id)) continue;
      const targets: { from: EntityId; to: EntityId }[] = [];
      const value = mapRefs(r.schema, values[r.field.id], (target, id) => {
        if (target !== "entity") return undefined;
        const to = expandedId(id);
        if (to === undefined || to === id) return undefined;
        if (!targets.some((t) => t.from === id)) targets.push({ from: id, to });
        return to;
      }) as FieldValue;
      if (targets.length > 0)
        rewrites.push({
          owner,
          entity: e.id,
          entityName: e.name,
          koko: r.def.id,
          kokoName: r.def.name,
          field: r.field.id,
          fieldName: r.field.name,
          targets,
          value,
          ...(override ? { override } : {}),
        });
      values[r.field.id] = value;
    }
    return rewritten;
  };
  const after = structuredClone(snap);
  after.entities = after.entities.filter((e) => !inside.has(e.id));
  after.prefabEntities = (after.prefabEntities ?? []).filter((e) => !inside.has(e.id));
  for (const e of [...after.entities, ...after.prefabEntities]) {
    const eOwner: PrefabOwner =
      "output" in e ? { kind: "output", id: e.output } : { kind: "prefab", id: e.prefab };
    const mapStructure = (value: string, kind: string) => {
      const next = expandedId(value) ?? value;
      if (next !== value)
        structureRewrites.push({
          owner: eOwner,
          entity: e.id,
          name: e.name,
          kind,
          from: value,
          to: next,
        });
      return next;
    };
    if (e.parent !== null) e.parent = mapStructure(e.parent, "親");
    e.states = rewriteStates(e, eOwner, e.states);
    if (e.prefabOverrides)
      e.prefabOverrides = Object.fromEntries(
        Object.entries(e.prefabOverrides).map(([path, patch]) => {
          const original = path ? `${e.id}/${path}` : e.id;
          const target = mapStructure(original, "上書きの対象");
          const nextPath = target.startsWith(`${e.id}/`) ? target.slice(e.id.length + 1) : path;
          return [
            nextPath,
            {
              ...patch,
              ...(typeof patch.parent === "string"
                ? { parent: mapStructure(patch.parent, "上書きの親") }
                : {}),
              ...(patch.states
                ? { states: rewriteStates(e, eOwner, patch.states, { path, added: false }) }
                : {}),
              ...(patch.addedStates
                ? {
                    addedStates: rewriteStates(e, eOwner, patch.addedStates, { path, added: true }),
                  }
                : {}),
            },
          ];
        }),
      );
  }
  if ("output" in instance) after.entities.push(instance);
  else after.prefabEntities.push(instance);
  after.prefabEntities.push(...prefabEntities);

  // 「維持」の印：プレハブに移した Entity を指すものは、プレハブに移す（あとで置くインスタンスにも効く）。
  // 選んだ Entity の Transform の印だけは、アウトプットに残す（Transform は、インスタンスそのものが持つ）
  const keepMoved: PrefabFromEntityPlan["keepMoved"] = [];
  const ownerKeep: KeepMark[] = [];
  for (const k of definition.keep) {
    const to = insideId(k.entity);
    if (to === undefined || (k.entity === source.id && k.koko === BUILTIN.Transform)) {
      ownerKeep.push({ ...k, entity: expandedId(k.entity) ?? k.entity });
      continue;
    }
    keepMoved.push({
      from: k,
      to: { ...k, entity: to },
      entityName: nameOf.get(headOf(k.entity)) ?? k.entity,
    });
  }
  const keepRewrites: PrefabFromEntityPlan["keepRewrites"] = [];
  for (const [kind, definitions] of [
    ["output", snap.outputs],
    ["prefab", snap.prefabs ?? []],
  ] as const) {
    for (const def of definitions) {
      if (kind === owner.kind && def.id === owner.id) continue;
      const changes: { from: KeepMark; to: KeepMark }[] = [];
      const keep = def.keep.map((k) => {
        const entity = expandedId(k.entity);
        if (entity === undefined || entity === k.entity) return k;
        const to = { ...k, entity };
        changes.push({ from: k, to });
        return to;
      });
      if (changes.length > 0) keepRewrites.push({ owner: { kind, id: def.id }, keep, changes });
    }
  }

  // プレハブにも入れる System：アウトプットの並びと「入・切」のまま
  const wanted = new Set(options.systems ?? []);
  const systems: OutputSystem[] = definition.systems
    .filter((s) => wanted.has(s.id))
    .map((s) => ({ id: s.id, enabled: s.enabled }));
  const prefab: PrefabDef = {
    id: prefabId,
    name: options.name ?? source.name,
    root: rootId,
    systems,
    keep: keepMoved.map((k) => k.to),
    ...("deletedParents" in definition && definition.deletedParents
      ? {
          deletedParents: Object.fromEntries(
            Object.entries(definition.deletedParents).map(([id, parent]) => [
              insideId(id) ?? id,
              parent === null ? null : (insideId(parent) ?? parent),
            ]),
          ),
        }
      : {}),
  };
  for (const p of after.prefabs ?? []) {
    p.keep =
      p.id === owner.id && owner.kind === "prefab"
        ? ownerKeep
        : p.keep.map((k) => ({ ...k, entity: expandedId(k.entity) ?? k.entity }));
    if (p.deletedParents)
      p.deletedParents = Object.fromEntries(
        Object.entries(p.deletedParents).map(([id, parent]) => [
          expandedId(id) ?? id,
          parent === null ? null : (expandedId(parent) ?? parent),
        ]),
      );
  }
  for (const o of after.outputs)
    o.keep =
      o.id === owner.id && owner.kind === "output"
        ? ownerKeep
        : o.keep.map((k) => ({ ...k, entity: expandedId(k.entity) ?? k.entity }));
  after.prefabs = [...(after.prefabs ?? []), prefab];

  const moved: MovedEntity[] = moving.map(({ def, depth }) => ({
    from: def.id,
    to: inside.get(def.id) as EntityId,
    expanded: expandedId(def.id) as EntityId,
    name: def.name,
    depth,
  }));

  if (
    owner.kind === "prefab" &&
    prefabUsePath(
      { ...snap, prefabEntities: [...(snap.prefabEntities ?? []), ...prefabEntities] },
      prefabId,
      owner.id,
    )
  )
    return refuse("プレハブの中に、自分自身を含めることはできません");

  // スクリプトが、ID の変わる Entity（中の Entity）を ID で探していないか。書き換えはしない
  const scriptMentions: ScriptMention[] = [];
  for (const s of snap.systems) {
    const entities = moved
      .filter((m) => m.from !== source.id && s.code.includes(m.from))
      .map((m) => ({ id: m.from, name: m.name, expanded: m.expanded }));
    if (entities.length > 0) scriptMentions.push({ system: s.id, name: s.name, entities });
  }

  return {
    ok: true,
    plan: {
      entity: source.id,
      owner,
      prefab,
      prefabEntities,
      instance,
      moved,
      rewrites,
      keepMoved,
      ownerKeep,
      keepRewrites,
      structureRewrites,
      before: snap,
      after,
      outsideRefs,
      scriptMentions,
    },
  };
}
