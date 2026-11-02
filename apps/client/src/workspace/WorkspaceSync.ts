import {
  type Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { ServerClient } from "../net/ServerClient";

/** サーバーから届いた更新の印（自分の変更と区別して、送り返さないため） */
const REMOTE = Symbol("remote");

/**
 * ワークスペースの Y.Doc をサーバーと同期する。
 * - 最初に全体を受け取ったあと、自分の変更を更新として送る。
 * - 接続し直したときは、サーバーにない手元の変更（切れている間の編集）を差分で送り返す。
 * - カーソルなどの一時的な状態（awareness）もサーバー経由で、閲覧権限のある人にだけ届ける。
 */
export class WorkspaceSync {
  private ready = false;
  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || !this.ready) return;
    this.client.send({ t: "ws.update", workspaceId: this.workspaceId, update: toB64(update) });
  };
  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE) return;
    const ids = [...changes.added, ...changes.updated, ...changes.removed];
    this.client.send({
      t: "ws.awareness",
      workspaceId: this.workspaceId,
      update: toB64(encodeAwarenessUpdate(this.awareness, ids)),
    });
  };

  constructor(
    private readonly client: ServerClient,
    private readonly workspaceId: string,
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
  ) {
    doc.on("update", this.onDocUpdate);
    awareness.on("update", this.onAwarenessUpdate);
  }

  /** サーバーの全体を受け取る（参加時・再接続時）。書ける権限があれば、手元だけの変更を送り返す。 */
  receiveFull(update: Uint8Array, canWrite: boolean): void {
    const server = new Y.Doc();
    Y.applyUpdate(server, update);
    const serverVector = Y.encodeStateVector(server);
    server.destroy();
    Y.applyUpdate(this.doc, update, REMOTE);
    this.ready = true;
    if (canWrite) {
      const missing = Y.encodeStateAsUpdate(this.doc, serverVector);
      // 空の更新は 2 バイト
      if (missing.length > 2) {
        this.client.send({ t: "ws.update", workspaceId: this.workspaceId, update: toB64(missing) });
      }
    }
    // 自分のカーソルなどを知らせ直す
    this.onAwarenessUpdate({ added: [this.doc.clientID], updated: [], removed: [] }, null);
  }

  receive(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE);
  }

  receiveAwareness(update: Uint8Array): void {
    applyAwarenessUpdate(this.awareness, update, REMOTE);
  }

  dispose(): void {
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
  }
}

function toB64(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i += 0x8000)
    bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
}
