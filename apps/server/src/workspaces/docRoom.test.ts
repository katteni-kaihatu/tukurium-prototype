import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocRoom, type WorkspaceRole } from "./docRoom";

/** クライアント側の Y.Doc と、サーバーの DocRoom をつなぐ */
function client(room: DocRoom, id: string) {
  const doc = new Y.Doc();
  const received: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "server") room.receive(id, u);
  });
  const joined = room.join({
    id,
    sendUpdate: (u) => {
      received.push(u);
      Y.applyUpdate(doc, u, "server");
    },
  });
  return { doc, received, joined, text: () => doc.getText("code").toString() };
}

describe("DocRoom（ワークスペースの権限付き同期）", () => {
  const roles = new Map<string, WorkspaceRole | null>();
  const roleOf = (id: string) => roles.get(id) ?? null;

  it("共同編集者どうしで同期し、閲覧者は受け取れるが書けず、権限のない人には何も届かない", () => {
    roles.clear();
    roles.set("admin", "admin").set("editor", "editor").set("viewer", "viewer");
    const room = new DocRoom(roleOf);
    const a = client(room, "admin");
    const e = client(room, "editor");
    const v = client(room, "viewer");
    const s = client(room, "stranger");
    expect([a.joined, e.joined, v.joined, s.joined]).toEqual([true, true, true, false]);

    a.doc.getText("code").insert(0, "let ammo = 12;");
    expect(e.text()).toBe("let ammo = 12;");
    expect(v.text()).toBe("let ammo = 12;");
    expect(s.received).toHaveLength(0);

    e.doc.getText("code").insert(0, "// gun\n");
    expect(a.text()).toBe("// gun\nlet ammo = 12;");

    // 閲覧者の書き込みはサーバーで捨てられ、他の人には届かない
    v.doc.getText("code").insert(0, "HACK ");
    expect(room.doc.getText("code").toString()).toBe("// gun\nlet ammo = 12;");
    expect(a.text()).toBe("// gun\nlet ammo = 12;");
  });

  it("権限を外すと、それ以降の更新は届かない", () => {
    roles.clear();
    roles.set("a", "admin").set("b", "editor");
    const room = new DocRoom(roleOf);
    const a = client(room, "a");
    const b = client(room, "b");
    a.doc.getText("code").insert(0, "x");
    expect(b.text()).toBe("x");

    roles.set("b", null);
    expect(room.revalidate()).toEqual(["b"]);
    a.doc.getText("code").insert(1, "y");
    expect(b.text()).toBe("x");
  });

  it("途中から参加しても、それまでの内容を受け取れる", () => {
    roles.clear();
    roles.set("a", "admin").set("late", "viewer");
    const room = new DocRoom(roleOf);
    const a = client(room, "a");
    a.doc.getText("code").insert(0, "hello");
    const late = client(room, "late");
    expect(late.text()).toBe("hello");
  });
});
