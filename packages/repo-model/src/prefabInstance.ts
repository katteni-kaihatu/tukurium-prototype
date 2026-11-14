import {
  type FieldSchemas,
  type FieldValue,
  hasRefs,
  type KokoStateDef,
  type KokoStateValues,
  mapRefs,
  schemaOfField,
  stringifyValue,
} from "@tukurium/eks";
import { BUILTIN, BUILTIN_KOKOSTATES } from "./builtins";
import { isPackageResourceId } from "./packageDependency";
import { expandPrefabForEdit, expandPrefabs, type PrefabOwner, prefabProblems } from "./prefab";
import {
  type EntityBase,
  type EntityDef,
  type KeepMark,
  newId,
  type OutputSystem,
  type PrefabEntityDef,
  type PrefabEntityOverride,
  type ProjectSnapshot,
} from "./schema";

export interface PrefabInstanceOptions {
  schemas?: FieldSchemas;
  kokostates?: readonly KokoStateDef[];
  /** 確認中に計画を作り直しても、同じ Entity に同じ ID を使う。 */
  ids?: Readonly<Record<string, string>>;
}

/** 確認画面と実行が同じ計画を使う。before/after は実行時のフィールド単位の差分にも使う。 */
export interface PrefabInstancePlan {
  entity: string;
  prefab: string;
  prefabName: string;
  owner: PrefabOwner;
  changes: { entity: string; name: string; kind: string; detail: string }[];
  moved: { from: string; to: string; expanded: string; name: string }[];
  rewrites: {
    entity: string;
    entityName: string;
    koko: string;
    field: string;
    targets: { from: string; to: string }[];
  }[];
  keepMoved: { from: KeepMark; to: KeepMark }[];
  warnings: string[];
  ids: Record<string, string>;
  before: ProjectSnapshot;
  after: ProjectSnapshot;
}
export type PrefabInstanceResult =
  | { ok: true; plan: PrefabInstancePlan }
  | { ok: false; reason: string };

type States = Record<string, KokoStateValues>;
const copy = <T>(v: T): T => structuredClone(v);
const join = (a: string, b: string) => (b ? `${a}/${b}` : a);
const keepKey = (k: KeepMark) => JSON.stringify([k.entity, k.koko, k.field]);
const mergeKeep = (a: KeepMark[], b: KeepMark[]) => [
  ...new Map([...a, ...b].map((k) => [keepKey(k), k])).values(),
];
function mergeSystems(a: readonly OutputSystem[], b: readonly OutputSystem[]): OutputSystem[] {
  const result = a.map(copy);
  for (const s of b) {
    const old = result.find((x) => x.id === s.id);
    if (old) old.enabled ||= s.enabled;
    else result.push(copy(s));
  }
  return result;
}
function mergeStates(a: States = {}, b: States = {}): States {
  const result = copy(a);
  for (const [k, fields] of Object.entries(b)) result[k] = { ...result[k], ...copy(fields) };
  return result;
}
function mergePatch(a: PrefabEntityOverride = {}, b: PrefabEntityOverride): PrefabEntityOverride {
  return {
    ...a,
    ...b,
    ...(a.states || b.states ? { states: mergeStates(a.states, b.states) } : {}),
    ...(a.addedStates || b.addedStates
      ? { addedStates: mergeStates(a.addedStates, b.addedStates) }
      : {}),
  };
}

/** 完全一致か、入れ子を含む ID の頭だけを置き換える。文字列の途中は変えない。 */
function idMapper(ids: ReadonlyMap<string, string>) {
  const entries = [...ids].sort(([a], [b]) => b.length - a.length);
  return (id: string): string => {
    for (const [from, to] of entries)
      if (id === from || id.startsWith(`${from}/`)) return to + id.slice(from.length);
    return id;
  };
}

