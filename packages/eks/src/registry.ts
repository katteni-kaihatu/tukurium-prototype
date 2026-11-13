import type { FieldDef, KokoStateDef, KokoStateId, KokoStateValues } from "./types";
import { cloneValue } from "./value";

const key = (scope: string, name: string) => `${scope}\u0000${name}`;

/**
 * KokoState 定義の登録簿。利用者定義と Built-in を同じ仕組みで扱う。
 *
 * 同一性は ID。名前は人向けの表示で、同じスコープに同じ名前があってもよい（別のフォルダの同じ名前。
 * ADR 0010）。名前で引くのは移行の間の書き方のためで、名前が一つに決まらないときは見つからない。
 * セッションではリポジトリごとにスコープを分ける。スコープ ""（既定）は全体で、Built-in はここに置き、
 * どのスコープからも見える。
 */
export class KokoStateRegistry {
  private readonly defs = new Map<KokoStateId, KokoStateDef>();
  private readonly scopes = new Map<KokoStateId, string>();
  /** スコープと名前 → その名前の KokoState（同じ名前が複数ありうる） */
  private readonly byName = new Map<string, Set<KokoStateId>>();

  register(def: KokoStateDef, scope = ""): void {
    this.unregister(def.id);
    this.defs.set(def.id, def);
    this.scopes.set(def.id, scope);
    const k = key(scope, def.name);
    const ids = this.byName.get(k) ?? new Set<KokoStateId>();
    ids.add(def.id);
    this.byName.set(k, ids);
  }

  unregister(id: KokoStateId): void {
    const def = this.defs.get(id);
    if (!def) return;
    const k = key(this.scopes.get(id) ?? "", def.name);
    const ids = this.byName.get(k);
    ids?.delete(id);
    if (ids && ids.size === 0) this.byName.delete(k);
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

  /**
   * 名前から ID を引く。スコープを指定したら、まずそのスコープ、なければ全体（Built-in など）を探す。
   * 同じ名前が複数あって一つに決まらないときは undefined。
   */
  idOf(name: string, scope = ""): KokoStateId | undefined {
    const inScope = this.byName.get(key(scope, name));
    if (inScope && inScope.size > 0) return inScope.size === 1 ? [...inScope][0] : undefined;
    if (!scope) return undefined;
    const global = this.byName.get(key("", name));
    return global?.size === 1 ? [...global][0] : undefined;
  }

  /** その名前が、同じスコープの中で複数の KokoState に当てはまるか */
  isAmbiguous(name: string, scope = ""): boolean {
    return (this.byName.get(key(scope, name))?.size ?? 0) > 1;
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
      // undefined も値なので、渡されたかどうかはキーで見る
      values[field.id] = cloneValue(
        partial && Object.hasOwn(partial, field.id) ? partial[field.id] : field.default,
      );
    }
    return values;
  }

  fieldByName(id: KokoStateId, name: string): FieldDef | undefined {
    return this.require(id).fields.find((f) => f.name === name);
  }
}
