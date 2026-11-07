import {
  emptyProject,
  forestSample,
  gunAndTargetSample,
  gunSample,
  marubatsuSample,
  targetRangeSample,
} from "@tukurium/repo-model";
import type { PanelPublic } from "@tukurium/shared";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import { beginEditing } from "../main-menu/editing";
import { useMainMenu } from "../main-menu/store";
import { api, type RepoMeta } from "../net/api";
import { DrawerSlot } from "../panels/drawerSlot";
import { PanelLayer, type PanelSpec, panelViewportInsets } from "../panels/PanelLayer";
import { BagPanel } from "../session/BagPanel";
import { SessionBelongings } from "../session/SessionBelongings";
import type { SessionEngine } from "../session/SessionEngine";
import { DetailPanel, ResourceDetailDrawer } from "./DefinitionProperties";
import { EditorPanel } from "./EditorPanel";
import { HistoryPanel } from "./HistoryPanel";
import { useCanEdit } from "./hooks";
import { ImportPanel } from "./ImportPanel";
import { InspectorPanel } from "./InspectorPanel";
import { KokoPickerPanel } from "./KokoPickerPanel";
import { LogPanel } from "./LogPanel";
import { MainPanel } from "./MainPanel";
import { MembersPanel } from "./MembersPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { ResourcesPanel } from "./ResourcesPanel";
import { createReferenceSample } from "./referenceSample";
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
  // 高さはここで固定する。選んだ Entity の項目の数では変えない（中でスクロールする）。
  // 上端はワークスペースの下。画面が足りないときは、下端が収まるよう縮む（ADR 0048）
  initial: { x: 16, y: 470, width: 600, height: 800 },
  render: () => <InspectorPanel />,
};

const RESOURCES: PanelSpec = {
  id: "ws-resources",
  title: "Resources",
  initial: { right: 16, y: 84, width: 600 },
  render: () => <ResourcesPanel />,
};

