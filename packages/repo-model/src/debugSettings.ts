import * as Y from "yjs";
import type { ProjectDoc } from "./projectDoc";

export interface DebugBreakpoint {
  id: string;
  systemId: string;
  line: number;
  enabled: boolean;
  kind: "breakpoint" | "logpoint";
  condition: string;
  expression: string;
  entity: string;
}
export interface DebugWatch {
  id: string;
  enabled: boolean;
  entity: string;
  koko: string;
  field: string;
}
export interface DebugSettings {
  enabled: boolean;
  breakOnError: boolean;
  breakpoints: DebugBreakpoint[];
  watches: DebugWatch[];
}
type Anchor = Omit<DebugBreakpoint, "line"> & { start: number[]; end: number[] };

/** 制作データとは別の、保存しない Y.Doc。位置だけは制作データの Y.Text を指す。 */
export class DebugSettingsDoc {
  readonly doc = new Y.Doc();
  private get settings() {
    return this.doc.getMap<unknown>("settings");
  }
  private get points() {
    return this.doc.getMap<Anchor>("points");
  }
  private get watches() {
    return this.doc.getMap<DebugWatch>("watches");
  }
  constructor(private readonly project: ProjectDoc) {}

  read(): DebugSettings {
    const breakpoints: DebugBreakpoint[] = [];
    for (const [id, point] of this.points) {
      try {
        if (
          !point ||
          typeof point.systemId !== "string" ||
          !Array.isArray(point.start) ||
          !Array.isArray(point.end)
        )
          continue;
        if (!this.project.system(point.systemId)) continue;
        const text = this.project.code(point.systemId);
        if (!text) continue;
        const start = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(new Uint8Array(point.start)),
          this.project.doc,
        );
        const end = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(new Uint8Array(point.end)),
          this.project.doc,
        );
        if (!start || !end || start.type !== text || end.type !== text || start.index >= end.index)
          continue;
        breakpoints.push({
          id,
          systemId: point.systemId,
          line: text.toString().slice(0, start.index).split("\n").length,
          enabled: point.enabled === true,
          kind: point.kind === "logpoint" ? "logpoint" : "breakpoint",
          condition: typeof point.condition === "string" ? point.condition : "",
          expression: typeof point.expression === "string" ? point.expression : "",
          entity: typeof point.entity === "string" ? point.entity : "",
        });
      } catch {
        /* 壊れた位置は使わない。 */
      }
    }
    return {
      enabled: this.settings.get("enabled") === true,
      breakOnError: this.settings.get("breakOnError") !== false,
      breakpoints,
      watches: [...this.watches.values()].filter(
        (w) =>
          w &&
          typeof w.entity === "string" &&
          typeof w.koko === "string" &&
          typeof w.field === "string",
      ),
    };
  }
  setEnabled(enabled: boolean) {
    this.settings.set("enabled", enabled);
  }
  setBreakOnError(enabled: boolean) {
    this.settings.set("breakOnError", enabled);
  }
  add(systemId: string, line: number, kind: DebugBreakpoint["kind"] = "breakpoint"): string | null {
    const text = this.project.code(systemId);
    if (!this.project.system(systemId) || !text || !Number.isInteger(line) || line < 1) return null;
    const code = text.toString();
    const rows = code.split("\n");
    if (line > rows.length) return null;
    const start = rows.slice(0, line - 1).reduce((n, row) => n + row.length + 1, 0);
    if (start >= code.length) return null;
    const id = crypto.randomUUID();
    this.points.set(id, {
      id,
      systemId,
      enabled: true,
      kind,
      condition: "",
      expression: "",
      entity: "",
      start: Array.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, start, 0)),
      ),
      end: Array.from(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(
            text,
            Math.min(code.length, start + (rows[line - 1]?.length ?? 0) + 1),
            -1,
          ),
        ),
      ),
    });
    return id;
  }
  update(
    id: string,
    patch: Partial<
      Pick<DebugBreakpoint, "enabled" | "condition" | "expression" | "entity" | "kind">
    >,
  ) {
    const previous = this.points.get(id);
    if (previous) this.points.set(id, { ...previous, ...patch });
  }
  remove(id: string) {
    this.points.delete(id);
  }
  toggle(systemId: string, line: number) {
    const previous = this.read().breakpoints.find(
      (p) => p.systemId === systemId && p.line === line,
    );
    if (previous) this.remove(previous.id);
    else this.add(systemId, line);
  }
  setWatch(watch: DebugWatch) {
    this.watches.set(watch.id, watch);
  }
  removeWatch(id: string) {
    this.watches.delete(id);
  }
  prune() {
    const valid = new Set(this.read().breakpoints.map((p) => p.id));
    this.doc.transact(() => {
      for (const id of this.points.keys()) if (!valid.has(id)) this.points.delete(id);
    });
  }
  dispose() {
    this.doc.destroy();
  }
}
