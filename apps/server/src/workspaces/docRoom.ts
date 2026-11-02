import * as Y from "yjs";

/** ワークスペースの権限。上ほど強い。 */
export type WorkspaceRole = "viewer" | "editor" | "admin";

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function canRead(role: WorkspaceRole | null): boolean {
  return role !== null && RANK[role] >= RANK.viewer;
}

export function canWrite(role: WorkspaceRole | null): boolean {
  return role !== null && RANK[role] >= RANK.editor;
}

export interface DocPeer {
  id: string;
  /** Yjs の更新（バイナリ）を送る */
  sendUpdate(update: Uint8Array): void;
}

/**
 * ワークスペース 1 つ分の Y.Doc。
 * - 閲覧権限のある接続にだけ内容を送る。権限のない接続にはドキュメントごと送らない。
 * - 書き込み（更新の適用）は共同編集以上の権限がある接続からだけ受け付ける。
 * - 権限は呼び出しのたびに `roleOf` で確かめるので、途中で権限を外せば次から届かなくなる。
 */
export class DocRoom {
  readonly doc = new Y.Doc();
  private readonly peers = new Map<string, DocPeer>();

  constructor(private readonly roleOf: (peerId: string) => WorkspaceRole | null) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      for (const peer of this.peers.values()) {
        if (peer.id === origin) continue; // 送ってきた本人には返さない
        if (canRead(this.roleOf(peer.id))) peer.sendUpdate(update);
      }
    });
  }

  /**
   * 参加する。閲覧権限がなければ false（何も送らない）。
   * sendInitial が false なら、全体の送信は呼び出し側に任せる（権限と一緒に送る場合など）。
   */
  join(peer: DocPeer, sendInitial = true): boolean {
    if (!canRead(this.roleOf(peer.id))) return false;
    this.peers.set(peer.id, peer);
    if (sendInitial) peer.sendUpdate(Y.encodeStateAsUpdate(this.doc));
    return true;
  }

  leave(peerId: string): void {
    this.peers.delete(peerId);
  }

  /** 接続から届いた更新を適用する。書き込み権限がなければ捨てて false。 */
  receive(peerId: string, update: Uint8Array): boolean {
    if (!this.peers.has(peerId) || !canWrite(this.roleOf(peerId))) return false;
    Y.applyUpdate(this.doc, update, peerId);
    return true;
  }

  /** 権限が変わったときに呼ぶ。閲覧できなくなった接続を外す。 */
  revalidate(): string[] {
    const removed: string[] = [];
    for (const id of [...this.peers.keys()]) {
      if (!canRead(this.roleOf(id))) {
        this.peers.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  get size(): number {
    return this.peers.size;
  }
}
