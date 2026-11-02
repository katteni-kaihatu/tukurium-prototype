import { emptyProject, gunAndTargetSample } from "@tukurium/repo-model";
import type { PanelPublic } from "@tukurium/shared";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { PanelLayer, type PanelSpec } from "../panels/PanelLayer";
import type { SessionEngine } from "../session/SessionEngine";
import { EditorPanel } from "./EditorPanel";
import { InspectorPanel } from "./InspectorPanel";
import { MainPanel } from "./MainPanel";
import { MembersPanel } from "./MembersPanel";
import { ResourcesPanel } from "./ResourcesPanel";
import { useWorkspace } from "./store";
import { summarize } from "./summary";
import ui from "./ui.module.css";

const MAIN: PanelSpec = {
  id: "ws-main",
  title: "ワークスペース",
  initial: { x: 16, y: 84, width: 560 },
  render: () => <MainPanel />,
};

const INSPECTOR: PanelSpec = {
  id: "ws-inspector",
  title: "Inspector",
  initial: { x: 16, y: 284, width: 600 },
  render: () => <InspectorPanel />,
};

const RESOURCES: PanelSpec = {
  id: "ws-resources",
  title: "Resources",
  initial: { right: 16, y: 84, width: 380 },
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
  const hidden = useWorkspace((s) => s.panelsHidden);
  const [members, setMembers] = useState(false);

  const panels: PanelSpec[] = [];
  if (!ready) {
    panels.push(START);
  } else {
    panels.push(
      {
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
      },
      INSPECTOR,
      RESOURCES,
    );
    if (hasEditor) {
      panels.push({
        id: "ws-editor",
        title: "コード",
        initial: { x: 640, y: 160, width: 640 },
        render: () => <EditorPanel />,
        onClose: () => {
          const ws = useWorkspace.getState();
          for (const id of ws.openSystems) ws.closeSystem(id);
        },
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
      <div className={ui.toolbar}>
        <button
          type="button"
          className={ui.btnPrimary}
          onClick={() => ws.create("銃と的", gunAndTargetSample())}
        >
          ＋ サンプル「銃と的」で作る
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
