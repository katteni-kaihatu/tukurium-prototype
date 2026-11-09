import {
  type Diagnostic,
  dirtyRefs,
  GenerationGate,
  type ObservedDiagnostics,
  type ProjectSnapshot,
} from "@tukurium/repo-model";

/**
 * スクリプトの確認を、調べ直しが要る System だけに絞る（計画 Phase 3）。
 *
 * - 制作データが変わるたびに `update()` を呼ぶ。依存グラフで、変更の影響を受ける System
 *   だけに「調べ直し」の印を付ける。影響を受けない System の結果は、今の版のものとして扱う。
 * - `check()` で印の付いた System を調べる。調べ終わるまで、前の結果は古い版（stale）のまま残る。
 * - 確認は非同期なので、最後に始めた確認の結果だけを受け取る。確認の途中で同じ System が
 *   また変わったら、印は残しておき、次の確認で調べ直す。
 */
export class IncrementalCheck {
  private snap: ProjectSnapshot | null = null;
  /** System ID → その System の問題と、調べた版 */
  private readonly results = new Map<string, ObservedDiagnostics>();
  /** 調べ直しが要る System と、印を付けたときの通し番号 */
  private readonly pending = new Map<string, number>();
  private seq = 0;
  private readonly gate = new GenerationGate();

  constructor(private readonly run: (systemIds: string[]) => Promise<Diagnostic[]>) {}

  update(next: ProjectSnapshot, version: number): void {
    this.seq += 1;
    const ids = new Set(next.systems.map((s) => s.id));
    const dirty = this.snap
      ? dirtyRefs(this.snap, next)
          .filter((r) => r.kind === "system")
          .map((r) => r.id)
      : [...ids];
    for (const id of [...this.results.keys(), ...this.pending.keys()])
      if (!ids.has(id)) {
        this.results.delete(id);
        this.pending.delete(id);
      }
    for (const id of dirty) if (ids.has(id)) this.pending.set(id, this.seq);
    for (const [id, r] of this.results)
      if (!this.pending.has(id)) this.results.set(id, { ...r, observedVersion: version });
    this.snap = next;
  }

  /**
   * すべての System に調べ直しの印を付ける（問題パネルの「確かめ直す」）。
   * 前の結果は、調べ終わるまで今のまま残す（点滅を避ける）。
   */
  markAll(): void {
    this.seq += 1;
    for (const s of this.snap?.systems ?? []) this.pending.set(s.id, this.seq);
  }

  /** 印の付いた System を調べる。結果を受け取れたら true */
  async check(version: number): Promise<boolean> {
    const targets = [...this.pending];
    if (targets.length === 0) return false;
    const generation = this.gate.begin();
    const diagnostics = await this.run(targets.map(([id]) => id));
    if (!this.gate.accepts(generation)) return false;
    for (const [id, markedAt] of targets) {
      if (!this.snap?.systems.some((s) => s.id === id)) continue;
      this.results.set(id, {
        diagnostics: diagnostics.filter((d) => d.subject.id === id),
        observedVersion: version,
      });
      // 確認の途中でまた変わっていなければ、印を外す
      if (this.pending.get(id) === markedAt) this.pending.delete(id);
    }
    return true;
  }

  /** 表示用：問題のある System ごとの結果 */
  sets(): ObservedDiagnostics[] {
    return [...this.results.values()].filter((r) => r.diagnostics.length > 0);
  }
}
