import {
  emptyProject,
  gunAndTargetSample,
  gunSample,
  targetRangeSample,
} from "@tukurium/repo-model";
import type { PanelPublic } from "@tukurium/shared";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api, type RepoMeta } from "../net/api";
import { PanelLayer, type PanelSpec } from "../panels/PanelLayer";
import { SessionBelongings } from "../session/SessionBelongings";
import type { SessionEngine } from "../session/SessionEngine";
import { DetailPanel } from "./DefinitionProperties";
import { EditorPanel } from "./EditorPanel";
import { HistoryPanel } from "./HistoryPanel";
import { InspectorPanel } from "./InspectorPanel";
import { LibraryPanel } from "./LibraryPanel";
import { LogPanel } from "./LogPanel";
import { MainPanel } from "./MainPanel";
import { MembersPanel } from "./MembersPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { ResourcesPanel } from "./ResourcesPanel";
import { SavePanel } from "./SavePanel";
import { SessionLinks } from "./SessionLinks";
import { useWorkspace } from "./store";
import { summarize } from "./summary";
import ui from "./ui.module.css";
import { useOpenProblemsOnError, usePackageDefinitions, useScriptCheck } from "./useProblems";

const MAIN: PanelSpec = {
  id: "ws-main",
  title: "ワークスペース",
  initial: { x: 16, y: 84, width: 560 },
  render: () => <MainPanel />,
};

const INSPECTOR: PanelSpec = {
  id: "ws-inspector",
  title: "Inspector",
  // 高さはここで固定する。選んだ Entity の項目の数では変えない（中でスクロールする）
  initial: { x: 16, y: 470, width: 600, height: 400 },
  render: () => <InspectorPanel />,
};

const RESOURCES: PanelSpec = {
  id: "ws-resources",
  title: "Resources",
  initial: { right: 16, y: 84, width: 600 },
  render: () => <ResourcesPanel />,
};

const START: PanelSpec = {
  id: "ws-start",
  title: "ワークスペース",
  initial: { x: 16, y: 84, width: 420 },
  render: () => <WorkspaceStart />,
};

