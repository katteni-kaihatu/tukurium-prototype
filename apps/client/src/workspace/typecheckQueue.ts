import type { TypeChecker, TypeCheckResult } from "@tukurium/typecheck";
import type {
  CheckRequest,
  QueryRequest,
  TypecheckRequest,
  TypecheckResponse,
} from "./typecheckProtocol";

/** スクリプト一つごとにイベントループへ戻り、場所の問い合わせを先に処理する。 */
export class TypecheckQueue {
  private pending: CheckRequest | null = null;
  private queries: QueryRequest[] = [];
  private active: { request: CheckRequest; ids: string[]; result: TypeCheckResult } | null = null;
  private scheduled = false;
  private loaded = false;

  constructor(
    private readonly checker: Pick<TypeChecker, "prepare" | "checkSystem" | "query">,
    private readonly reply: (response: TypecheckResponse) => void,
    private readonly schedule: (run: () => void) => void = (run) => {
      setTimeout(run, 0);
    },
  ) {}

  receive(request: TypecheckRequest): void {
    if (request.kind === "check") {
      for (const old of [this.pending, this.active?.request])
        if (old)
          this.reply({
            kind: "check",
            id: old.id,
            result: { diagnostics: [], schemas: {} },
            error: "superseded",
          });
      this.active = null;
      this.pending = request;
    } else this.queries.push(request);
    this.wake();
  }

  private wake(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.step());
  }

  private step(): void {
    this.scheduled = false;
    // 最初の問い合わせだけは、制作データを読み込むまで待つ。
    const query = this.loaded && !this.pending ? this.queries.shift() : undefined;
    if (query) {
      try {
        this.reply({
          kind: "query",
          id: query.id,
          version: query.version,
          result: this.checker.query(query.query),
        });
      } catch (e) {
        this.reply({
          kind: "query",
          id: query.id,
          version: query.version,
          result: null,
          error: String(e),
        });
      }
    } else if (this.pending) {
      const request = this.pending;
      this.pending = null;
      this.active = null;
      try {
        const result = this.checker.prepare({ ...request, packages: new Map(request.packages) });
        this.active = { request, ids: request.snapshot.systems.map((s) => s.id), result };
        this.loaded = true;
      } catch (e) {
        this.loaded = false;
        this.reply({
          kind: "check",
          id: request.id,
          result: { diagnostics: [], schemas: {} },
          error: String(e),
        });
        for (const waiting of this.queries.splice(0))
          this.reply({
            kind: "query",
            id: waiting.id,
            version: waiting.version,
            result: null,
            error: String(e),
          });
      }
    } else if (this.active) {
      const active = this.active;
      const id = active.ids.shift();
      try {
        if (id) active.result.diagnostics.push(...this.checker.checkSystem(id));
        if (active.ids.length === 0) {
          this.active = null;
          this.reply({ kind: "check", id: active.request.id, result: active.result });
        }
      } catch (e) {
        this.active = null;
        this.reply({
          kind: "check",
          id: active.request.id,
          result: active.result,
          error: String(e),
        });
      }
    }
    if (this.pending || this.active || (this.loaded && this.queries.length)) this.wake();
  }
}