/** プレハブ内の ID 変更は、それを使う各インスタンスの道にも届く。 */
function mappingsForOwner(snap: ProjectSnapshot, owner: PrefabOwner, local: Map<string, string>) {
  const all = new Map(local);
  if (owner.kind !== "prefab") return all;
  const instances = [...snap.entities, ...(snap.prefabEntities ?? [])];
  const visit = (prefabId: string, changes: Map<string, string>, stack: Set<string>) => {
    if (stack.has(prefabId)) return;
    const root = snap.prefabs?.find((p) => p.id === prefabId)?.root;
    const nextStack = new Set([...stack, prefabId]);
    for (const instance of instances) {
      if (instance.instanceOf?.prefab !== prefabId) continue;
      if (
        "prefab" in instance &&
        snap.prefabs?.find((p) => p.id === instance.prefab)?.root === instance.id
      )
        continue;
      const at = (id: string) =>
        root && (id === root || id.startsWith(`${root}/`))
          ? instance.id + id.slice(root.length)
          : join(instance.id, id);
      const lifted = new Map([...changes].map(([from, to]) => [at(from), at(to)]));
      for (const [from, to] of lifted) all.set(from, to);
      if ("prefab" in instance) visit(instance.prefab, lifted, nextStack);
    }
  };
  visit(owner.id, local, new Set());
  return all;
}

function refMapper(snap: ProjectSnapshot, options: PrefabInstanceOptions) {
  const defs = new Map(
    [...BUILTIN_KOKOSTATES, ...snap.kokostates, ...(options.kokostates ?? [])].map((k) => [
      k.id,
      k,
    ]),
  );
  return (
    states: States,
    map: (id: string) => string,
    onRef?: (koko: string, field: string, from: string, to: string) => void,
  ): States => {
    const result = copy(states);
    for (const [koko, fields] of Object.entries(result))
      for (const field of defs.get(koko)?.fields ?? []) {
        const schema = schemaOfField(options.schemas, koko, field);
        if (!schema || !hasRefs(schema) || !Object.hasOwn(fields, field.id)) continue;
        fields[field.id] = mapRefs(schema, fields[field.id], (target, id) => {
          if (target !== "entity") return undefined;
          const to = map(id);
          onRef?.(koko, field.id, id, to);
          return to === id ? undefined : to;
        }) as FieldValue;
      }
    return result;
  };
}

function remapEntity(
  e: EntityBase,
  map: (id: string) => string,
  refs: ReturnType<typeof refMapper>,
) {
  e.parent = e.parent === null ? null : map(e.parent);
  e.states = refs(e.states, map);
  if (e.prefabOverrides)
    e.prefabOverrides = Object.fromEntries(
      Object.entries(e.prefabOverrides).map(([path, p]) => [
        path,
        {
          ...p,
          ...(p.parent === undefined ? {} : { parent: p.parent === null ? null : map(p.parent) }),
          ...(p.states ? { states: refs(p.states, map) } : {}),
          ...(p.addedStates ? { addedStates: refs(p.addedStates, map) } : {}),
        },
      ]),
    );
}

/** 入れ子への上書きは、入れ子インスタンスに持たせる。参照先プレハブへは踏み込まない。 */
function patchAt(entities: EntityBase[], root: string, path: string, patch: PrefabEntityOverride) {
  const [head, ...tail] = path.split("/");
  const e = entities.find((x) => x.id === (path ? head : root));
  if (!e) throw new Error(`変更先の Entity がありません: ${path}`);
  if (tail.length) {
    if (!e.instanceOf) throw new Error(`入れ子のインスタンスがありません: ${head}`);
    const key = tail.join("/");
    e.prefabOverrides = {
      ...e.prefabOverrides,
      [key]: mergePatch(e.prefabOverrides?.[key], patch),
    };
    return;
  }
  if (patch.name !== undefined) e.name = patch.name;
  if (patch.parent !== undefined) e.parent = patch.parent;
  if (patch.order !== undefined) e.order = patch.order;
  if (e.instanceOf) {
    // 入れ子のルートは、置き方と追加 KokoState だけを自身に持つ。
    for (const [koko, values] of Object.entries(patch.states ?? {})) {
      if (koko === BUILTIN.Transform) e.states[koko] = { ...e.states[koko], ...copy(values) };
      else
        e.prefabOverrides = {
          ...e.prefabOverrides,
          "": mergePatch(e.prefabOverrides?.[""], { states: { [koko]: values } }),
        };
    }
    e.states = mergeStates(e.states, patch.addedStates);
  } else e.states = mergeStates(mergeStates(e.states, patch.addedStates), patch.states);
}

