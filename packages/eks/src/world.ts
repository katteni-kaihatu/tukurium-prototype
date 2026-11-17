import type { KokoStateRegistry } from "./registry";
import type { EntityId, KokoStateId, KokoStateValues, Query } from "./types";
import { cloneValue } from "./value";

export interface EntitySnapshot {
  id: EntityId;
  parent: EntityId | null;
  states: Record<KokoStateId, KokoStateValues>;
}

export interface WorldSnapshot {
  entities: EntitySnapshot[];
}

interface EntityRecord {
  parent: EntityId | null;
  states: Map<KokoStateId, KokoStateValues>;
}

/**
 * Entity と、それが持つ KokoState の値を保持する。
 * 描画・物理・スクリプトに依存しない（Node でもブラウザでも動く）。
 */
export class World {
  private readonly entities = new Map<EntityId, EntityRecord>();
  /**
   * 親 → 子の索引（作った順）。子を探す・消すたびに、すべての Entity を見なくて済むようにする
   * （実行中に、たくさん作っては消すときに効く）。親が、まだない Entity の ID でも持てる
   */
  private readonly children = new Map<EntityId | null, Set<EntityId>>();
  private nextLocalId = 1;

  constructor(readonly registry: KokoStateRegistry) {}

  /** 実行中に生まれる Entity 用の ID を発行する（制作データの ID とは衝突しない接頭辞）。 */
  newRuntimeId(): EntityId {
    return `rt:${this.nextLocalId++}`;
  }

  spawn(id: EntityId = this.newRuntimeId(), parent: EntityId | null = null): EntityId {
    if (this.entities.has(id)) throw new Error(`Entity already exists: ${id}`);
    this.entities.set(id, { parent, states: new Map() });
    this.link(id, parent);
    return id;
  }

  private link(id: EntityId, parent: EntityId | null): void {
    const list = this.children.get(parent);
    if (list) list.add(id);
    else this.children.set(parent, new Set([id]));
  }

  /** Entity を削除する。子も再帰的に削除する。 */
  destroy(id: EntityId): void {
    const rec = this.entities.get(id);
    if (!rec) return;
    this.entities.delete(id);
    const siblings = this.children.get(rec.parent);
    siblings?.delete(id);
    if (siblings?.size === 0) this.children.delete(rec.parent);
    const list = this.children.get(id);
    if (list) for (const child of [...list]) this.destroy(child);
    this.children.delete(id);
  }

  has(id: EntityId): boolean {
    return this.entities.has(id);
  }

  parentOf(id: EntityId): EntityId | null {
    return this.record(id).parent;
  }

  childrenOf(id: EntityId | null): EntityId[] {
    return [...(this.children.get(id) ?? [])];
  }

  entityIds(): EntityId[] {
    return [...this.entities.keys()];
  }

  add(id: EntityId, koko: KokoStateId, values?: KokoStateValues): KokoStateValues {
    const created = this.registry.createValues(koko, values);
    this.record(id).states.set(koko, created);
    return created;
  }

  remove(id: EntityId, koko: KokoStateId): void {
    this.record(id).states.delete(koko);
  }

  hasState(id: EntityId, koko: KokoStateId): boolean {
    return this.entities.get(id)?.states.has(koko) ?? false;
  }

  get(id: EntityId, koko: KokoStateId): KokoStateValues | undefined {
    return this.entities.get(id)?.states.get(koko);
  }

  statesOf(id: EntityId): KokoStateId[] {
    return [...this.record(id).states.keys()];
  }

  /** With をすべて持ち、Without を1つも持たない Entity を返す。結果は配列のコピーなので反復中の削除に安全。 */
  query(q: Query): EntityId[] {
    const out: EntityId[] = [];
    for (const [id, rec] of this.entities) {
      if (q.with.every((k) => rec.states.has(k)) && !q.without?.some((k) => rec.states.has(k))) {
        out.push(id);
      }
    }
    return out;
  }

  snapshot(): WorldSnapshot {
    const entities: EntitySnapshot[] = [];
    for (const [id, rec] of this.entities) {
      const states: Record<KokoStateId, KokoStateValues> = {};
      for (const [koko, values] of rec.states) states[koko] = cloneValues(values);
      entities.push({ id, parent: rec.parent, states });
    }
    return { entities };
  }

  restore(snap: WorldSnapshot): void {
    this.entities.clear();
    this.children.clear();
    for (const e of snap.entities) {
      const states = new Map<KokoStateId, KokoStateValues>();
      for (const [koko, values] of Object.entries(e.states)) states.set(koko, cloneValues(values));
      this.entities.set(e.id, { parent: e.parent, states });
      this.link(e.id, e.parent);
      const m = /^rt:(\d+)$/.exec(e.id);
      if (m) this.nextLocalId = Math.max(this.nextLocalId, Number(m[1]) + 1);
    }
  }

  private record(id: EntityId): EntityRecord {
    const rec = this.entities.get(id);
    if (!rec) throw new Error(`Unknown entity: ${id}`);
    return rec;
  }
}

function cloneValues(values: KokoStateValues): KokoStateValues {
  return cloneValue(values);
}
