import type { EntityId, Query } from "./types";
import type { World } from "./world";

/** System の実行単位。処理の中身（スクリプト等）は実装側が与える。 */
export interface SystemRunner {
  id: string;
  name: string;
  query: Query;
  enabled: boolean;
  onUpdate?(world: World, entity: EntityId, dt: number): void;
}

export interface SystemError {
  systemId: string;
  entity: EntityId | null;
  error: unknown;
}

/**
 * System を登録順（アウトプットの Systems 一覧の並び）で実行する。
 * 1つの System が例外を出したらその System を止め、他は動かし続ける。
 */
export class Scheduler {
  private systems: SystemRunner[] = [];
  readonly errors: SystemError[] = [];

  setSystems(systems: SystemRunner[]): void {
    this.systems = [...systems];
  }

  list(): readonly SystemRunner[] {
    return this.systems;
  }

  tick(world: World, dt: number): void {
    for (const sys of this.systems) {
      if (!sys.enabled || !sys.onUpdate) continue;
      for (const entity of world.query(sys.query)) {
        if (!world.has(entity)) continue; // 先行する処理で削除された
        try {
          sys.onUpdate(world, entity, dt);
        } catch (error) {
          sys.enabled = false;
          this.errors.push({ systemId: sys.id, entity, error });
          break;
        }
      }
    }
  }
}
