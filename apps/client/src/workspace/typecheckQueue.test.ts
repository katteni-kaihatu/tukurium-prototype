import { emptyProject } from "@tukurium/repo-model";
import { describe, expect, it, vi } from "vitest";
import type { CheckRequest, TypecheckResponse } from "./typecheckProtocol";
import { TypecheckQueue } from "./typecheckQueue";

function fixture() {
  const steps: (() => void)[] = [];
  const events: string[] = [];
  const responses: TypecheckResponse[] = [];
  const checker = {
    prepare: vi.fn(() => {
      events.push("prepare");
      return { diagnostics: [], schemas: {} };
    }),
    checkSystem: vi.fn((id: string) => {
      events.push(id);
      return [];
    }),
    query: vi.fn(() => {
      events.push("query");
      return null;
    }),
  };
  const queue = new TypecheckQueue(
    checker,
    (r) => responses.push(r),
    (run) => steps.push(run),
  );
  const request: CheckRequest = {
    kind: "check",
    id: 1,
    packages: [],
    hostDeclarations: "",
    snapshot: {
      ...emptyProject("test"),
      systems: ["a", "b"].map((id) => ({ id, name: id, code: "" })),
    },
  };
  const step = () => {
    const run = steps.shift();
    if (!run) throw new Error("待っている処理がありません");
    run();
  };
  return { queue, request, step, events, responses, checker };
}

describe("型の確認と場所の問い合わせ", () => {
  it("確認の途中でも、次のスクリプトより先に問い合わせへ答える", () => {
    const { queue, request, step, events, responses } = fixture();
    queue.receive(request);
    step();
    step();
    queue.receive({
      kind: "query",
      id: 2,
      version: 2,
      query: { kind: "hover", fileId: "a", code: "new", position: 0 },
    });
    step();
    expect(events).toEqual(["prepare", "a", "query"]);
    expect(responses[0]).toMatchObject({ kind: "query", id: 2 });
    step();
    expect(responses[1]).toMatchObject({ kind: "check", id: 1 });
  });

  it("新しい確認が来たら古い確認を打ち切り、待っている側にも知らせる", () => {
    const { queue, request, step, responses } = fixture();
    queue.receive(request);
    step();
    queue.receive({ ...request, id: 2 });
    expect(responses[0]).toMatchObject({ id: 1, error: "superseded" });
    step();
    step();
    step();
    expect(responses[1]).toMatchObject({ id: 2, kind: "check" });
  });

  it("最初の読み込みに失敗しても、問い合わせを待たせ続けない", () => {
    const { queue, request, checker, step, responses } = fixture();
    checker.prepare.mockImplementation(() => {
      throw new Error("読み込み失敗");
    });
    queue.receive(request);
    queue.receive({
      kind: "query",
      id: 2,
      version: 1,
      query: { kind: "hover", fileId: "a", code: "", position: 0 },
    });
    step();
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatchObject({
      kind: "query",
      id: 2,
      version: 1,
      result: null,
      error: "Error: 読み込み失敗",
    });
  });
});
