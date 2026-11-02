import type { ClientMessage } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { ServerClient } from "../net/ServerClient";
import { WorkspaceSync } from "./WorkspaceSync";

function fakeClient() {
  const sent: ClientMessage[] = [];
  return { sent, client: { send: (m: ClientMessage) => sent.push(m) } as unknown as ServerClient };
}

const updates = (sent: ClientMessage[]) =>
  sent.flatMap((m) => (m.t === "ws.update" ? [Buffer.from(m.update, "base64")] : []));

describe("WorkspaceSync", () => {
  it("全体を受け取ってから、自分の変更だけを送る（受け取った更新は送り返さない）", () => {
    const server = new Y.Doc();
    server.getText("t").insert(0, "hello");
    const { sent, client } = fakeClient();
    const doc = new Y.Doc();
    const sync = new WorkspaceSync(client, "ws1", doc, new Awareness(doc));
    sync.receiveFull(Y.encodeStateAsUpdate(server), true);
    expect(doc.getText("t").toString()).toBe("hello");
    expect(updates(sent)).toHaveLength(0);

    doc.getText("t").insert(5, "!");
    const out = updates(sent);
    expect(out).toHaveLength(1);
    Y.applyUpdate(server, out[0] as Uint8Array);
    expect(server.getText("t").toString()).toBe("hello!");

    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(server));
    other.getText("t").insert(0, ">");
    sync.receive(Y.encodeStateAsUpdate(other, Y.encodeStateVector(server)));
    expect(doc.getText("t").toString()).toBe(">hello!");
    expect(updates(sent)).toHaveLength(1);
    sync.dispose();
  });

  it("再接続のとき、切れている間の手元の変更を差分で送り返す（閲覧者は送らない）", () => {
    const server = new Y.Doc();
    server.getText("t").insert(0, "base");
    const { sent, client } = fakeClient();
    const doc = new Y.Doc();
    const sync = new WorkspaceSync(client, "ws1", doc, new Awareness(doc));
    sync.receiveFull(Y.encodeStateAsUpdate(server), true);
    // 切断中の編集（送れずに失われたとする）
    doc.getText("t").insert(4, " offline");
    sent.length = 0;
    // その間にサーバー側も変わった
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(server));
    other.getText("t").insert(0, "[x]");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(other));

    sync.receiveFull(Y.encodeStateAsUpdate(server), true);
    const out = updates(sent);
    expect(out).toHaveLength(1);
    Y.applyUpdate(server, out[0] as Uint8Array);
    expect(server.getText("t").toString()).toBe(doc.getText("t").toString());
    expect(server.getText("t").toString()).toContain("offline");

    const viewer = fakeClient();
    const vdoc = new Y.Doc();
    vdoc.getText("t").insert(0, "local only");
    new WorkspaceSync(viewer.client, "ws1", vdoc, new Awareness(vdoc)).receiveFull(
      Y.encodeStateAsUpdate(server),
      false,
    );
    expect(updates(viewer.sent)).toHaveLength(0);
  });
});
