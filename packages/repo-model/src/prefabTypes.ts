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
    if (!sameType(t.type, c.type)) return false;
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
