import type { FieldDef, FieldValue, KokoStateDef, KokoStateId, KokoStateValues } from "./types";

const key = (scope: string, name: string) => `${scope}\u0000${name}`;

/**
 * KokoState 定義の登録簿。利用者定義と Built-in を同じ仕組みで扱う。
 *
 * 名前は「スコープ」の中で一意。セッションでは別々のリポジトリの KokoState が同じ名前を持ちうるので、
 * リポジトリごとにスコープを分ける。スコープ ""（既定）は全体で、Built-in はここに置き、どのスコープからも見える。
 */
export class KokoStateRegistry {
  private readonly defs = new Map<KokoStateId, KokoStateDef>();
  private readonly scopes = new Map<KokoStateId, string>();
  private readonly byName = new Map<string, KokoStateId>();

  register(def: KokoStateDef, scope = ""): void {
    const k = key(scope, def.name);
    const existing = this.byName.get(k);
    if (existing !== undefined && existing !== def.id) {
      throw new Error(`KokoState name "${def.name}" is already used by ${existing}`);
    }
    this.unregister(def.id);
    this.defs.set(def.id, def);
    this.scopes.set(def.id, scope);
    this.byName.set(k, def.id);
  }

  unregister(id: KokoStateId): void {
    const def = this.defs.get(id);
    if (!def) return;
    this.byName.delete(key(this.scopes.get(id) ?? "", def.name));
    this.defs.delete(id);
    this.scopes.delete(id);
  }

  get(id: KokoStateId): KokoStateDef | undefined {
    return this.defs.get(id);
  }

  require(id: KokoStateId): KokoStateDef {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Unknown KokoState: ${id}`);
    return def;
  }

  /** 名前から ID を引く。スコープを指定したら、まずそのスコープ、なければ全体（Built-in など）を探す。 */
  idOf(name: string, scope = ""): KokoStateId | undefined {
    return (
      this.byName.get(key(scope, name)) ?? (scope ? this.byName.get(key("", name)) : undefined)
    );
  }

  scopeOf(id: KokoStateId): string | undefined {
    return this.scopes.get(id);
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
