import { decodeValue } from "@tukurium/eks";
import type { DebugSettings } from "@tukurium/repo-model";
import type { DebugEdit, DebugFrame, DebugPoint, ScriptEntity } from "@tukurium/script";

export interface DebugStop {
  id: string;
  systemId: string;
  entity: string | null;
  line: number;
  frames: DebugFrame[];
  reason: string;
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
  constructor(private readonly options: RuntimeDebugOptions) {
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
    resolve([]);
    return true;
  }
  dispose() {
    this.disposed = true;
    this.resolve?.([]);
    this.resolve = null;
    this.stop = null;
  }
  async point(
    point: DebugPoint,
    apply: (entities: ScriptEntity[]) => () => void,
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
    };
    const result = new Promise<DebugEdit[]>((resolve) => {
      this.resolve = resolve;
    });
    try {
      this.options.onPause(this.stop);
      return await result;
    } finally {
      restore();
    }
  }
}
