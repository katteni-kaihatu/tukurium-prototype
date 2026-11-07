import type { EntityId, World } from "@tukurium/eks";
import { BUILTIN } from "@tukurium/repo-model";

/**
 * 持つ・装備する（ADR 0053）。
 * - 右クリックで持つ：Grabbable の player に持っている人を入れる
 * - E で拾って右手に装備する：EquipmentTool の player に装備している人を入れる
 * どちらも空なら、誰も持っていない（置いてある）。
 */

/** player が右クリックで持っている物 */
export function grabbedBy(world: World, player: string): EntityId[] {
  return world
    .query({ with: [BUILTIN.Grabbable] })
    .filter((id) => world.get(id, BUILTIN.Grabbable)?.player === player);
}

/** player が装備している道具（右手だけなので、ふつうは 0 か 1 個） */
export function equippedBy(world: World, player: string): EntityId[] {
  return world
    .query({ with: [BUILTIN.EquipmentTool] })
    .filter((id) => world.get(id, BUILTIN.EquipmentTool)?.player === player);
}

/** 誰かが手に持っている・装備しているか（物理で落とさず、Transform に合わせて動かす） */
export function isInHand(world: World, id: EntityId): boolean {
  const grab = world.get(id, BUILTIN.Grabbable)?.player;
  const tool = world.get(id, BUILTIN.EquipmentTool)?.player;
  return (typeof grab === "string" && grab !== "") || (typeof tool === "string" && tool !== "");
}

/** 装備している人（いなければ空文字） */
export function equipper(world: World, id: EntityId): string {
  const p = world.get(id, BUILTIN.EquipmentTool)?.player;
  return typeof p === "string" ? p : "";
}

/** 装備している人がいる道具の、人の ID（アバターの腕を前に出すのに使う） */
export function playersWithEquipment(world: World): Set<string> {
  const out = new Set<string>();
  for (const id of world.query({ with: [BUILTIN.EquipmentTool] })) {
    const p = equipper(world, id);
    if (p) out.add(p);
  }
  return out;
}
