import { openRing } from "../session/ringMenuModel";
import { useWorkspace } from "./store";

/**
 * パネルで「Entity を右クリックで選ぶ」を押した条件があるときだけ、Entity の右クリックを受け取る。
 * 選び終えたとき・その条件がもうないときは、右クリックをふつうの操作（つかむ など）に戻す。
 */
export function offerDebugEntity(entity: string): boolean {
  const ws = useWorkspace.getState();
  const target = ws.debugPointId;
  if (!target || !ws.debugReady || (ws.role !== "editor" && ws.role !== "admin")) return false;
  const settings = ws.debug?.read();
  const point = settings?.breakpoints.find((p) => p.id === target);
  const watch = settings?.watches.find((w) => w.id === target);
  if (!settings?.enabled || (!point && !watch)) {
    useWorkspace.setState({ debugPointId: null });
    return false;
  }
  openRing([
    {
      id: "debug-entity",
      label: "このときだけ一時停止する",
      enabled: true,
      run: () => {
        if (point) ws.debug?.update(point.id, { entity });
        else if (watch) ws.debug?.setWatch({ ...watch, entity });
        useWorkspace.setState({ debugOpen: true, debugPointId: null });
      },
    },
  ]);
  return true;
}
