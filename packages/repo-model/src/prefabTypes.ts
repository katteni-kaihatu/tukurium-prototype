import type { KokoStateDef, KokoStateId } from "@tukurium/eks";
import { prefabParamList } from "./prefabParams";
import type { ProjectSnapshot } from "./schema";

/**
 * プレハブ型・インスタンス型の中身（ADR 0082）。TypeScript の宣言を作る所（typecheck）と、
 * 「このプレハブは、このプレハブ型に当てはまるか」を決める所（Inspector の候補・値の確かめ・実行中の確かめ）が、
 * 同じものを使う。
 */

/** プレハブ型のパラメータ（元のプレハブから受け継いだものも含む） */
export interface PrefabTypeParam {
  name: string;
  required: boolean;
  /** 指すフィールドの型の文。指す先がなければ null */
  type: string | null;
  description?: string;
  /** 指す Entity。ルートからの ID（いちばん上の Entity は空文字） */
  entity: string;
  koko: KokoStateId;
  /** フィールドの ID */
  field: string;
  /** フィールドの名前（指す先がなければ null） */
  fieldName: string | null;
  /** このパラメータを決めたプレハブ（受け継いだものは、元のプレハブ） */
  owner: string;
}

export interface PrefabTypeInfo {
  id: string;
  name: string;
  /**
   * 自分と、たどれるすべての元のプレハブの ID（自分が先頭）。型の印になる：バリアントは元の ID も持つので
   * 元の型に当てはまり、同じ構造の別のプレハブは ID が違うので当てはまらない
   */
  chain: string[];
  params: PrefabTypeParam[];
}

/**
 * 元のプレハブ：いちばん上の Entity が、別のプレハブのインスタンスになっているとき、そのプレハブ（バリアント）。
 * 輪になっていたら、そこで止める。
 */
export function prefabChain(snap: ProjectSnapshot, id: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = id;
  while (current !== undefined && !chain.includes(current)) {
    const prefab = snap.prefabs?.find((p) => p.id === current);
    if (!prefab) break;
    chain.push(prefab.id);
    const root = snap.prefabEntities?.find((e) => e.id === prefab.root && e.prefab === prefab.id);
    current = root?.instanceOf?.prefab;
  }
  return chain;
}

/**
 * プレハブ型の中身を求める。パラメータは、元のプレハブのものを先に並べ、そのあとに自分のものを足す
 * （バリアントは、元のパラメータを受け継ぐ）。プレハブがなければ undefined。
 */
export function prefabTypeInfo(
  snap: ProjectSnapshot,
  defs: ReadonlyMap<KokoStateId, Pick<KokoStateDef, "fields">>,
  id: string,
): PrefabTypeInfo | undefined {
  const self = snap.prefabs?.find((p) => p.id === id);
  if (!self) return undefined;
  const chain = prefabChain(snap, id);
  const params: PrefabTypeParam[] = [];
  // 元のプレハブから順に（いちばん遠い元が先）
  for (const owner of [...chain].reverse()) {
    const prefab = snap.prefabs?.find((p) => p.id === owner);
    for (const p of prefab ? prefabParamList(prefab) : []) {
      const field = defs.get(p.koko)?.fields.find((f) => f.id === p.field);
      params.push({
        name: p.name,
        required: p.required,
        type: field?.type ?? null,
        ...(p.description ? { description: p.description } : {}),
        entity: p.entity,
        koko: p.koko,
        field: p.field,
        fieldName: field?.name ?? null,
        owner,
      });
    }
  }
  return { id, name: self.name, chain, params };
}

const sameType = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

/**
 * candidate のプレハブが、type のプレハブ型に当てはまるか（TypeScript の型の決まりと同じ判定）。
 * - type のプレハブそのものか、そのバリアント（元をたどると type に行き着く）であること。
 * - type のプレハブ型として作る人が渡す値で、candidate を作れること：candidate が必須にしているパラメータは、
 *   type でも必須で、型が同じ。type にないパラメータは、candidate で省略できること。type にもあるパラメータは、型が同じ。
 */
export function prefabFitsType(candidate: PrefabTypeInfo, type: PrefabTypeInfo): boolean {
  if (!candidate.chain.includes(type.id)) return false;
  for (const c of candidate.params) {
    const t = type.params.find((p) => p.name === c.name);
    if (!t) {
      if (c.required) return false;
      continue;
    }
    // 同じフィールドを指すパラメータ（元から受け継いだもの）は、型も同じ。別のフィールドなら、型の文を比べる
    if (!(t.koko === c.koko && t.field === c.field) && !sameType(t.type, c.type)) return false;
    if (c.required && !t.required) return false;
  }
  return true;
}