function prepare(
  snap: ProjectSnapshot,
  id: string,
  options: PrefabInstanceOptions,
  apply: boolean,
) {
  const all: (EntityDef | PrefabEntityDef)[] = [...snap.entities, ...(snap.prefabEntities ?? [])];
  const source = all.find((e) => e.id === id);
  if (!source?.instanceOf) throw new Error("インスタンスのいちばん上の Entity を選んでください");
  if (apply && isPackageResourceId(source.instanceOf.prefab))
    throw new Error("ライブラリのプレハブには適用できません");
  const prefab = snap.prefabs?.find((p) => p.id === source.instanceOf?.prefab);
  const definition = snap.prefabEntities?.filter((e) => e.prefab === prefab?.id) ?? [];
  if (!prefab || !definition.some((e) => e.id === prefab.root))
    throw new Error("プレハブがありません。中身を確かめてから操作してください");
  const owner: PrefabOwner =
    "output" in source
      ? { kind: "output", id: source.output }
      : { kind: "prefab", id: source.prefab };
  if (owner.kind === "output" && snap.outputs.find((o) => o.id === owner.id)?.kind === "library")
    throw new Error("ライブラリの中の Entity は変えられません");
  const view =
    owner.kind === "output"
      ? expandPrefabs(snap, { schemas: options.schemas, kokostates: options.kokostates })
      : expandPrefabForEdit(snap, owner.id, {
          schemas: options.schemas,
          kokostates: options.kokostates,
        });
  if (!view) throw new Error("編集しているプレハブがありません");
  if (
    prefabProblems(snap).some(
      (p) => p.kind === "cycle" && (p.prefab === prefab.id || p.owner.id === prefab.id),
    )
  )
    throw new Error("プレハブが自分を含むため、操作できません");
  const peers = all.filter((e) =>
    owner.kind === "output"
      ? "output" in e && e.output === owner.id
      : "prefab" in e && e.prefab === owner.id,
  );
  const inside = new Set(
    view.entities.filter((e) => e.id === id || e.id.startsWith(`${id}/`)).map((e) => e.id),
  );
  const added: (EntityDef | PrefabEntityDef)[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of peers) {
      if (inside.has(e.id) || e.parent === null) continue;
      const effective = view.entities.find((x) => x.id === e.id);
      if (!inside.has(effective?.parent ?? e.parent)) continue;
      added.push(e);
      for (const x of view.entities)
        if (x.id === e.id || x.id.startsWith(`${e.id}/`)) inside.add(x.id);
      progress = true;
    }
  }
  const after = copy(snap);
  const taken = new Set(all.map((e) => e.id));
  const ids: Record<string, string> = {};
  const fresh = (old: string) => {
    const next = options.ids?.[old] ?? newId("ent");
    if (taken.has(next) || !next || next.includes("/"))
      throw new Error("確認中の新しい ID が使われました。確認を開き直してください");
    taken.add(next);
    ids[old] = next;
    return next;
  };
  const plan: PrefabInstancePlan = {
    entity: id,
    prefab: prefab.id,
    prefabName: prefab.name,
    owner,
    changes: [],
    moved: [],
    rewrites: [],
    keepMoved: [],
    warnings: [],
    ids,
    before: snap,
    after,
  };
  return {
    source,
    prefab,
    definition,
    owner,
    view,
    peers,
    inside,
    added,
    after,
    fresh,
    plan,
    refs: refMapper(snap, options),
  };
}

