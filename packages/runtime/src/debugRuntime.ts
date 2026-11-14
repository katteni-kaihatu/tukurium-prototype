import { decodeValue, encodeValue, stringifyValue, type Value } from "@tukurium/eks";
import { compileDebugExpression, type DebugSettings } from "@tukurium/repo-model";

export type { DebugEdit } from "@tukurium/script";

import type {
  DebugEdit,
  DebugFrame,
  DebugKokoState,
  DebugPoint,
  DebugRule,
  DebugStateEdit,
  ScriptEntity,
} from "@tukurium/script";
import { evaluateDebugExpression } from "@tukurium/script";

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
export type DebugStep = "continue" | "into" | "over" | "out" | "frame";

/** 一度に一つのフレームを進める。設定はフレームの先頭で取り直す。 */
export class DebugRuntime {
  stop: DebugStop | null = null;
  private settings: DebugSettings;
  private readonly lines = new Map<string, number[]>();
  private resolve: ((edits: DebugEdit[]) => void) | null = null;
  private pauseRequested = false;
  private disposed = false;
  private edits: DebugEdit[] = [];
  private frameNumber = 0;
  private pointsThisFrame = 0;
  private rules: DebugRule[] = [];
  private readonly warnings = new Set<string>();
  private step: {
    mode: Exclude<DebugStep, "continue">;
    frame: number;
    depth: number;
    id: number;
    line: number;
    systemId: string;
  } | null = null;
  constructor(
    private readonly options: RuntimeDebugOptions,
    private readonly host?: {
      states(entity: string | null): DebugKokoState[];
      writeState(edit: DebugStateEdit): boolean;
      log?(systemId: string, message: string): void;
    },
  ) {
    this.settings = options.settings();
  }
  register(systemId: string, lines: number[]) {
    this.lines.set(systemId, lines);
  }
  async beginFrame() {
    this.frameNumber++;
    this.pointsThisFrame = 0;
    this.settings = structuredClone(this.options.settings());
    this.rules = [];
    for (const p of this.settings.breakpoints.filter((p) => p.enabled)) {
      try {
        this.rules.push({
          id: p.id,
          systemId: p.systemId,
          line: this.lines.get(p.systemId)?.find((line) => line >= p.line) ?? -1,
          entity: p.entity,
          ...(p.condition.trim() ? { condition: compileDebugExpression(p.condition) } : {}),
          ...(p.kind === "logpoint"
            ? { expression: compileDebugExpression(p.expression.trim() || '"ログポイント"') }
            : {}),
        });
      } catch (error) {
        this.warn(p.systemId, `${p.id}:${p.condition}:${p.expression}`, String(error));
      }
    }
    if (this.step?.mode === "frame" && this.frameNumber > this.step.frame)
      await this.boundary("次のフレーム");
  }
  async endFrame() {
    if (this.pauseRequested || (this.step && this.pointsThisFrame === 0))
      await this.boundary("フレームの切れ目");
  }
  requestPause() {
    this.pauseRequested = true;
  }
  private warn(systemId: string, key: string, error: string) {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    this.host?.log?.(systemId, `デバッグの式：${error}`);
  }
  resume(id: string, mode: DebugStep = "continue"): boolean {
    if (this.stop?.id !== id || !this.resolve) return false;
    const frame = this.stop.frames.at(-1);
    this.step =
      mode === "continue"
        ? null
        : {
            mode,
            frame: this.frameNumber,
            depth: this.stop.frames.length,
            id: frame?.id ?? -1,
            line: this.stop.line,
            systemId: this.stop.systemId,
          };
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
    this.step = null;
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
    this.pointsThisFrame++;
    let hit = false;
    const values = Object.fromEntries(
      (point.frames.at(-1)?.variables ?? [])
        .filter((v) => !v.unavailable)
        .map((v) => [v.name, decodeValue(v.value)]),
    );
    for (const rule of this.rules) {
      if (
        rule.systemId !== point.systemId ||
        rule.line !== point.line ||
        (rule.entity && rule.entity !== point.entity)
      )
        continue;
      try {
        if (rule.condition && !evaluateDebugExpression(rule.condition, values)) continue;
        if (rule.expression)
          this.host?.log?.(
            rule.systemId,
            `${rule.line} 行目：${stringifyValue(evaluateDebugExpression(rule.expression, values) as Value)}`,
          );
        else hit = true;
      } catch (error) {
        this.warn(rule.systemId, `${rule.id}:${String(error)}`, String(error));
      }
    }
    const step = this.step;
    const stepping =
      step &&
      (step.mode === "into" ||
        (step.mode === "over" && step.depth === 0) ||
        (step.mode === "over" && point.frames.length <= step.depth) ||
        (step.mode === "out" &&
          !point.frames.some(
            (f) => f.id === step.id && (f.systemId ?? point.systemId) === step.systemId,
          )));
    if (!stepping && !(hit && step?.mode !== "frame")) return [];
    this.step = null;
    this.pauseRequested = false;
    const restore = apply(decodeValue(point.entities) as ScriptEntity[]);
    this.stop = {
      id: crypto.randomUUID(),
      systemId: point.systemId,
      entity: point.entity,
      line: point.line,
      frames: point.frames,
      reason: stepping ? "ステップ実行" : hit ? "ブレイクポイント" : "一時停止",
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
  private async boundary(reason: string): Promise<void> {
    if (this.disposed || !this.settings.enabled) return;
    this.step = null;
    this.pauseRequested = false;
    this.stop = {
      id: crypto.randomUUID(),
      systemId: "",
      entity: null,
      line: 0,
      frames: [],
      states: [],
      reason,
    };
    const wait = new Promise<DebugEdit[]>((resolve) => {
      this.resolve = resolve;
    });
    this.options.onPause(this.stop);
    await wait;
  }
}
