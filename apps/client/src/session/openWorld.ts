import type { PlacementInfo } from "@tukurium/shared";

/** セッションで開いているワールド。複数あるときは、最初に置いたものを土台とする */
export function currentWorld(placements: readonly PlacementInfo[]): PlacementInfo | null {
  return placements.find((p) => p.outputKind === "world") ?? null;
}
