import { cloneValue, type KokoStateRegistry } from "./registry";
import type { EntityId, KokoStateId, KokoStateValues, Query } from "./types";

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
  private nextLocalId = 1;

  constructor(readonly registry: KokoStateRegistry) {}

  /** 実行中に生まれる Entity 用の ID を発行する（制作データの ID とは衝突しない接頭辞）。 */
  newRuntimeId(): EntityId {
    return `rt:${this.nextLocalId++}`;
  }

  spawn(id: EntityId = this.newRuntimeId(), parent: EntityId | null = null): EntityId {
    if (this.entities.has(id)) throw new Error(`Entity already exists: ${id}`);
    this.entities.set(id, { parent, states: new Map() });
    return id;
  }

  /** Entity を削除する。子も再帰的に削除する。 */
  destroy(id: EntityId): void {
    if (!this.entities.delete(id)) return;
    for (const [childId, rec] of [...this.entities]) {
      if (rec.parent === id) this.destroy(childId);
    }
  }

  has(id: EntityId): boolean {
    return this.entities.has(id);
  }

  parentOf(id: EntityId): EntityId | null {
    return this.record(id).parent;
  }

  childrenOf(id: EntityId | null): EntityId[] {
    const out: EntityId[] = [];
    for (const [eid, rec] of this.entities) if (rec.parent === id) out.push(eid);
    return out;
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
    for (const e of snap.entities) {
      const states = new Map<KokoStateId, KokoStateValues>();
      for (const [koko, values] of Object.entries(e.states)) states.set(koko, cloneValues(values));
      this.entities.set(e.id, { parent: e.parent, states });
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
  const out: KokoStateValues = {};
  for (const [k, v] of Object.entries(values)) out[k] = cloneValue(v);
  return out;
}