/** インスタンス型：candidate のプレハブのインスタンスが、type のプレハブのインスタンス型に当てはまるか（印だけで決まる） */
export function prefabInstanceFitsType(candidate: PrefabTypeInfo, type: PrefabTypeInfo): boolean {
  return candidate.chain.includes(type.id);
}

/**
 * バリアントで足したパラメータの名前が、元のプレハブのパラメータと重なっているもの（ADR 0082）。
 * 返すのは、重なっている名前（自分で足したパラメータの側）。
 */
export function inheritedParamCollisions(info: PrefabTypeInfo): string[] {
  const inherited = new Set(info.params.filter((p) => p.owner !== info.id).map((p) => p.name));
  return [
    ...new Set(
      info.params.filter((p) => p.owner === info.id && inherited.has(p.name)).map((p) => p.name),
    ),
  ];
}

/**
 * アウトプットから、依存でたどれるプレハブ（ADR 0082）。実行中に `Prefab.spawn` で作れるのは、これだけ
 * （セッションの境界。型を外して ID の文字を渡しても、ここにないプレハブは作れない）。
 * たどり方：アウトプットの System と、置いたインスタンスのプレハブから始め、プレハブの System・
 * プレハブの中に置いた別のプレハブ（入れ子と、バリアントの元）・System が import するプレハブを、先までたどる。
 * 輪になっていても、一度通ったものは飛ばす。
 *
 * - `placed`：アウトプットに置いたインスタンスのプレハブ（展開したあとの制作データでは、Entity の origin から集める）と、
 *   アウトプットの Entity が、フィールドの値で指しているプレハブ
 * - `importsOf`：System が import しているプレハブの ID（スクリプトを読んで求める）
 */
export function reachablePrefabs(
  snap: ProjectSnapshot,
  outputId: string,
  placed: Iterable<string>,
  importsOf: (systemId: string) => Iterable<string>,
  /** プレハブの中の Entity が、フィールドの値（プレハブ型のフィールド）で指しているプレハブ */
  valuesIn: (prefabId: string) => Iterable<string> = () => [],
): Set<string> {
  const prefabs = new Map((snap.prefabs ?? []).map((p) => [p.id, p]));
  const out = new Set<string>();
  const seenSystems = new Set<string>();
  const queue: string[] = [...placed];
  const visitSystem = (id: string) => {
    if (seenSystems.has(id)) return;
    seenSystems.add(id);
    for (const p of importsOf(id)) queue.push(p);
  };
  for (const s of snap.outputs.find((o) => o.id === outputId)?.systems ?? []) visitSystem(s.id);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    const prefab = prefabs.get(id);
    if (!prefab || out.has(id)) continue;
    out.add(id);
    for (const s of prefab.systems) visitSystem(s.id);
    for (const p of valuesIn(id)) queue.push(p);
    for (const e of snap.prefabEntities ?? [])
      if (e.prefab === id && e.instanceOf) queue.push(e.instanceOf.prefab);
  }
  return out;
}

/**
 * KokoState が import するプレハブの、初めの名前（ADR 0082）。プレハブの名前を、型の文で書ける形にして使う。
 * 同じ名前の KokoState（プロジェクトのどれも、型の文から名前で指せる）や、ほかの import と重なるなら、
 * 後ろに `Prefab` を付け、それも重なるなら数字を付ける。KokoState「Bullet」とプレハブ「Bullet」のような、
 * いちばんよくある形で、足したとたんに問題が出ないようにする。
 */
export function newPrefabImportName(
  kokoNames: Iterable<string>,
  imports: readonly { name: string }[] | undefined,
  prefabName: string,
): string {
  const used = new Set([...kokoNames, ...(imports ?? []).map((i) => i.name)]);
  const cleaned = prefabName.replace(/[^\w$]/g, "");
  const base = /^[A-Za-z_$]/.test(cleaned) ? cleaned : "Prefab";
  if (!used.has(base)) return base;
  const withSuffix = base.endsWith("Prefab") ? base : `${base}Prefab`;
  if (!used.has(withSuffix)) return withSuffix;
  for (let i = 2; ; i++) if (!used.has(`${withSuffix}${i}`)) return `${withSuffix}${i}`;
}
