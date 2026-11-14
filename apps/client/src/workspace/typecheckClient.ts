import type { EditorQuery, EditorResults, TypeCheckResult } from "@tukurium/typecheck";
import type { CheckRequest, TypecheckRequest, TypecheckResponse } from "./typecheckProtocol";

/** 一つの Worker を型の確認とエディタで共用する。終了時は待っている問い合わせも解放する。 */
export class TypecheckClient {
  private sequence = 0;
  private pending = new Map<number, (response: TypecheckResponse | null) => void>();
  private context: Omit<CheckRequest, "id" | "kind"> | null = null;
  private sent: Omit<CheckRequest, "id" | "kind"> | null = null;
  private disposed = false;
  constructor(
    private readonly worker: Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">,
  ) {
    worker.onmessage = (event: MessageEvent<TypecheckResponse>) => {
      this.pending.get(event.data.id)?.(event.data);
      this.pending.delete(event.data.id);
    };
    worker.onerror = () => this.dispose();
  }

  private request(request: TypecheckRequest): Promise<TypecheckResponse | null> {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending.set(request.id, resolve);
      this.worker.postMessage(request);
    });
  }

  async check(input: Omit<CheckRequest, "id" | "kind">): Promise<TypeCheckResult | null> {
    this.sent = structuredClone(input);
    const response = await this.request({ ...input, kind: "check", id: ++this.sequence });
    return response?.kind === "check" && !response.error ? response.result : null;
  }

  async query<K extends EditorQuery["kind"]>(
    query: Extract<EditorQuery, { kind: K }>,
    version = this.sequence + 1,
  ): Promise<EditorResults[K] | null> {
    // ほかのファイルや定義が変わっていれば先に読み直す。編集中の一ファイルだけなら本文の差し替えで足りる。
    if (
      this.context &&
      (!this.sent ||
        projectContext(this.context, query.fileId) !== projectContext(this.sent, query.fileId))
    )
      void this.check(this.context);
    const response = await this.request({ kind: "query", id: ++this.sequence, version, query });
    return response?.kind === "query" && response.version === version && !response.error
      ? (response.result as EditorResults[K])
      : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  updateContext(input: Omit<CheckRequest, "id" | "kind">): void {
    this.context = input;
  }
}

function projectContext(input: Omit<CheckRequest, "id" | "kind">, fileId: string): string {
  return JSON.stringify({
    ...input,
    snapshot: {
      ...input.snapshot,
      systems: input.snapshot.systems.map((s) => (s.id === fileId ? { ...s, code: "" } : s)),
      types: input.snapshot.types?.map((t) => (t.id === fileId ? { ...t, code: "" } : t)),
    },
  });
}

export let editorTypecheck: TypecheckClient | null = null;
export function setEditorTypecheck(client: TypecheckClient | null): void {
  editorTypecheck = client;
}
