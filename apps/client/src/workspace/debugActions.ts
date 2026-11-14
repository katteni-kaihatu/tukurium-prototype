import { openRing } from "../session/ringMenuModel";
import { useWorkspace } from "./store";

export function offerDebugEntity(entity: string): boolean {
  const ws = useWorkspace.getState();
  if (
    !ws.debug?.read().enabled ||
    !ws.debugPointId ||
    !ws.debugReady ||
    (ws.role !== "editor" && ws.role !== "admin")
  )
    return false;
  openRing([
    {
      id: "debug-entity",
      label: "このときだけ一時停止する",
      enabled: true,
      run: () => {
        ws.debug?.update(ws.debugPointId!, { entity });
        useWorkspace.setState({ debugOpen: true });
      },
    },
  ]);
  return true;
}
