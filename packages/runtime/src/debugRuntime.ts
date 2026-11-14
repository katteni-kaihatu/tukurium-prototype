import {
  decodeValue,
  encodeValue,
  equalValues,
  type Json,
  stringifyValue,
  type Value,
} from "@tukurium/eks";
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
  change?: DebugChange;
  id: string;
  systemId: string;
  entity: string | null;
  line: number;
  frames: DebugFrame[];
  reason: string;
  states: DebugKokoState[];
  message?: string;
}
export interface DebugChange {
  entity: string;
  koko: string;
  field: string;
  oldValue: Json;
  newValue: Json;
  source: string;
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
  private readonly watchValues = new Map<string, Json>();
  private readonly guestValues = new Map<string, Json>();
  private hostChanges: DebugChange[] = [];
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
      watching?(enabled: boolean): void;
      guestValue?(
        w: DebugSettings["watches"][number],
        entities: ScriptEntity[],
        systemId: string,
      ): Json | undefined;
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
    this.watchValues.clear();
    for (const w of this.settings.watches) {
      const value = this.watchValue(w);
      if (value !== undefined) this.watchValues.set(w.id, value);
    }
    this.host?.watching?.(this.settings.watches.some((w) => w.enabled));
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
  beginSystem(entities: ScriptEntity[], systemId: string) {
    this.guestValues.clear();
    this.hostChanges = [];
    for (const w of this.settings.watches) {
      const value = this.host?.guestValue?.(w, entities, systemId);
      if (value !== undefined) this.guestValues.set(w.id, value);
    }
  }
  endSystem() {
    for (const w of this.settings.watches) {
      const value = this.watchValue(w);
      if (value !== undefined) this.watchValues.set(w.id, value);
    }
  }
  hostOperation<T>(run: () => T): T {
    const before = new Map(this.settings.watches.map((w) => [w.id, this.watchValue(w)]));
    try {
      return run();
    } finally {
      for (const w of this.settings.watches.filter((w) => w.enabled)) {
        const oldValue = before.get(w.id),
          newValue = this.watchValue(w);
        if (
          oldValue !== undefined &&
          newValue !== undefined &&
          !equalValues(decodeValue(oldValue), decodeValue(newValue))
        )
          this.hostChanges.push({
            entity: w.entity,
            koko: w.koko,
            field: w.field,
            oldValue,
            newValue,
            source: "スクリプト",
          });
      }
    }
  }
  private guestChanges(entities: ScriptEntity[], systemId: string): DebugChange[] {
    const changes: DebugChange[] = [];
    for (const w of this.settings.watches.filter((w) => w.enabled)) {
      const oldValue = this.guestValues.get(w.id),
        newValue = this.host?.guestValue?.(w, entities, systemId);
      if (newValue === undefined) continue;
      this.guestValues.set(w.id, newValue);
      if (oldValue !== undefined && !equalValues(decodeValue(oldValue), decodeValue(newValue)))
        changes.push({
          entity: w.entity,
          koko: w.koko,
          field: w.field,
          oldValue,
          newValue,
          source: "スクリプト",
        });
    }
    return changes;
  }
  private matchesChange(change: DebugChange, values: Record<string, unknown>): boolean {
    return this.settings.watches
      .filter(
        (w) =>
          w.enabled &&
          w.entity === change.entity &&
          w.koko === change.koko &&
          w.field === change.field,
      )
      .some((w) => {
        try {
          return (
            !w.condition?.trim() ||
            !!evaluateDebugExpression(compileDebugExpression(w.condition), {
              ...values,
              oldValue: decodeValue(change.oldValue),
              newValue: decodeValue(change.newValue),
            })
          );
        } catch (error) {
          this.warn("", `${w.id}:${String(error)}`, String(error));
          return false;
        }
      });
  }
  private watchValue(w: DebugSettings["watches"][number]): Json | undefined {
    return this.host
      ?.states(w.entity)
      .find((k) => k.id === w.koko)
      ?.fields.find((f) => f.id === w.field)?.value;
  }
  private changed(source: string, values: Record<string, unknown> = {}): DebugChange | undefined {
    let hit: DebugChange | undefined;
    for (const w of this.settings.watches.filter((w) => w.enabled)) {
      const before = this.watchValues.get(w.id);
      const after = this.watchValue(w);
      if (after === undefined) continue;
      this.watchValues.set(w.id, after);
      if (before === undefined || equalValues(decodeValue(before), decodeValue(after))) continue;
      try {
        if (
          w.condition?.trim() &&
          !evaluateDebugExpression(compileDebugExpression(w.condition), {
            ...values,
            oldValue: decodeValue(before),
            newValue: decodeValue(after),
          })
        )
          continue;
        hit ??= {
          entity: w.entity,
          koko: w.koko,
          field: w.field,
          oldValue: before,
          newValue: after,
          source,
        };
      } catch (error) {
        this.warn("", `${w.id}:${String(error)}`, String(error));
      }
    }
    return hit;
  }
  async externalChanges(source: string) {
    if (this.disposed || !this.settings.enabled) return;
    const change = this.changed(source);
    if (change && this.step?.mode !== "frame") await this.boundary("フィールドの変化", change);
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
    if (point.phase !== "mutation" && point.error === undefined) this.pointsThisFrame++;
    let hit = false;
    const values = Object.fromEntries(
      (point.frames.at(-1)?.variables ?? [])
        .filter((v) => !v.unavailable)
        .map((v) => [v.name, decodeValue(v.value)]),
    );
    for (const rule of point.phase === "mutation" || point.error !== undefined ? [] : this.rules) {
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
    const entities = decodeValue(point.entities) as ScriptEntity[];
    const hostChanges = this.hostChanges.splice(0);
    const candidates = [
      ...hostChanges,
      ...(point.phase === "mutation" || point.error !== undefined
        ? this.guestChanges(entities, point.systemId)
        : []),
    ];
    const detectedChange = candidates.find((c) => this.matchesChange(c, values));
    const change = this.step?.mode === "frame" ? undefined : detectedChange;
    let errorHit =
      point.error !== undefined &&
      this.settings.breakOnError &&
      (!this.settings.errorEntity || this.settings.errorEntity === point.entity);
    if (errorHit && this.settings.errorCondition?.trim()) {
      try {
        errorHit = !!evaluateDebugExpression(
          compileDebugExpression(this.settings.errorCondition),
          values,
        );
      } catch (error) {
        this.warn(point.systemId, `error:${String(error)}`, String(error));
        errorHit = false;
      }
    }
    const step = this.step;
    const stepping =
      point.phase !== "mutation" &&
      point.error === undefined &&
      step &&
      (step.mode === "into" ||
        (step.mode === "over" && step.depth === 0) ||
        (step.mode === "over" && point.frames.length <= step.depth) ||
        (step.mode === "out" &&
          !point.frames.some(
            (f) => f.id === step.id && (f.systemId ?? point.systemId) === step.systemId,
          )));
    if (!stepping && !(hit && step?.mode !== "frame") && !change && !errorHit) {
      return [];
    }
    this.step = null;
    this.pauseRequested = false;
    const restore = apply(entities);
    if (change && hostChanges.includes(change))
      this.host?.writeState({
        kind: "state",
        entity: change.entity,
        koko: change.koko,
        field: change.field,
        value: change.newValue,
      });
    this.stop = {
      id: crypto.randomUUID(),
      systemId: point.systemId,
      entity: change?.entity ?? point.entity,
      line: point.line,
      frames: point.frames,
      reason: errorHit
        ? "実行中のエラー"
        : change
          ? "フィールドの変化"
          : stepping
            ? "ステップ実行"
            : hit
              ? "ブレイクポイント"
              : "一時停止",
      states: this.host?.states(change?.entity ?? point.entity) ?? [],
      ...(change ? { change } : {}),
      ...(errorHit ? { message: point.error } : {}),
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
  private async boundary(reason: string, change?: DebugChange): Promise<void> {
    if (this.disposed || !this.settings.enabled) return;
    this.step = null;
    this.pauseRequested = false;
    this.stop = {
      id: crypto.randomUUID(),
      systemId: "",
      entity: change?.entity ?? null,
      line: 0,
      frames: [],
      states: this.host?.states(change?.entity ?? null) ?? [],
      reason,
      ...(change ? { change } : {}),
    };
    const wait = new Promise<DebugEdit[]>((resolve) => {
      this.resolve = resolve;
    });
    this.options.onPause(this.stop);
    await wait;
  }
}
