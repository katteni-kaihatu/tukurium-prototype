import {
  decodeValue,
  encodeValue,
  type FieldDef,
  type FieldValue,
  type Json,
  type KokoStateDef,
  type KokoStateId,
  type KokoStateValues,
} from "@tukurium/eks";
import type { PrefabEntityOverride } from "./schema";

export type StoredPrefabOverrides = Record<
  string,
  Omit<PrefabEntityOverride, "states" | "addedStates"> & {
    states?: Record<string, StoredValues>;
    addedStates?: Record<string, StoredValues>;
  }
>;

export function encodePrefabOverrides(
  overrides: Record<string, PrefabEntityOverride>,
): StoredPrefabOverrides {
  return Object.fromEntries(
    Object.entries(overrides).map(([path, value]) => {
      const { states, addedStates, ...rest } = value;
      return [
        path,
        {
          ...rest,
          ...(states ? { states: encodeStates(states) } : {}),
          ...(addedStates ? { addedStates: encodeStates(addedStates) } : {}),
        },
      ];
    }),
  );
}

export function decodePrefabOverrides(
  overrides: StoredPrefabOverrides,
): Record<string, PrefabEntityOverride> {
  return Object.fromEntries(
    Object.entries(overrides).map(([path, value]) => [
      path,
      {
        ...value,
        ...(value.states ? { states: decodeStates(value.states) } : {}),
        ...(value.addedStates ? { addedStates: decodeStates(value.addedStates) } : {}),
      },
    ]),
  );
}

/**
 * 制作データの中の「値」（Entity のフィールドの値と、フィールドの初期値）を、保存する形
 * （タグ付きの JSON。ADR 0065）に書き出す・戻す。Git のファイルと Yjs で同じ形を使う。
 * 値のほか（名前・ID・並びなど）はふつうの JSON のままなので、値の所だけを変える。
 */

/** 保存する形の KokoState の値（フィールド ID → タグ付きの JSON） */
export type StoredValues = Record<string, Json>;

/** 保存する形の KokoState の定義（初期値がタグ付きの JSON） */
export type StoredKokoState = Omit<KokoStateDef, "fields"> & {
  fields: (Omit<FieldDef, "default"> & { default: Json })[];
};

export function encodeValues(values: KokoStateValues): StoredValues {
  const out: StoredValues = {};
  for (const [field, value] of Object.entries(values)) out[field] = encodeValue(value);
  return out;
}

export function decodeValues(stored: StoredValues): KokoStateValues {
  const out: KokoStateValues = {};
  for (const [field, value] of Object.entries(stored ?? {}))
    out[field] = decodeValue(value) as FieldValue;
  return out;
}

export function encodeStates(
  states: Record<KokoStateId, KokoStateValues>,
): Record<KokoStateId, StoredValues> {
  const out: Record<KokoStateId, StoredValues> = {};
  for (const [koko, values] of Object.entries(states)) out[koko] = encodeValues(values);
  return out;
}

export function decodeStates(
  stored: Record<KokoStateId, StoredValues>,
): Record<KokoStateId, KokoStateValues> {
  const out: Record<KokoStateId, KokoStateValues> = {};
  for (const [koko, values] of Object.entries(stored ?? {})) out[koko] = decodeValues(values);
  return out;
}

export function encodeKokoState(def: KokoStateDef): StoredKokoState {
  const { fields, ...rest } = def;
  return {
    ...structuredClone(rest),
    fields: fields.map((f) => ({ ...f, default: encodeValue(f.default) })),
  };
}

export function decodeKokoState(stored: StoredKokoState): KokoStateDef {
  const { fields, ...rest } = stored;
  return {
    ...structuredClone(rest),
    fields: (fields ?? []).map((f) => ({ ...f, default: decodeValue(f.default) }) as FieldDef),
  };
}