/** 編集パネルは、本人がワークスペースを開いている間だけ出す。 */
export function WorkspacePanels({ engine }: { engine: SessionEngine }) {
  const workspaceRecall = useMainMenu((s) => s.workspaceRecall);
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
  const belongingsOpen = useWorkspace((s) => s.belongingsOpen);
  const bagOpen = useWorkspace((s) => s.bagOpen);
  const sessionOpen = useWorkspace((s) => s.sessionOpen);
  const inspectorOpen = useWorkspace((s) => s.inspectorOpen);
  const resourcesOpen = useWorkspace((s) => s.resourcesOpen);
  const problemsOpen = useWorkspace((s) => s.problemsOpen);
  const problemsFocus = useWorkspace((s) => s.problemsFocus);
  const logOpen = useWorkspace((s) => s.logOpen);
  const importOpen = useWorkspace((s) => s.importOpen);
  const detail = useWorkspace((s) => s.detail);
  const kokoPickerOpen = useWorkspace((s) => s.kokoPickerOpen);
  const resourceDetailOpen = useWorkspace((s) => s.resourceDetailOpen);
  const saveSideOpen = useWorkspace((s) => s.saveSideOpen);
  const historySideOpen = useWorkspace((s) => s.historySideOpen);
  const canEdit = useCanEdit();
  const editMode = useWorkspace((s) => s.mode === "edit");
  const panels: PanelSpec[] = [];
  if (ready) {
    if (saveOpen) {
      panels.push({
        id: "ws-save",
        title: "保存",
        initial: { x: 36, y: 168, width: 440, height: 560 },
        focusKey: saveSeq,
        render: () => <SavePanel />,
        drawer: {
          title: "差分の中身",
          width: 480,
          open: saveSideOpen,
          onToggle: (open) => useWorkspace.setState({ saveSideOpen: open }),
          render: () => <DrawerSlot name="ws-save" />,
        },
        onClose: () => useWorkspace.setState({ saveOpen: false }),
      });
    }
    if (historyOpen) {
      panels.push({
        id: "ws-history",
        title: "履歴",
        initial: { x: 180, y: 168, width: 720, height: 560 },
        render: () => <HistoryPanel />,
        drawer: {
          title: "差分の中身",
          width: 520,
          open: historySideOpen,
          onToggle: (open) => useWorkspace.setState({ historySideOpen: open }),
          render: () => <DrawerSlot name="ws-history" />,
        },
        onClose: () => useWorkspace.setState({ historyOpen: false }),
      });
    }
    panels.push({
      ...MAIN,
      recallKey: workspaceRecall || undefined,
      focusKey: workspaceRecall || undefined,
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
        // KokoState を追加するのは、Inspector にくっついた付属パネル（ADR 0044・0048）
        drawer:
          canEdit && editMode
            ? {
                title: "KokoState を追加",
                width: 520,
                open: kokoPickerOpen,
                onToggle: (open) => useWorkspace.setState({ kokoPickerOpen: open }),
                render: () => <KokoPickerPanel />,
              }
            : undefined,
        onClose: () => useWorkspace.setState({ inspectorOpen: false }),
      });
    }
    if (resourcesOpen) {
      panels.push({
        ...RESOURCES,
        // Resources で選んだものの詳細は、Resources にくっついた付属パネルに出す（ADR 0044）
        drawer: {
          title: "リソースの詳細",
          width: 420,
          open: resourceDetailOpen,
          onToggle: (open) => useWorkspace.setState({ resourceDetailOpen: open }),
          render: () => <ResourceDetailDrawer />,
        },
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
    if (importOpen) {
      panels.push({
        id: "ws-import",
        title: "ほかのプロジェクトから取り込む",
        initial: { x: 200, y: 140, width: 860, height: 560 },
        focusKey: "import",
        render: () => <ImportPanel />,
        onClose: () => useWorkspace.setState({ importOpen: false }),
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

  if (bagOpen) {
    panels.push({
      id: "session-bag",
      title: "バッグ",
      initial: { right: 16, y: 420, width: 360 },
      focusKey: "bag",
      render: () => <BagPanel />,
      onClose: () => useWorkspace.setState({ bagOpen: false }),
    });
  }

  usePublishPanels(engine, panels, hidden);
  const leftOffset = panelViewportInsets().left - 16;

  return (
    <PanelLayer
      engine={engine}
      panels={panels.map((panel) => ({
        ...panel,
        initial: {
          ...panel.initial,
          ...(panel.initial.x == null ? {} : { x: panel.initial.x + leftOffset }),
        },
        onActivate: () => useMainMenu.setState({ activeWindow: null }),
      }))}
      hidden={hidden}
    />
  );
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
              ...panelGeometry(engine, p.id, !t),
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

/**
 * パネルの大きさ（px）と、2D 表示なら画面（3D の描画領域）の中の中心の位置。
 * 3D 表示の要素は空間に置いて変形しているので、変形の前の大きさ（offsetWidth）を使う。
 */
function panelGeometry(
  engine: SessionEngine,
  id: string,
  flat: boolean,
): Pick<PanelPublic, "size" | "screen"> {
  const el = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);
  const clamp = (v: number) => Math.round(Math.min(4000, Math.max(1, v)));
  const size = { width: clamp(el?.offsetWidth || 420), height: clamp(el?.offsetHeight || 280) };
  if (!flat || !el) return { size, screen: null };
  const rect = el.getBoundingClientRect();
  const view = engine.renderer.domElement.getBoundingClientRect();
  if (view.width < 1 || view.height < 1) return { size, screen: null };
  return {
    size,
    screen: {
      x: Math.round(rect.left + rect.width / 2 - view.left),
      y: Math.round(rect.top + rect.height / 2 - view.top),
      viewWidth: Math.round(view.width),
      viewHeight: Math.round(view.height),
    },
  };
}

export function WorkspaceStart() {
  const session = useApp((s) => s.session);
  const error = useWorkspace((s) => s.error);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const ws = useWorkspace.getState();
  const pending = useMainMenu((s) => s.editingPending);
  const list = session?.workspaces ?? [];

  return (
    <fieldset
      className={ui.section}
      disabled={pending}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
    >
      {workspaceId && (
        <button type="button" className={ui.btn} onClick={() => ws.leave()}>
          ワークスペースを閉じる
        </button>
      )}
      {error && <p className={ui.error}>{error}</p>}
      <h3 className={ui.sectionTitle}>このセッションのワークスペース</h3>
      {list.length === 0 ? (
        <p className={ui.muted}>まだありません。作るとほかの参加者も開けます。</p>
      ) : (
        <ul className={ui.list} aria-label="このセッションのワークスペース">
          {list.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                className={ui.item}
                onClick={() => beginEditing(() => ws.open(w.id), w.id)}
              >
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
          onClick={() => beginEditing(() => ws.create("銃と的", gunAndTargetSample()))}
        >
          ＋ サンプル「銃と的」で作る
        </button>
        <button
          type="button"
          className={ui.btn}
          title="的の hp と Damage の受け取りを、公式ライブラリ「combat」に任せた銃と的"
          onClick={() => {
            beginEditing(() => createReferenceSample("gunAndTarget"));
          }}
        >
          ＋ サンプル「銃と的（公式）」
        </button>
        <button
          type="button"
          className={ui.btn}
          title="E で押すと扉が開くスイッチ。押されて切り替わる仕組みは公式ライブラリ「interaction」"
          onClick={() => {
            beginEditing(() => createReferenceSample("doorAndSwitch"));
          }}
        >
          ＋ サンプル「扉とスイッチ」
        </button>
        <button
          type="button"
          className={ui.btn}
          title="E で鍵を拾ってバッグに入れ、鍵のかかった扉を開ける。拾う仕組みと鍵の種類は公式ライブラリ「items」"
          onClick={() => {
            beginEditing(() => createReferenceSample("keyAndDoor"));
          }}
        >
          ＋ サンプル「鍵と扉」
        </button>
        <button
          type="button"
          className={ui.btn}
          onClick={() => beginEditing(() => ws.create("銃", gunSample()))}
        >
          ＋ サンプル「銃」
        </button>
        <button
          type="button"
          className={ui.btn}
          onClick={() => beginEditing(() => ws.create("射撃場", targetRangeSample()))}
        >
          ＋ サンプル「射撃場」
        </button>
        <button
          type="button"
          className={ui.btn}
          onClick={() => beginEditing(() => ws.create("森", forestSample()))}
        >
          ＋ サンプル「森」
        </button>
        <button
          type="button"
          className={ui.btn}
          title="クリックで○×。近くで E を押すと最初から"
          onClick={() => beginEditing(() => ws.create("マルバツ", marubatsuSample()))}
        >
          ＋ サンプル「マルバツ」
        </button>
        <button
          type="button"
          className={ui.btn}
          onClick={() =>
            beginEditing(() =>
              ws.create("新しいワークスペース", emptyProject("新しいワークスペース")),
            )
          }
        >
          ＋ 空のワークスペース
        </button>
      </div>
    </fieldset>
  );
}

/** 自分の（または公開されている）プロジェクトを、このセッションのワークスペースとして開く */
function OpenFromProject() {
  const me = useApp((s) => s.me);
  const [repos, setRepos] = useState<RepoMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (me)
      void api.repos().then(
        (value) => {
          if (active) setRepos(value);
        },
        (reason: Error) => {
          if (active) setError(reason.message);
        },
      );
    return () => {
      active = false;
    };
  }, [me]);
  if (error) return <p className={ui.error}>{error}</p>;
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
              onClick={() => beginEditing(() => useWorkspace.getState().openRepo(r.id))}
            >
              <Thumbnail id={r.thumbnail} name={r.name} size="small" />
              <span className={ui.itemName}>{r.name}</span>
              <span className={ui.badge}>{r.owner === me?.id ? "自分" : r.ownerName}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
