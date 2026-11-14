import { emptyProject } from "@tukurium/repo-model";
import { describe, expect, it, vi } from "vitest";
import { TypecheckClient } from "./typecheckClient";
import type { TypecheckRequest } from "./typecheckProtocol";

describe("エディタと Worker の通信", () => {
  it("編集中の一ファイルだけなら本文だけを送り、ほかの定義が変われば制作データも読み直す", async () => {
    const sent: TypecheckRequest[] = [];
    const worker = {
      postMessage: (m: TypecheckRequest) => sent.push(m),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
    } as unknown as Worker;
    const client = new TypecheckClient(worker);
    const input = {
      snapshot: {
        ...emptyProject("test"),
        systems: [{ id: "code", name: "Code", code: "const a = 1" }],
      },
      packages: [],
      hostDeclarations: "",
    };
    void client.check(input);
    const edited = structuredClone(input);
    const script = edited.snapshot.systems[0];
    if (!script) throw new Error("スクリプトがありません");
    script.code = "const a = 2";
    client.updateContext(edited);
    const query = { kind: "hover" as const, fileId: "code", code: "const a = 2", position: 6 };
    void client.query(query, 2);
    expect(sent.map((r) => r.kind)).toEqual(["check", "query"]);
    edited.snapshot.name = "new name";
    client.updateContext(edited);
    const pending = client.query(query, 3);
    expect(sent.map((r) => r.kind)).toEqual(["check", "query", "check", "query"]);
    client.dispose();
    expect(await pending).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