function finishRefs(
  plan: PrefabInstancePlan,
  map: (id: string) => string,
  refs: ReturnType<typeof refMapper>,
) {
  for (const e of [...plan.after.entities, ...(plan.after.prefabEntities ?? [])]) {
    const targets = new Map<string, { from: string; to: string }[]>();
    const track = (k: string, f: string, from: string, to: string) => {
      if (from === to) return;
      const key = JSON.stringify([k, f]);
      const list = targets.get(key) ?? [];
      if (!list.some((x) => x.from === from)) list.push({ from, to });
      targets.set(key, list);
    };
    const tracked: ReturnType<typeof refMapper> = (states, mapper) => refs(states, mapper, track);
    remapEntity(e, map, tracked);
    if (e.prefabOverrides) {
      const overrides: Record<string, PrefabEntityOverride> = {};
      for (const [path, patch] of Object.entries(e.prefabOverrides)) {
        const target = map(join(e.id, path));
        const nextPath =
          target === e.id
            ? ""
            : target.startsWith(`${e.id}/`)
              ? target.slice(e.id.length + 1)
              : path;
        overrides[nextPath] = mergePatch(overrides[nextPath], patch);
      }
      e.prefabOverrides = overrides;
    }
    for (const [key, values] of targets) {
      const [koko, field] = JSON.parse(key) as [string, string];
      plan.rewrites.push({ entity: e.id, entityName: e.name, koko, field, targets: values });
    }
  }
  for (const o of plan.after.outputs)
    o.keep = mergeKeep(
      [],
      o.keep.map((k) => ({ ...k, entity: map(k.entity) })),
    );
  for (const p of plan.after.prefabs ?? [])
    p.keep = mergeKeep(
      [],
      p.keep.map((k) => ({ ...k, entity: map(k.entity) })),
    );
  for (const system of plan.before.systems) {
    const changed = plan.moved.filter((m) => system.code.includes(m.from));
    if (changed.length)
      plan.warnings.push(
        `System「${system.name}」に ID が変わる Entity（${changed.map((m) => m.name).join("、")}）の ID が書かれています。スクリプトは書き換えません。`,
      );
  }
}

