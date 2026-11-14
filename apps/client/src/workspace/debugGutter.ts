import { GutterMarker, gutter } from "@codemirror/view";
import { useWorkspace } from "./store";

class DebugMarker extends GutterMarker {
  constructor(
    private readonly label: string,
    private readonly color: string,
  ) {
    super();
  }
  override toDOM() {
    const span = document.createElement("span");
    span.textContent = this.label;
    span.style.cssText = `display:inline-block;width:16px;text-align:center;color:${this.color};cursor:pointer`;
    return span;
  }
}
const breakpoint = new DebugMarker("●", "#b43b48");
const logpoint = new DebugMarker("◆", "#2d8298");
const inactive = new DebugMarker("○", "#8b8585");
const spacer = new DebugMarker(" ", "transparent");

export function debugGutter(systemId: string) {
  const state = useWorkspace.getState();
  if (!state.project?.system(systemId)) return [];
  const settings = state.debug?.read();
  if (!settings?.enabled) return [];
  const points = new Map(
    settings.breakpoints.filter((p) => p.systemId === systemId).map((p) => [p.line, p]),
  );
  return gutter({
    class: "cm-tk-debug",
    initialSpacer: () => spacer,
    lineMarker: (view, line) => {
      const point = points.get(view.state.doc.lineAt(line.from).number);
      return !point
        ? null
        : !point.enabled
          ? inactive
          : point.kind === "logpoint"
            ? logpoint
            : breakpoint;
    },
    domEventHandlers: {
      mousedown: (view, line, event) => {
        const s = useWorkspace.getState();
        if (!s.debugReady || (s.role !== "editor" && s.role !== "admin")) return false;
        event.preventDefault();
        const number = view.state.doc.lineAt(line.from).number;
        if ((event as MouseEvent).button === 2) {
          const previous = s.debug
            ?.read()
            .breakpoints.find((p) => p.systemId === systemId && p.line === number);
          if (previous) s.debug?.update(previous.id, { kind: "logpoint" });
          const id = previous?.id ?? s.debug?.add(systemId, number, "logpoint");
          useWorkspace.setState({ debugOpen: true, debugPointId: id ?? null });
        } else if ((event as MouseEvent).button === 0) s.debug?.toggle(systemId, number);
        return true;
      },
      contextmenu: (_view, _line, event) => {
        event.preventDefault();
        return true;
      },
    },
  });
}