/** セッション中のパネル一式。ワークスペースを開いていなければ、開く・作るためのパネルだけ出す。 */
export function WorkspacePanels({ engine }: { engine: SessionEngine }) {
  const ready = useWorkspace((s) => s.ready && s.project !== null);
  const hasEditor = useWorkspace((s) => s.openSystems.length > 0);
  // コードを開いた・問題の行へ移ったときは、エディタを前に出す
  const editorFocus = useWorkspace((s) => `${s.activeSystem}:${s.jumpTo?.seq ?? 0}`);
  const hidden = useWorkspace((s) => s.panelsHidden);
  useScriptCheck();
  usePackageDefinitions();
  useOpenProblemsOnError();
  const [members, setMembers] = useState(false);

  const historyOpen = useWorkspace((s) => s.historyOpen);
  const saveOpen = useWorkspace((s) => s.saveOpen);
  const saveSeq = useWorkspace((s) => s.saveSeq);
  const libraryOpen = useWorkspace((s) => s.libraryOpen);
  const belongingsOpen = useWorkspace((s) => s.belongingsOpen);
  const sessionOpen = useWorkspace((s) => s.sessionOpen);
  const inspectorOpen = useWorkspace((s) => s.inspectorOpen);
  const resourcesOpen = useWorkspace((s) => s.resourcesOpen);
  const problemsOpen = useWorkspace((s) => s.problemsOpen);
  const problemsFocus = useWorkspace((s) => s.problemsFocus);
  const logOpen = useWorkspace((s) => s.logOpen);
  const detail = useWorkspace((s) => s.detail);
  const panels: PanelSpec[] = [];
  if (libraryOpen) {
    panels.push({
      id: "ws-library",
      title: "ライブラリ",
      initial: { right: 16, y: 84, width: 420 },
      render: () => <LibraryPanel />,
      onClose: () => useWorkspace.setState({ libraryOpen: false }),
    });
  }
  if (!ready) {
    panels.push(START);
  } else {
    if (saveOpen) {
      panels.push({
        id: "ws-save",
        title: "保存",
        initial: { x: 36, y: 168, width: 440, height: 560 },
        focusKey: saveSeq,
        render: () => <SavePanel />,
        onClose: () => useWorkspace.setState({ saveOpen: false }),
      });
    }
    if (historyOpen) {
      panels.push({
        id: "ws-history",
        title: "履歴",
        initial: { x: 500, y: 168, width: 900, height: 560 },
        render: () => <HistoryPanel />,
        onClose: () => useWorkspace.setState({ historyOpen: false }),
      });
    }
    panels.push({
      ...MAIN,
      actions: (
        <button
          type="button"
          className={ui.btn}
          style={{ height: 26 }}
          aria-pressed={members}
          onClick={() => setMembers((v) => !v)}
        >
          Members
        </button>
      ),
    });
    if (inspectorOpen) {
      panels.push({
        ...INSPECTOR,
        onClose: () => useWorkspace.setState({ inspectorOpen: false }),
      });
    }
    if (resourcesOpen) {
      panels.push({
        ...RESOURCES,
        onClose: () => useWorkspace.setState({ resourcesOpen: false }),
      });
    }
    if (sessionOpen) {
      panels.push({
        id: "ws-session",
        title: "セッション同期",
        initial: { right: 16, y: 470, width: 460 },
        render: () => <SessionLinks />,
        onClose: () => useWorkspace.setState({ sessionOpen: false }),
      });
    }
    if (problemsOpen) {
      panels.push({
        id: "ws-problems",
        title: "エラー",
        initial: { x: 640, y: 84, width: 480 },
        // 新しいエラーが出たときに前に出す
        focusKey: problemsFocus,
        render: () => <ProblemsPanel />,
        onClose: () => useWorkspace.setState({ problemsOpen: false }),
      });
    }
    if (logOpen) {
      panels.push({
        id: "ws-log",
        title: "ログ・保存",
        initial: { x: 640, y: 470, width: 520 },
        render: () => <LogPanel />,
        onClose: () => useWorkspace.setState({ logOpen: false }),
      });
    }
    if (hasEditor) {
      panels.push({
        id: "ws-editor",
        title: "コード",
        initial: { x: 640, y: 160, width: 640 },
        focusKey: editorFocus,
        render: () => <EditorPanel />,
        onClose: () => {
          const ws = useWorkspace.getState();
          for (const id of ws.openSystems) ws.closeSystem(id);
        },
      });
    }
    if (detail) {
      panels.push({
        id: "ws-detail",
        title: "詳細",
        // フィールドの数では高さを変えない。あふれた分は中でスクロールする
        initial: { x: 420, y: 84, width: 400, height: 480 },
        focusKey: detail.seq,
        render: () => <DetailPanel />,
        onClose: () => useWorkspace.getState().closeDetail(),
      });
    }
    if (members) {
      panels.push({
        id: "ws-members",
        title: "Members",
        initial: { right: 16, y: 400, width: 420 },
        render: () => <MembersPanel />,
        onClose: () => setMembers(false),
      });
    }
  }
  if (belongingsOpen) {
    panels.push({
      id: "session-belongings",
      title: "セッション",
      // メインパネルの右。ワークスペースを開いていなくても、セッションに置いてあるものを出せる
      initial: { x: 600, y: 96, width: 460, height: 480 },
      // ワークスペースのパネルが後から出ても、開いている一覧が後ろに隠れない
      focusKey: ready ? "workspace" : "session",
      render: () => <SessionBelongings />,
      onClose: () => useWorkspace.setState({ belongingsOpen: false }),
    });
  }

  usePublishPanels(engine, panels, hidden);

  return <PanelLayer engine={engine} panels={panels} hidden={hidden} />;
}

