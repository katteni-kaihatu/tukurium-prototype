import { randomUUID } from "node:crypto";
import {
  ClientMessage,
  type Participant,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@tukurium/shared";

export interface Peer {
  send(data: string): void;
  close(): void;
}

/**
 * 仮のセッション（M0）：参加者の位置・向きを中継するだけ。
 * M2 で本人識別・複数セッション・ワークスペースに置き換える。
 */
export class Lobby {
  private readonly members = new Map<string, { peer: Peer; p: Participant | null }>();

  connect(peer: Peer): { id: string; onMessage(raw: string): void; onClose(): void } {
    const id = randomUUID();
    this.members.set(id, { peer, p: null });
    return {
      id,
      onMessage: (raw) => this.handle(id, raw),
      onClose: () => {
        const m = this.members.get(id);
        this.members.delete(id);
        if (m?.p) this.broadcast({ t: "left", id }, id);
      },
    };
  }

  get size(): number {
    return this.members.size;
  }

  private handle(id: string, raw: string): void {
    const m = this.members.get(id);
    if (!m) return;
    let msg: ClientMessage;
    try {
      msg = ClientMessage.parse(JSON.parse(raw));
    } catch {
      this.send(m.peer, { t: "error", message: "invalid message" });
      return;
    }
    switch (msg.t) {
      case "hello": {
        if (m.p) return; // 2回目以降の hello は無視する
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.send(m.peer, {
            t: "error",
            message: `protocol mismatch (server ${PROTOCOL_VERSION})`,
          });
          m.peer.close();
          return;
        }
        m.p = { id, name: msg.name, position: [0, 0, 0], yaw: 0, pitch: 0 };
        const others = [...this.members.values()].flatMap((o) =>
          o.p && o.p.id !== id ? [o.p] : [],
        );
        this.send(m.peer, {
          t: "welcome",
          protocol: PROTOCOL_VERSION,
          you: id,
          participants: others,
        });
        this.broadcast({ t: "joined", participant: m.p }, id);
        return;
      }
      case "pose": {
        if (!m.p) return;
        m.p.position = msg.position;
        m.p.yaw = msg.yaw;
        m.p.pitch = msg.pitch;
        this.broadcast(
          { t: "pose", id, position: msg.position, yaw: msg.yaw, pitch: msg.pitch },
          id,
        );
        return;
      }
    }
  }

  private send(peer: Peer, msg: ServerMessage): void {
    peer.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, except?: string): void {
    const data = JSON.stringify(msg);
    for (const [mid, m] of this.members) if (mid !== except && m.p) m.peer.send(data);
  }
}
