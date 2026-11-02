import type { FieldDef, FieldValue, KokoStateDef, KokoStateId, KokoStateValues } from "./types";

/** KokoState 定義の登録簿。利用者定義と Built-in を同じ仕組みで扱う。 */
export class KokoStateRegistry {
  private readonly defs = new Map<KokoStateId, KokoStateDef>();
  private readonly byName = new Map<string, KokoStateId>();

  register(def: KokoStateDef): void {
    const existing = this.byName.get(def.name);
    if (existing !== undefined && existing !== def.id) {
      throw new Error(`KokoState name "${def.name}" is already used by ${existing}`);
    }
    const prev = this.defs.get(def.id);
    if (prev) this.byName.delete(prev.name);
    this.defs.set(def.id, def);
    this.byName.set(def.name, def.id);
  }

  unregister(id: KokoStateId): void {
    const def = this.defs.get(id);
    if (!def) return;
    this.defs.delete(id);
    this.byName.delete(def.name);
  }

  get(id: KokoStateId): KokoStateDef | undefined {
    return this.defs.get(id);
  }

  require(id: KokoStateId): KokoStateDef {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Unknown KokoState: ${id}`);
    return def;
  }

  idOf(name: string): KokoStateId | undefined {
    return this.byName.get(name);
  }

  all(): KokoStateDef[] {
    return [...this.defs.values()];
  }

  /** 初期値で埋めた値を作る。`partial` に含まれるフィールドはその値を使う。 */
  createValues(id: KokoStateId, partial?: KokoStateValues): KokoStateValues {
    const def = this.require(id);
    const values: KokoStateValues = {};
    for (const field of def.fields) {
      const given = partial?.[field.id];
      values[field.id] = given !== undefined ? cloneValue(given) : cloneValue(field.default);
    }
    return values;
  }

  fieldByName(id: KokoStateId, name: string): FieldDef | undefined {
    return this.require(id).fields.find((f) => f.name === name);
  }
}

export function cloneValue<T extends FieldValue>(value: T): T {
  return (Array.isArray(value) ? [...value] : value) as T;
}