/**
 * 自分が開いているパネルの公開用の情報を送る（他の人の空間に、自分の前に並んだパネルとして見える）。
 * 内容はサーバーが受け手の権限を確かめてから渡す。
 */
function usePublishPanels(engine: SessionEngine, panels: PanelSpec[], hidden: boolean) {
  const client = useApp((s) => s.client);
  const ids = panels.map((p) => `${p.id}:${p.title}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: パネルの組み合わせ（ids）が変わったときだけ作り直す
  useEffect(() => {
    let last = "";
    const publish = () => {
      const ws = useWorkspace.getState();
      const list: PanelPublic[] = hidden
        ? []
        : panels.map((p) => {
            const t = engine.panels.transformOf(p.id);
            return {
              id: p.id,
              title: p.title,
              workspaceId: p.id === "ws-start" ? null : ws.workspaceId,
              mode: t ? "3d" : "2d",
              transform: t ?? null,
              lines: summarize(p.id),
            };
          });
      const key = JSON.stringify(list);
      if (key === last) return;
      last = key;
      client.send({ t: "panels", panels: list });
    };
    publish();
    const timer = setInterval(publish, 500);
    const off = client.onWelcome(() => {
      last = "";
      publish();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [engine, client, ids, hidden]);
}

function WorkspaceStart() {
  const session = useApp((s) => s.session);
  const error = useWorkspace((s) => s.error);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const ws = useWorkspace.getState();
  const list = session?.workspaces ?? [];

  return (
    <div className={ui.section}>
      {workspaceId && <p className={ui.muted}>ワークスペースを受け取っています…</p>}
      {error && <p className={ui.error}>{error}</p>}
      <h3 className={ui.sectionTitle}>このセッションのワークスペース</h3>
      {list.length === 0 ? (
        <p className={ui.muted}>まだありません。作るとほかの参加者も開けます。</p>
      ) : (
        <ul className={ui.list}>
          {list.map((w) => (
            <li key={w.id}>
              <button type="button" className={ui.item} onClick={() => ws.open(w.id)}>
                <span className={ui.itemName}>{w.name}</span>
                <span className={ui.badge}>
                  {w.present.length}人{w.defaultRole === null ? " · 非公開" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <OpenFromProject />
      <div className={ui.toolbar}>
        <button
          type="button"
          className={ui.btnPrimary}
          onClick={() => ws.create("銃と的", gunAndTargetSample())}
        >
          ＋ サンプル「銃と的」で作る
        </button>
        <button type="button" className={ui.btn} onClick={() => ws.create("銃", gunSample())}>
          ＋ サンプル「銃」
        </button>
        <button
          type="button"
          className={ui.btn}
          onClick={() => ws.create("射撃場", targetRangeSample())}
        >
          ＋ サンプル「射撃場」
        </button>
        <button
          type="button"
          className={ui.btn}
          onClick={() => ws.create("新しいワークスペース", emptyProject("新しいワークスペース"))}
        >
          ＋ 空のワークスペース
        </button>
      </div>
    </div>
  );
}

/** 自分の（または公開されている）プロジェクトを、このセッションのワークスペースとして開く */
function OpenFromProject() {
  const me = useApp((s) => s.me);
  const [repos, setRepos] = useState<RepoMeta[]>([]);
  useEffect(() => {
    if (me) void api.repos().then(setRepos);
  }, [me]);
  if (repos.length === 0) return null;
  const mine = repos.filter((r) => r.owner === me?.id);
  const others = repos.filter((r) => r.owner !== me?.id);
  return (
    <>
      <h3 className={ui.sectionTitle}>プロジェクトから開く</h3>
      <ul className={ui.list} aria-label="プロジェクト">
        {[...mine, ...others].slice(0, 8).map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={ui.item}
              onClick={() => useWorkspace.getState().openRepo(r.id)}
            >
              <span className={ui.itemName}>{r.name}</span>
              <span className={ui.badge}>{r.owner === me?.id ? "自分" : r.ownerName}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
