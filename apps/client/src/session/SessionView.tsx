import { useEffect, useRef, useState } from "react";
import { useSession } from "../app/store";
import { Connection } from "../net/Connection";
import { useWorkspace } from "../workspace/store";
import { WorkspaceController } from "../workspace/WorkspaceController";
import { WorkspacePanels } from "../workspace/WorkspacePanels";
import { SessionEngine } from "./SessionEngine";
import styles from "./SessionView.module.css";

const POSE_INTERVAL_MS = 100;

export function SessionView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SessionEngine | null>(null);
  const [locked, setLocked] = useState(false);
  const [engine, setEngine] = useState<SessionEngine | null>(null);
  const myName = useSession((s) => s.myName);
  const mode = useWorkspace((s) => s.mode);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const engine = new SessionEngine(container);
    engineRef.current = engine;
    setEngine(engine);
    const workspace = new WorkspaceController(engine);
    // 開発時のみ：E2E テストやデバッグからエンジンを参照できるようにする
    if (import.meta.env.DEV) (window as { __tukurium?: SessionEngine }).__tukurium = engine;
    const store = useSession.getState();

    const conn = new Connection(myName, {
      onStatus: (status) => {
        store.set({ status });
        if (status !== "online") {
          engine.avatars.clear();
          store.set({ participants: {} });
        }
      },
      onMessage: (msg) => {
        const { participants } = useSession.getState();
        switch (msg.t) {
          case "welcome": {
            const next = Object.fromEntries(msg.participants.map((p) => [p.id, p]));
            for (const p of msg.participants) engine.upsertParticipant(p);
            store.set({ myId: msg.you, participants: next });
            break;
          }
          case "joined":
            engine.upsertParticipant(msg.participant);
            store.set({ participants: { ...participants, [msg.participant.id]: msg.participant } });
            break;
          case "pose":
            // 位置・向きは 3D 表示だけで使う。ストア（参加者一覧）は更新しない
            engine.setParticipantPose(msg.id, msg.position, msg.yaw, msg.pitch);
            break;
          case "left": {
            engine.removeParticipant(msg.id);
            const { [msg.id]: _, ...rest } = participants;
            store.set({ participants: rest });
            break;
          }
          case "error":
            console.warn("[server]", msg.message);
            break;
        }
      },
    });

    let last = "";
    const timer = setInterval(() => {
      const pose = engine.pose();
      const key = JSON.stringify([
        pose.position.map((v) => v.toFixed(2)),
        pose.yaw.toFixed(3),
        pose.pitch.toFixed(3),
      ]);
      if (key === last) return;
      last = key;
      conn.send({ t: "pose", ...pose });
    }, POSE_INTERVAL_MS);

    const onLockChange = () => setLocked(engine.controller.locked);
    document.addEventListener("pointerlockchange", onLockChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerlockchange", onLockChange);
      conn.close();
      workspace.dispose();
      engine.dispose();
      engineRef.current = null;
      setEngine(null);
    };
  }, [myName]);

  return (
    <div className={styles.root}>
      <div ref={containerRef} className={styles.canvas} />
      {engine && <WorkspacePanels engine={engine} />}
      <div className={styles.crosshair} aria-hidden="true">
        <span className={styles.chV} />
        <span className={styles.chH} />
        <span className={styles.chDot} />
      </div>
      {!locked && (
        <button
          type="button"
          className={`glass ${styles.start}`}
          onClick={() => engineRef.current?.controller.lock()}
        >
          クリックして空間に入る
          <small>Esc でマウスを解放</small>
        </button>
      )}
      <ul className={`glass ${styles.hints}`} aria-label="操作">
        {(mode === "edit"
          ? [
              ["WASD", "移動"],
              ["マウス", "見回す"],
              ["クリック", "モノを選ぶ"],
              ["Tab", "パネルを隠す"],
              ["Esc", "マウスを解放"],
            ]
          : [
              ["WASD", "移動"],
              ["クリック", "撃つ（fire）"],
              ["R", "reload"],
              ["E", "use"],
              ["Esc", "マウスを解放"],
            ]
        ).map(([key, label]) => (
          <li key={key}>
            <kbd>{key}</kbd>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