export function planApplyPrefabInstance(
  snap: ProjectSnapshot,
  id: string,
  options: PrefabInstanceOptions = {},
): PrefabInstanceResult {
  try {
    const { source, prefab, owner, view, inside, added, after, fresh, plan, refs } = prepare(
      snap,
      id,
      options,
      true,
    );
    const mappings = new Map<string, string>([[id, prefab.root]]);
    for (const e of view.entities)
      if (e.id.startsWith(`${id}/`)) mappings.set(e.id, e.id.slice(id.length + 1));
    for (const e of added) {
      const to = fresh(e.id);
      mappings.set(e.id, to);
      plan.moved.push({ from: e.id, to, expanded: join(id, to), name: e.name });
    }
    const toPrefab = idMapper(mappings);
    const outside = new Set<string>();
    const insideRefs = (states: States) =>
      refs(states, toPrefab, (_koko, _field, from, to) => {
        if (from === to && !inside.has(from)) outside.add(from);
      });
    const targets = after.prefabEntities?.filter((e) => e.prefab === prefab.id) ?? [];
    const changed = Object.entries(source.prefabOverrides ?? {});
    for (const [path, patch] of changed) {
      const eid = join(id, path);
      if (!view.entities.some((e) => e.id === eid))
        throw new Error(`変更先の Entity がプレハブにありません: ${path}`);
      if (patch.parent !== undefined) {
        const effective = view.entities.find((e) => e.id === eid);
        const parent = effective?.parent;
        if (parent !== null && parent !== undefined && !inside.has(parent))
          throw new Error(
            `「${effective?.name ?? path}」の親がインスタンスの外にあります。中の Entity に付け替えてから適用してください`,
          );
      }
      const mapped = copy(patch);
      if (mapped.parent !== undefined)
        mapped.parent =
          mapped.parent === null
            ? prefab.root
            : toPrefab(view.entities.find((e) => e.id === eid)?.parent ?? mapped.parent);
      if (mapped.states) mapped.states = insideRefs(mapped.states);
      if (mapped.addedStates) mapped.addedStates = insideRefs(mapped.addedStates);
      if (!path) {
        delete mapped.name;
        delete mapped.parent;
        delete mapped.order;
        if (mapped.states) delete mapped.states[BUILTIN.Transform];
        if (mapped.addedStates) delete mapped.addedStates[BUILTIN.Transform];
      }
      patchAt(targets, prefab.root, path, mapped);
      const name = view.entities.find((e) => e.id === eid)?.name ?? path;
      for (const key of ["name", "parent", "order"] as const)
        if (mapped[key] !== undefined) {
          const label = { name: "名前", parent: "親", order: "並び順" }[key];
          plan.changes.push({
            entity: eid,
            name,
            kind: key,
            detail: `${label}: ${stringifyValue(mapped[key])}`,
          });
        }
      for (const group of ["states", "addedStates"] as const)
        for (const [koko, fields] of Object.entries(mapped[group] ?? {})) {
          const def = [
            ...BUILTIN_KOKOSTATES,
            ...snap.kokostates,
            ...(options.kokostates ?? []),
          ].find((k) => k.id === koko);
          if (group === "addedStates")
            plan.changes.push({
              entity: eid,
              name,
              kind: `state:${koko}`,
              detail: `追加した KokoState: ${def?.name ?? koko}`,
            });
          for (const [field, value] of Object.entries(fields))
            plan.changes.push({
              entity: eid,
              name,
              kind: `${koko}:${field}`,
              detail: `${def?.name ?? koko}.${def?.fields.find((f) => f.id === field)?.name ?? field}: ${stringifyValue(value)}`,
            });
        }
    }
    const root = targets.find((e) => e.id === prefab.root);
    if (!root) throw new Error("プレハブのいちばん上の Entity がありません");
    const additions = copy(source.states);
    delete additions[BUILTIN.Transform];
    root.states = mergeStates(root.states, insideRefs(additions));
    for (const koko of Object.keys(additions))
      plan.changes.push({
        entity: id,
        name: source.name,
        kind: "state",
        detail: `追加した KokoState: ${koko}`,
      });
    for (const e of added) {
      const next = copy(e) as EntityDef & PrefabEntityDef;
      next.id = mappings.get(e.id) as string;
      delete (next as Partial<EntityDef>).output;
      next.prefab = prefab.id;
      remapEntity(next, toPrefab, (states) => insideRefs(states));
      next.parent = toPrefab(view.entities.find((x) => x.id === e.id)?.parent ?? e.parent ?? id);
      after.prefabEntities?.push(next);
      plan.changes.push({ entity: e.id, name: e.name, kind: "entity", detail: "追加した Entity" });
    }
    after.entities = after.entities.filter((e) => !added.some((a) => a.id === e.id));
    after.prefabEntities = after.prefabEntities?.filter(
      (e) => e.prefab === prefab.id || !added.some((a) => a.id === e.id),
    );
    const dest = after.prefabs?.find((p) => p.id === prefab.id);
    if (!dest) throw new Error("プレハブがありません");
    dest.systems = mergeSystems(dest.systems, source.instanceSystems ?? []);
    for (const s of source.instanceSystems ?? [])
      plan.changes.push({
        entity: id,
        name: source.name,
        kind: "system",
        detail: `追加した System: ${s.id}`,
      });
    const own =
      owner.kind === "output"
        ? after.outputs.find((o) => o.id === owner.id)
        : after.prefabs?.find((p) => p.id === owner.id);
    if (own) {
      const keep: KeepMark[] = [];
      for (const k of own.keep) {
        if (!inside.has(k.entity) || (k.entity === id && k.koko === BUILTIN.Transform)) {
          keep.push(k);
          continue;
        }
        const to = { ...k, entity: toPrefab(k.entity) };
        plan.keepMoved.push({ from: copy(k), to });
        dest.keep = mergeKeep(dest.keep, [to]);
      }
      own.keep = keep;
    }
    const self = [...after.entities, ...(after.prefabEntities ?? [])].find((e) => e.id === id);
    if (!self) throw new Error("インスタンスがありません");
    const transform = source.states[BUILTIN.Transform];
    self.states = transform ? { [BUILTIN.Transform]: copy(transform) } : {};
    delete self.prefabOverrides;
    delete self.instanceSystems;
    const external = idMapper(
      mappingsForOwner(snap, owner, new Map(plan.moved.map((m) => [m.from, m.expanded]))),
    );
    finishRefs(plan, external, refs);
    for (const target of outside)
      plan.warnings.push(
        `プレハブの外（${target}）を指す参照は残します。別のアウトプットでは参照先がない場合があります。`,
      );
    if (prefabProblems(after).some((p) => p.kind === "cycle" && p.owner.id === prefab.id))
      throw new Error("適用するとプレハブが自分を含むため、適用できません");
    return { ok: true, plan };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function planUnpackPrefabInstance(
  snap: ProjectSnapshot,
  id: string,
  options: PrefabInstanceOptions = {},
): PrefabInstanceResult {
  try {
    const { source, prefab, definition, owner, view, after, fresh, plan, refs } = prepare(
      snap,
      id,
      options,
      false,
    );
    const mappings = new Map<string, string>([[prefab.root, id]]);
    for (const e of definition) if (e.id !== prefab.root) mappings.set(e.id, fresh(e.id));
    const local = idMapper(mappings);
    const expandedMappings = new Map(
      [...mappings].map(([from, to]) => [from === prefab.root ? id : join(id, from), to]),
    );
    const expanded = idMapper(expandedMappings);
    const nodes: (EntityDef | PrefabEntityDef)[] = definition.map((e) => {
      const next = copy(e) as EntityDef & PrefabEntityDef;
      next.id = mappings.get(e.id) as string;
      if (owner.kind === "output") {
        delete (next as Partial<PrefabEntityDef>).prefab;
        next.output = owner.id;
      } else next.prefab = owner.id;
      remapEntity(next, local, refs);
      return next;
    });
    const self = nodes.find((e) => e.id === id);
    const root = definition.find((e) => e.id === prefab.root);
    const shown = view.entities.find((e) => e.id === id);
    if (!self || !root || !shown) throw new Error("インスタンスの中身がありません");
    Object.assign(self, copy(source), {
      states: refs(shown.states, expanded),
      unpackedSystems: mergeSystems(
        mergeSystems(prefab.systems, root.unpackedSystems ?? []),
        source.unpackedSystems ?? [],
      ),
    });
    if (!self.unpackedSystems?.length) delete self.unpackedSystems;
    delete self.instanceOf;
    delete self.prefabOverrides;
    for (const [path, patch] of Object.entries(source.prefabOverrides ?? {})) {
      if (!path) continue;
      const [head, ...tail] = path.split("/");
      const target = mappings.get(head ?? "");
      if (!target) continue;
      const mapped = copy(patch);
      if (mapped.parent !== undefined)
        mapped.parent = mapped.parent === null ? id : expanded(mapped.parent);
      if (mapped.states) mapped.states = refs(mapped.states, expanded);
      if (mapped.addedStates) mapped.addedStates = refs(mapped.addedStates, expanded);
      patchAt(nodes, id, join(target, tail.join("/")), mapped);
    }
    for (const e of nodes)
      if (e.id !== id) {
        const old = definition.find((d) => mappings.get(d.id) === e.id);
        if (old)
          plan.moved.push({ from: join(id, old.id), to: e.id, expanded: e.id, name: e.name });
      }
    if (owner.kind === "output")
      after.entities = [...after.entities.filter((e) => e.id !== id), ...(nodes as EntityDef[])];
    else
      after.prefabEntities = [
        ...(after.prefabEntities ?? []).filter((e) => e.id !== id),
        ...(nodes as PrefabEntityDef[]),
      ];
    const own =
      owner.kind === "output"
        ? after.outputs.find((o) => o.id === owner.id)
        : after.prefabs?.find((p) => p.id === owner.id);
    if (own)
      for (const k of prefab.keep) {
        const to = { ...k, entity: local(k.entity) };
        plan.keepMoved.push({ from: copy(k), to });
        own.keep = mergeKeep(own.keep, [to]);
      }
    finishRefs(plan, idMapper(mappingsForOwner(snap, owner, expandedMappings)), refs);
    plan.changes.push({
      entity: id,
      name: source.name,
      kind: "unpack",
      detail: "プレハブとのつながりを切る（中のインスタンスは残す）",
    });
    return { ok: true, plan };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
