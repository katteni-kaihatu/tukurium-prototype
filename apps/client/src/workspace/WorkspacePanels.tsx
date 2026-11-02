import { PanelLayer, type PanelSpec } from "../panels/PanelLayer";
import type { SessionEngine } from "../session/SessionEngine";
import { EditorPanel } from "./EditorPanel";
import { InspectorPanel } from "./InspectorPanel";
import { MainPanel } from "./MainPanel";
import { ResourcesPanel } from "./ResourcesPanel";
import { useWorkspace } from "./store";

const MAIN: PanelSpec = {
  id: "ws-main",
  title: "ワークスペース",
  initial: { x: 16, y: 84, width: 560 },
  render: () => <MainPanel />,
};

const INSPECTOR: PanelSpec = {
  id: "ws-inspector",
  title: "Inspector",
  initial: { x: 16, y: 264, width: 600 },
  render: () => <InspectorPanel />,
};

const RESOURCES: PanelSpec = {
  id: "ws-resources",
  title: "Resources",
  initial: { right: 16, y: 84, width: 380 },
  render: () => <ResourcesPanel />,
};

/** ワークスペースのパネル一式。コードを開いているときだけエディタを出す。 */
export function WorkspacePanels({ engine }: { engine: SessionEngine }) {
  const hasEditor = useWorkspace((s) => s.openSystems.length > 0);
  const hidden = useWorkspace((s) => s.panelsHidden);
  const panels: PanelSpec[] = [MAIN, INSPECTOR, RESOURCES];
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
  return <PanelLayer engine={engine} panels={panels} hidden={hidden} />;
}
