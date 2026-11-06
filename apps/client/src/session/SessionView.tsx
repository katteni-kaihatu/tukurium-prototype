import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import { editProject } from "../main-menu/editing";
import { useMainMenu } from "../main-menu/store";
import { useWorkspace } from "../workspace/store";
import { WorkspaceController } from "../workspace/WorkspaceController";
import { WorkspacePanels } from "../workspace/WorkspacePanels";
import { SessionEngine } from "./SessionEngine";
import styles from "./SessionView.module.css";
import { SessionWorldController } from "./SessionWorldController";
import { resetSessionWorld } from "./sessionWorld";
import { WorkspacePreviews } from "./WorkspacePreviews";

const POSE_INTERVAL_MS = 100;

/** セッションの 3D 空間。参加・退出、参加者の表示、ワークスペースのパネル。 */
export function SessionView() {
  const { sessionId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const openRepo = search.get("open");
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SessionEngine | null>(null);
  const [locked, setLocked] = useState(false);
  const [engine, setEngine] = useState<SessionEngine | null>(null);
  const editing = useWorkspace((s) => !!s.project && s.mode === "edit" && !s.panelsHidden);
  const client = useApp((s) => s.client);
  const session = useApp((s) => s.session);
  const closedReason = useApp((s) => s.closedReason);
  const editAfterJoin = useMainMenu((s) => s.editAfterJoin);

  // 参加（接続し直したときも参加し直す）と退出
  useEffect(() => {
    useApp.setState({ closedReason: null });
    return client.onWelcome(() => {
      if (client.joinedSessionId !== sessionId) client.send({ t: "session.join", sessionId });
    });
  }, [client, sessionId]);

  // セッションがなくなったら（閉じられた・サーバーが入れ替わって再接続したら無かった）、
  // 空間に残さずホームへ出す。理由はホームに出す（closedReason・sessionError）。
  useEffect(() => {
    return client.on((msg) => {
      const gone =
        msg.t === "session.closed" ||
        (msg.t === "session.rejected" && !msg.requestId && msg.sessionId === sessionId);
      if (gone) navigate("/", { replace: true });
    });
  }, [client, sessionId, navigate]);

  // 別セッションへの移動では、サーバーの受理前に今の場所を退出しない。
  useEffect(() => {
    return () => {
      useWorkspace.getState().leave();
      resetSessionWorld();
      client.send({ t: "session.leave" });
      useApp.setState({ session: null, participants: {}, remotePanels: {} });
    };
  }, [client]);

  // ?open=リポジトリID：セッションに入ったら、そのリポジトリをワークスペースとして開く
  useEffect(() => {
    if (!openRepo || session?.id !== sessionId) return;
    useWorkspace.getState().openRepo(openRepo);
    setSearch({}, { replace: true });
  }, [openRepo, session?.id, sessionId, setSearch]);

  // 3D 空間
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const engine = new SessionEngine(container);
    engineRef.current = engine;
    setEngine(engine);
    useMainMenu.setState({ engine });
    if (import.meta.env.DEV) (window as { __tukurium?: SessionEngine }).__tukurium = engine;
    const workspace = new WorkspaceController(engine);
    const sessionWorld = new SessionWorldController(engine);
    const previews = new WorkspacePreviews(engine);
    if (import.meta.env.DEV) (window as { __previews?: WorkspacePreviews }).__previews = previews;

    // 参加者の表示
    const me = () => useApp.getState().me?.id;
    const syncAvatars = () => {
      const { participants } = useApp.getState();
      const ids = new Set(Object.keys(participants));
      for (const p of Object.values(participants)) if (p.id !== me()) engine.upsertParticipant(p);
      for (const id of Object.keys(engine.avatars.positions())) {
        if (!ids.has(id)) engine.removeParticipant(id);
      }
    };
    const offApp = useApp.subscribe((s, prev) => {
      if (s.participants !== prev.participants) syncAvatars();
      if (s.remotePanels !== prev.remotePanels) engine.remotePanels.set(s.remotePanels);
    });
    syncAvatars();
    const offMsg = client.on((msg) => {
      if (msg.t === "pose" && msg.id !== me()) {
        engine.setParticipantPose(msg.id, msg.position, msg.yaw, msg.pitch);
      }
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
      client.send({ t: "pose", ...pose });
    }, POSE_INTERVAL_MS);

    const onLockChange = () => setLocked(engine.controller.locked);
    document.addEventListener("pointerlockchange", onLockChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerlockchange", onLockChange);
      offApp();
      offMsg();
      workspace.dispose();
      sessionWorld.dispose();
      previews.dispose();
      useMainMenu.setState({ engine: null });
      engine.dispose();
      engineRef.current = null;
      setEngine(null);
    };
  }, [client]);

  // 参加前に選んだ編集は、空間の初期化が済んでから始める。
  // StrictMode の初回 cleanup が、新しく開いたワークスペースを閉じないようにする。
  useEffect(() => {
    if (!engine || session?.id !== sessionId || !editAfterJoin) return;
    const timer = setTimeout(() => {
      if (useMainMenu.getState().editAfterJoin !== editAfterJoin) return;
      useMainMenu.setState({ editAfterJoin: null });
      useMainMenu.getState().showProject("/workspaces");
      if (editAfterJoin !== "chooser") editProject(editAfterJoin);
    }, 0);
    return () => clearTimeout(timer);
  }, [engine, session?.id, sessionId, editAfterJoin]);

  return (
    <div className={styles.root}>
      <div ref={containerRef} className={styles.canvas} />
      {engine && session && <WorkspacePanels engine={engine} />}
      <Header inSession />
      <div className={styles.crosshair} aria-hidden="true">
        <span className={styles.chV} />
        <span className={styles.chH} />
        <span className={styles.chDot} />
      </div>
      {closedReason && (
        <div className={`glass ${styles.closed}`} role="alert">
          <p>{closedReason}</p>
          <Link to="/">ホームに戻る</Link>
        </div>
      )}
      {!locked && !closedReason && (
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
        {(editing
          ? [
              ["WASD", "移動"],
              ["マウス", "見回す"],
              ["クリック", "モノを選ぶ・パネルを押す"],
              ["右クリック", "押している間、持つ・パネルを動かす"],
              ["持ってホイール", "前後に動かす"],
              ["持って左クリック", "傾きを直す"],
              ["持って E", "マウスで回す"],
              ["Tab", "パネルを隠す"],
              ["Esc", "マウスを解放"],
            ]
          : [
              ["WASD", "移動"],
              ["クリック", "アイテムを使う（持っているときは傾きを直す）"],
              ["右クリック", "押している間、持つ"],
              ["持ってホイール", "前後に動かす"],
              ["R", "リロード"],
              ["E", "見ている物を使う（持っているときは回す）"],
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
