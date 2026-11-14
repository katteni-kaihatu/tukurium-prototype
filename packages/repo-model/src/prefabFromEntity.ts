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
import { EXPANDED_ID_SEPARATOR, expandedEntityId, type PrefabOwner } from "./prefab";
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
 * アウトプットの Entity から、プレハブを作る（ADR 0076 の 10）。
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
  output: string;
  /** 作るプレハブ */
  prefab: PrefabDef;
  /** プレハブの中の Entity（いちばん上の Entity が先頭） */
  prefabEntities: PrefabEntityDef[];
  /** 変換のあとの、選んだ Entity（インスタンス） */
  instance: EntityDef;
  /** プレハブに移す Entity（選んだ Entity が先頭。Hierarchy の並び） */
  moved: MovedEntity[];
  /** 書き換える参照 */
  rewrites: RefRewrite[];
  /** プレハブに移す「維持」の印（from：アウトプットの印、to：プレハブの印） */
  keepMoved: { from: KeepMark; to: KeepMark; entityName: string }[];
  /** 変換のあとの、アウトプットの「維持」の印 */
  outputKeep: KeepMark[];
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
  const source = snap.entities.find((e) => e.id === entityId);
  if (!source) {
    if (entityId.includes(EXPANDED_ID_SEPARATOR))
      return refuse(
        "プレハブから来た Entity は、プレハブにできません（中身は、プレハブのものです）",
      );
    if (snap.prefabEntities?.some((e) => e.id === entityId))
      return refuse(
        "プレハブの中の Entity からは、プレハブを作れません。アウトプットの Entity から作ってください",
      );
    return refuse("Entity がありません");
  }
  if (source.instanceOf) return refuse("この Entity は、すでにプレハブのインスタンスです");
  const output = snap.outputs.find((o) => o.id === source.output);
  if (!output) return refuse("Entity が入っているアウトプットがありません");
  if (output.kind === "library")
    return refuse("ライブラリのアウトプットの Entity は、プレハブにできません");

  // 選んだ Entity と、中の Entity（同じアウトプットの中で、親をたどる）。Hierarchy の並びにする
  const peers = snap.entities.filter((e) => e.output === source.output);
  const kids = new Map<EntityId, EntityDef[]>();
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
  const moving: { def: EntityDef; depth: number }[] = [];
  const walk = (e: EntityDef, depth: number) => {
    if (inside.has(e.id)) return; // 親子が輪になっている（壊れたデータ）
    inside.set(e.id, fresh(e.id));
    moving.push({ def: e, depth });
    for (const kid of [...(kids.get(e.id) ?? [])].sort(byOrder)) walk(kid, depth + 1);
  };
  walk(source, 0);

  // インスタンスの中の Entity（展開した ID）を親にしている Entity は、プレハブの中にそのまま移せない
  for (const e of peers) {
    if (inside.has(e.id) || e.parent === null) continue;
    if (e.parent.includes(EXPANDED_ID_SEPARATOR) && inside.has(headOf(e.parent)))
      return refuse(
        `中のインスタンスの下に足した Entity（「${e.name}」）があるので、プレハブにできません。先に、その Entity を外へ出してください`,
      );
  }

  const rootId = inside.get(source.id) as EntityId;
  /** プレハブの中での ID（プレハブに移さないものは undefined）。中のインスタンスの中（D/x）も、頭を付け替える */
  const insideId = (id: string): string | undefined => {
    const to = inside.get(headOf(id));
    return to === undefined ? undefined : to + restOf(id);
  };
  /** 変換のあと、アウトプットを展開したときの ID（プレハブに移さないものは undefined） */
  const expandedId = (id: string): string | undefined => {
    const head = headOf(id);
    const to = inside.get(head);
    if (to === undefined) return undefined;
    return head === source.id ? id : expandedEntityId(source.id, to) + restOf(id);
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
  const insideStates = (e: EntityDef): Record<KokoStateId, KokoStateValues> => {
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
        return to;
      }) as FieldValue;
    }
    return states;
  };
  const prefabId = options.ids?.prefab ?? newId("pf");
  const prefabEntities: PrefabEntityDef[] = moving.map(({ def }) => {
    const states = insideStates(def);
    if (def.id !== source.id)
      return {
        id: inside.get(def.id) as EntityId,
        name: def.name,
        parent: inside.get(def.parent ?? "") ?? rootId,
        order: def.order,
        states,
        prefab: prefabId,
        ...(def.instanceOf ? { instanceOf: structuredClone(def.instanceOf) } : {}),
      };
    // いちばん上の Entity：向きと大きさは写す（あとで置くインスタンスが、同じ見た目になる）。場所は原点
    const transform = states[BUILTIN.Transform];
    if (transform) states[BUILTIN.Transform] = { ...transform, position: [0, 0, 0] };
    return { id: rootId, name: def.name, parent: null, order: 0, states, prefab: prefabId };
  });

  // 選んだ Entity は、Transform だけを持つインスタンスになる（ほかの KokoState は、プレハブのものが出る）
  const transform = source.states[BUILTIN.Transform];
  const instance: EntityDef = {
    ...source,
    states: transform ? { [BUILTIN.Transform]: structuredClone(transform) } : {},
    instanceOf: { prefab: prefabId },
  };

  // プレハブに移さない Entity（アウトプットのものと、ほかのプレハブの中のもの）から、中の Entity への参照
  const rewrites: RefRewrite[] = [];
  const others: { e: EntityBase; owner: PrefabOwner }[] = [
    ...snap.entities
      .filter((e) => !inside.has(e.id))
      .map((e) => ({ e, owner: { kind: "output" as const, id: e.output } })),
    ...(snap.prefabEntities ?? []).map((e) => ({
      e,
      owner: { kind: "prefab" as const, id: e.prefab },
    })),
  ];
  for (const { e, owner } of others)
    for (const r of refFields(e.states)) {
      const values = e.states[r.def.id];
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
        });
    }

  // 「維持」の印：プレハブに移した Entity を指すものは、プレハブに移す（あとで置くインスタンスにも効く）。
  // 選んだ Entity の Transform の印だけは、アウトプットに残す（Transform は、インスタンスそのものが持つ）
  const keepMoved: PrefabFromEntityPlan["keepMoved"] = [];
  const outputKeep: KeepMark[] = [];
  for (const k of output.keep) {
    const to = insideId(k.entity);
    if (to === undefined || (k.entity === source.id && k.koko === BUILTIN.Transform)) {
      outputKeep.push(k);
      continue;
    }
    keepMoved.push({
      from: k,
      to: { ...k, entity: to },
      entityName: nameOf.get(headOf(k.entity)) ?? k.entity,
    });
  }

  // プレハブにも入れる System：アウトプットの並びと「入・切」のまま
  const wanted = new Set(options.systems ?? []);
  const systems: OutputSystem[] = output.systems
    .filter((s) => wanted.has(s.id))
    .map((s) => ({ id: s.id, enabled: s.enabled }));

  const moved: MovedEntity[] = moving.map(({ def, depth }) => ({
    from: def.id,
    to: inside.get(def.id) as EntityId,
    expanded: expandedId(def.id) as EntityId,
    name: def.name,
    depth,
  }));

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
      output: source.output,
      prefab: {
        id: prefabId,
        name: options.name ?? source.name,
        root: rootId,
        systems,
        keep: keepMoved.map((k) => k.to),
      },
      prefabEntities,
      instance,
      moved,
      rewrites,
      keepMoved,
      outputKeep,
      outsideRefs,
      scriptMentions,
    },
  };
}
