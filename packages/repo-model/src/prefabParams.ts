import type { KokoStateDef, KokoStateId, KokoStateValues } from "@tukurium/eks";
import { BUILTIN } from "./builtins";
import { expandPrefabForEdit } from "./prefab";
import { inheritedParamCollisions, prefabTypeInfo } from "./prefabTypes";
import type { EntityBase, PrefabDef, PrefabParam, ProjectSnapshot } from "./schema";

/**
 * プレハブのパラメータ（ADR 0082）：プレハブが外から受け取る値。プレハブの中のフィールドを一つずつ指す。
 * 制作データに置いたインスタンスでは、値は今の上書き（prefabOverrides）そのもの。
 */

/** パラメータを、並び順で返す（ID も添える） */
export function prefabParamList(
  prefab: Pick<PrefabDef, "params">,
): (PrefabParam & { id: string })[] {
  return Object.entries(prefab.params ?? {})
    .map(([id, p]) => ({ ...p, id }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * いちばん上の Entity の Transform を指すパラメータか。インスタンスの場所・向き・大きさは、上書きではなく
 * インスタンスそのものが持つ（ADR 0076）ので、このパラメータは、インスタンスの Transform に結び付ける。
 */
export function isRootTransformParam(p: Pick<PrefabParam, "entity" | "koko">): boolean {
  return p.entity === "" && p.koko === BUILTIN.Transform;
}

/** パラメータが指すフィールドの、いまの様子 */
export interface PrefabParamTarget {
  /** プレハブを開いたときの Entity の ID（いちばん上は、プレハブの root） */
  entityId: string;
  entityName: string;
  koko: KokoStateDef;
  field: KokoStateDef["fields"][number];
  /** プレハブの値 */
  value: unknown;
}

/** パラメータの Entity（ルートからの ID）を、プレハブを開いたときの Entity の ID にする */
export function paramEntityId(prefab: Pick<PrefabDef, "root">, entity: string): string {
  return entity === "" ? prefab.root : entity;
}

/** プレハブを開いたときの Entity の ID を、パラメータの Entity（ルートからの ID）にする */
export function paramEntityPath(prefab: Pick<PrefabDef, "root">, entityId: string): string {
  return entityId === prefab.root ? "" : entityId;
}

/**
 * プレハブのパラメータが指すフィールドを引く関数を作る。指す Entity・KokoState・フィールドのどれかが
 * なければ undefined。入れ子のプレハブの中の Entity（「その Entity の ID / 中の ID」）も指せる。
 */
export function prefabParamResolver(
  snap: ProjectSnapshot,
  defs: ReadonlyMap<KokoStateId, KokoStateDef>,
  prefabId: string,
): (p: Pick<PrefabParam, "entity" | "koko" | "field">) => PrefabParamTarget | undefined {
  const prefab = snap.prefabs?.find((x) => x.id === prefabId);
  const entities = new Map(
    (prefab ? (expandPrefabForEdit(snap, prefabId)?.entities ?? []) : []).map((e) => [e.id, e]),
  );
  return (p) => {
    if (!prefab) return undefined;
    const entity = entities.get(paramEntityId(prefab, p.entity));
    const koko = defs.get(p.koko);
    const field = koko?.fields.find((f) => f.id === p.field);
    const values = entity?.states[p.koko];
    if (!entity || !koko || !field || !values) return undefined;
    return { entityId: entity.id, entityName: entity.name, koko, field, value: values[field.id] };
  };
}

/** インスタンスが、そのパラメータのフィールドに、上書きで値を決めているか */
export function instanceSetsParam(
  instance: Pick<EntityBase, "states" | "prefabOverrides">,
  p: Pick<PrefabParam, "entity" | "koko" | "field">,
): boolean {
  const has = (values: KokoStateValues | undefined) =>
    values !== undefined && Object.hasOwn(values, p.field);
  const patch = instance.prefabOverrides?.[p.entity];
  if (has(patch?.states?.[p.koko])) return true;
  // いちばん上の Entity のフィールドは、インスタンスの Entity が、そのまま持つこともある（ADR 0076）
  return p.entity === "" && has(instance.states[p.koko]);
}

export type PrefabParamProblem =
  /** パラメータが指す Entity・KokoState・フィールドがない */
  | { kind: "target-missing"; prefab: string; param: string; name: string }
  /** 一つのプレハブの中で、パラメータの名前が重なっている */
  | { kind: "name-collision"; prefab: string; params: string[]; name: string }
  /** 名前が、スクリプトで書けない（空・前後の空白） */
  | { kind: "name-invalid"; prefab: string; param: string; name: string }
  /** 置いたインスタンスが、必須のパラメータの値を決めていない */
  | {
      kind: "required-missing";
      /** インスタンスを持つもの（アウトプットの Entity か、プレハブの中の Entity） */
      owner: { kind: "output"; entity: string } | { kind: "prefab"; id: string; entity: string };
      entityName: string;
      prefab: string;
      param: string;
      name: string;
    };

/**
 * パラメータの問題を集める（ADR 0082）。
 * - 必須の問題は、いちばん上の Entity の Transform を指すパラメータには出さない（置いたインスタンスは、
 *   いつも Transform を持つ）。
 * - プレハブのいちばん上の Entity（バリアントの元のインスタンス）には出さない。バリアントは、必須の
 *   パラメータを受け継ぎ、必須のままにするため。
 * - プレハブの中に置いたインスタンスは、外側のプレハブの必須のパラメータが、そのフィールドを指していれば、
 *   埋まったものとする（省略できるパラメータでは、渡さなければプレハブの値になるので、埋まらない）。
 */
export function prefabParamProblems(
  snap: ProjectSnapshot,
  defs: ReadonlyMap<KokoStateId, KokoStateDef>,
): PrefabParamProblem[] {
  const out: PrefabParamProblem[] = [];
  const prefabs = new Map((snap.prefabs ?? []).map((p) => [p.id, p]));
  for (const prefab of prefabs.values()) {
    const list = prefabParamList(prefab);
    if (list.length === 0) continue;
    const resolve = prefabParamResolver(snap, defs, prefab.id);
    const byName = new Map<string, string[]>();
    for (const p of list) {
      if (!resolve(p))
        out.push({ kind: "target-missing", prefab: prefab.id, param: p.id, name: p.name });
      if (p.name.trim() === "" || p.name !== p.name.trim())
        out.push({ kind: "name-invalid", prefab: prefab.id, param: p.id, name: p.name });
      byName.set(p.name, [...(byName.get(p.name) ?? []), p.id]);
    }
    for (const [name, params] of byName)
      if (params.length > 1) out.push({ kind: "name-collision", prefab: prefab.id, params, name });
    // バリアントで足すパラメータも、元のプレハブのパラメータと同じ名前にはできない
    const info = prefabTypeInfo(snap, defs, prefab.id);
    for (const name of info ? inheritedParamCollisions(info) : [])
      if ((byName.get(name)?.length ?? 0) === 1)
        out.push({
          kind: "name-collision",
          prefab: prefab.id,
          params: byName.get(name) ?? [],
          name,
        });
  }

  const required = (prefabId: string) =>
    prefabParamList(prefabs.get(prefabId) ?? {}).filter(
      (p) => p.required && !isRootTransformParam(p),
    );
  for (const e of snap.entities) {
    if (!e.instanceOf) continue;
    for (const p of required(e.instanceOf.prefab))
      if (!instanceSetsParam(e, p))
        out.push({
          kind: "required-missing",
          owner: { kind: "output", entity: e.id },
          entityName: e.name,
          prefab: e.instanceOf.prefab,
          param: p.id,
          name: p.name,
        });
  }
  for (const e of snap.prefabEntities ?? []) {
    const outer = prefabs.get(e.prefab);
    // いちばん上の Entity が持つインスタンスの印（バリアント）には、出さない
    if (!e.instanceOf || !outer || e.id === outer.root) continue;
    const outerRequired = prefabParamList(outer).filter((p) => p.required);
    for (const p of required(e.instanceOf.prefab)) {
      if (instanceSetsParam(e, p)) continue;
      // 外側のパラメータは、入れ子の中の Entity を「その Entity の ID / 中の ID」で指す（いちばん上は、その Entity の ID）
      const path = p.entity === "" ? e.id : `${e.id}/${p.entity}`;
      if (outerRequired.some((o) => o.entity === path && o.koko === p.koko && o.field === p.field))
        continue;
      out.push({
        kind: "required-missing",
        owner: { kind: "prefab", id: e.prefab, entity: e.id },
        entityName: e.name,
        prefab: e.instanceOf.prefab,
        param: p.id,
        name: p.name,
      });
    }
  }
  return out;
}

/** 新しいパラメータの名前：フィールドの名前を元に、重なるなら数字を付ける */
export function newParamName(prefab: Pick<PrefabDef, "params">, base: string): string {
  const used = new Set(Object.values(prefab.params ?? {}).map((p) => p.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

/** 消そうとしているもの（パラメータが指す先がなくならないかを確かめる） */
export type ParamTargetRemoval =
  | { kind: "kokostate"; koko: KokoStateId }
  | { kind: "field"; koko: KokoStateId; field: string }
  /** プレハブの中の Entity から、KokoState を外す。entity は、プレハブを開いたときの Entity の ID */
  | { kind: "state"; prefab: string; entity: string; koko: KokoStateId }
  /** プレハブの中の Entity を消す（中の Entity も一緒に消える） */
  | { kind: "entity"; prefab: string; entity: string };

/** それを消すと、指す先がなくなるパラメータ（プレハブを編集していて消すときの確認に使う。ADR 0082） */
export function paramsBrokenBy(
  snap: ProjectSnapshot,
  removal: ParamTargetRemoval,
): { prefab: PrefabDef; param: PrefabParam & { id: string } }[] {
  const out: { prefab: PrefabDef; param: PrefabParam & { id: string } }[] = [];
  for (const prefab of snap.prefabs ?? []) {
    if ("prefab" in removal && removal.prefab !== prefab.id) continue;
    // 消える Entity（自分と、その下）。入れ子の中は「その Entity の ID / 中の ID」で指している
    const gone = new Set<string>();
    if (removal.kind === "entity") {
      const own = (snap.prefabEntities ?? []).filter((e) => e.prefab === prefab.id);
      const add = (id: string) => {
        if (gone.has(id)) return;
        gone.add(id);
        for (const e of own) if (e.parent === id) add(e.id);
      };
      add(removal.entity);
    }
    for (const param of prefabParamList(prefab)) {
      const entityId = paramEntityId(prefab, param.entity);
      const hit =
        removal.kind === "kokostate"
          ? param.koko === removal.koko
          : removal.kind === "field"
            ? param.koko === removal.koko && param.field === removal.field
            : removal.kind === "state"
              ? entityId === removal.entity && param.koko === removal.koko
              : gone.has(entityId.split("/")[0] ?? entityId);
      if (hit) out.push({ prefab, param });
    }
  }
  return out;
}

/** 消すときの確認に足す文。指す先がなくなるパラメータがなければ、空文字 */
export function paramsBrokenNote(snap: ProjectSnapshot, removal: ParamTargetRemoval): string {
  const broken = paramsBrokenBy(snap, removal);
  if (broken.length === 0) return "";
  const names = broken.map((b) => `プレハブ「${b.prefab.name}」の「${b.param.name}」`);
  return `\n\nこれを指しているパラメータがあります：${names.join("、")}。消すと、そのパラメータは問題（エラー）になります。`;
}
