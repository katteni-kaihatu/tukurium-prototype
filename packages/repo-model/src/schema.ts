import type { EntityId, FieldId, KokoStateDef, KokoStateId, KokoStateValues } from "@tukurium/eks";

export type OutputKind = "item" | "world";

/** 状態維持のマーク：アウトプットごと・フィールド単位（要件 §7） */
export interface KeepMark {
  entity: EntityId;
  koko: KokoStateId;
  field: FieldId;
}

export interface OutputSystem {
  id: string;
  enabled: boolean;
}

export interface OutputDef {
  id: string;
  name: string;
  kind: OutputKind;
  /** このアウトプットで動かす System。並び順が実行順。 */
  systems: OutputSystem[];
  keep: KeepMark[];
}

export interface SystemDef {
  id: string;
  name: string;
}

export interface MaterialDef {
  id: string;
  name: string;
  color: string;
  roughness: number;
  metalness: number;
}

export interface EntityDef {
  id: EntityId;
  name: string;
  parent: EntityId | null;
  output: string;
  /** 兄弟の中での並び順 */
  order: number;
  states: Record<KokoStateId, KokoStateValues>;
}

/** リポジトリ（制作データ）の中身をそのまま JSON にしたもの。 */
export interface ProjectSnapshot {
  version: 1;
  name: string;
  kokostates: KokoStateDef[];
  systems: (SystemDef & { code: string })[];
  materials: MaterialDef[];
  outputs: OutputDef[];
  entities: EntityDef[];
}

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}_${raw.slice(0, 12)}`;
}
