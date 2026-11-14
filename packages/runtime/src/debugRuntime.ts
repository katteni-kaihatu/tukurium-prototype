import { decodeValue, encodeValue, type Value } from "@tukurium/eks";
import type { DebugSettings } from "@tukurium/repo-model";

export type { DebugEdit } from "@tukurium/script";

import type {
  DebugEdit,
  DebugFrame,
  DebugKokoState,
  DebugPoint,
  DebugStateEdit,
  ScriptEntity,
} from "@tukurium/script";

export interface DebugStop {
  id: string;
  systemId: string;
  entity: string | null;
  line: number;
  frames: DebugFrame[];
  reason: string;
  states: DebugKokoState[];
  message?: string;
}
export interface RuntimeDebugOptions {
  settings(): DebugSettings;
  onPause(stop: DebugStop): void;
}

/** 一度に一つのフレームを進める。設定はフレームの先頭で取り直す。 */
export class DebugRuntime {
  stop: DebugStop | null = null;
  private settings: DebugSettings;
  private readonly lines = new Map<string, number[]>();
  private resolve: ((edits: DebugEdit[]) => void) | null = null;
  private pauseRequested = false;
  private disposed = false;
  private edits: DebugEdit[] = [];
  constructor(
    private readonly options: RuntimeDebugOptions,
    private readonly host?: {
      states(entity: string | null): DebugKokoState[];
      writeState(edit: DebugStateEdit): boolean;
    },
  ) {
    this.settings = options.settings();
  }
  register(systemId: string, lines: number[]) {
    this.lines.set(systemId, lines);
  }
  beginFrame() {
    this.settings = this.options.settings();
  }
  requestPause() {
    this.pauseRequested = true;
  }
  resume(id: string): boolean {
    if (this.stop?.id !== id || !this.resolve) return false;
    this.stop = null;
    const resolve = this.resolve;
    this.resolve = null;
    resolve(this.edits);
    this.edits = [];
    return true;
  }
  dispose() {
    this.disposed = true;
    this.resolve?.([]);
    this.resolve = null;
    this.stop = null;
    this.edits = [];
  }
  edit(id: string, edit: DebugEdit): boolean {
    const stop = this.stop;
    if (!stop || stop.id !== id || !this.resolve) return false;
    const reject = () => {
      this.stop = {
        ...stop,
        message: "この値は変更できません。型と書き込み先を確認してください。",
      };
      this.options.onPause(this.stop);
      return false;
    };
    try {
      decodeValue(edit.value);
    } catch {
      return reject();
    }
    if (edit.kind === "state") {
      if (edit.entity !== stop.entity || !this.host?.writeState(edit)) return reject();
      this.edits = this.edits.filter(
        (e) =>
          e.kind !== "state" ||
          e.entity !== edit.entity ||
          e.koko !== edit.koko ||
          e.field !== edit.field,
      );
    } else {
      const variable = stop.frames
        .find((f) => f.id === edit.frameId)
        ?.variables.find((v) => v.name === edit.name);
      if (!variable?.writable || variable.unavailable) return reject();
      edit.binding = variable.binding;
      this.edits = this.edits.filter(
        (e) =>
          e.kind === "state" ||
          (!(edit.binding && e.binding === edit.binding) &&
            (e.frameId !== edit.frameId || e.name !== edit.name)),
      );
    }
    this.edits.push(edit);
    this.stop = {
      ...stop,
      message: undefined,
      states: this.host?.states(stop.entity) ?? [],
      frames: stop.frames.map((f) => ({
        ...f,
        variables: f.variables.map((v) => {
          if (edit.kind !== "state")
            return (
              edit.binding
                ? v.binding === edit.binding
                : f.id === edit.frameId && v.name === edit.name
            )
              ? { ...v, value: edit.value, state: undefined }
              : v;
          if (v.state?.entity !== edit.entity || v.state.koko !== edit.koko) return v;
          const value = decodeValue(v.value) as Record<string, Value>;
          if (!value || typeof value !== "object") return { ...v, state: undefined };
          value[edit.fieldName ?? edit.field] = decodeValue(edit.value) as Value;
          return { ...v, value: encodeValue(value) };
        }),
      })),
    };
    this.options.onPause(this.stop);
    return true;
  }
  async point(
    point: DebugPoint,
    apply: (entities: ScriptEntity[]) => (edits: DebugEdit[]) => void,
  ): Promise<DebugEdit[]> {
    if (this.disposed || !this.settings.enabled) return [];
    const hit = this.settings.breakpoints.find(
      (p) =>
        p.enabled &&
        p.kind === "breakpoint" &&
        p.systemId === point.systemId &&
        (this.lines.get(p.systemId)?.find((line) => line >= p.line) ?? -1) === point.line,
    );
    if (!this.pauseRequested && !hit) return [];
    this.pauseRequested = false;
    const restore = apply(decodeValue(point.entities) as ScriptEntity[]);
    this.stop = {
      id: crypto.randomUUID(),
      systemId: point.systemId,
      entity: point.entity,
      line: point.line,
      frames: point.frames,
      reason: hit ? "ブレイクポイント" : "一時停止",
      states: this.host?.states(point.entity) ?? [],
    };
    const result = new Promise<DebugEdit[]>((resolve) => {
      this.resolve = resolve;
    });
    let edits: DebugEdit[] = [];
    try {
      this.options.onPause(this.stop);
      edits = await result;
      return edits;
    } finally {
      restore(edits);
    }
  }
}
