import type { ProjectSnapshot } from "./schema";

/** from から to まで、プレハブの中のインスタンスをたどる。見つからなければ null。 */
export function prefabUsePath(snap: ProjectSnapshot, from: string, to: string): string[] | null {
  const roots = new Set((snap.prefabs ?? []).map((p) => p.root));
  const uses = new Map<string, Set<string>>();
  for (const e of snap.prefabEntities ?? []) {
    if (!e.instanceOf || roots.has(e.id)) continue;
    const targets = uses.get(e.prefab) ?? new Set<string>();
    targets.add(e.instanceOf.prefab);
    uses.set(e.prefab, targets);
  }
  const seen = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (id === to) return [id];
    if (seen.has(id)) return null;
    seen.add(id);
    for (const target of uses.get(id) ?? []) {
      const rest = visit(target);
      if (rest) return [id, ...rest];
    }
    return null;
  };
  return visit(from);
}
