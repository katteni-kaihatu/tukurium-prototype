import { type EntityId, type KokoStateRegistry, World } from "@tukurium/eks";
import { buildRegistry, type ProjectSnapshot } from "@tukurium/repo-model";

/**
 * 制作データ（スナップショット）から、1 つのアウトプットの World を組み立てる。
 * Edit モードの表示と、Play の開始時の両方で使う。親を先に作り、親が見つからない Entity は飛ばす。
 */
export function buildWorld(
  snapshot: ProjectSnapshot,
  outputId: string,
  registry: KokoStateRegistry = buildRegistry(snapshot.kokostates),
): { world: World; names: Map<EntityId, string> } {
  const world = new World(registry);
  const names = new Map<EntityId, string>();
  const entities = snapshot.entities.filter((e) => e.output === outputId);
  const ids = new Set(entities.map((e) => e.id));
  const pending = [...entities];
  while (pending.length > 0) {
    const before = pending.length;
    for (let i = pending.length - 1; i >= 0; i--) {
      const e = pending[i];
      if (!e) continue;
      const parent = e.parent !== null && ids.has(e.parent) ? e.parent : null;
      if (parent !== null && !world.has(parent)) continue;
      world.spawn(e.id, parent);
      for (const [koko, values] of Object.entries(e.states)) {
        if (registry.get(koko)) world.add(e.id, koko, values);
      }
      names.set(e.id, e.name);
      pending.splice(i, 1);
    }
    if (pending.length === before) break; // 親子が循環している（壊れたデータ）
  }
  return { world, names };
}
