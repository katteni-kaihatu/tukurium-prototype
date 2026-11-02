import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab } from "y-codemirror.next";
import { useProject } from "./hooks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/**
 * System のコードエディタ。CodeMirror を制作データの Y.Text に結びつける
 * （M2 でそのまま共同編集・カーソル共有になる）。
 */
export function EditorPanel() {
  const { openSystems, activeSystem, openSystem, closeSystem, systemStatus, mode } = useWorkspace();
  const project = useProject();
  useWorkspace((s) => s.rev);
  const status = systemStatus.find((s) => s.id === activeSystem);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className={ui.section} style={{ paddingTop: 6, paddingBottom: 6 }}>
        <div className={ui.tabs} role="tablist" aria-label="開いているコード">
          {openSystems.map((id) => (
            <span key={id} style={{ display: "inline-flex", alignItems: "center" }}>
              <button
                type="button"
                role="tab"
                className={ui.tab}
                aria-selected={activeSystem === id}
                onClick={() => openSystem(id)}
              >
                {project.system(id)?.name ?? id}.js
              </button>
              <button
                type="button"
                className={ui.iconBtn}
                aria-label={`${project.system(id)?.name ?? id} を閉じる`}
                onClick={() => closeSystem(id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        {status?.error && <p className={ui.error}>{status.error}</p>}
        <p className={ui.muted}>
          {mode === "edit"
            ? "変更は次の Play から反映されます。"
            : "Play 中の変更は、Stop して Play し直すと反映されます。"}
        </p>
      </div>
      {activeSystem && <CodeView key={activeSystem} systemId={activeSystem} />}
    </div>
  );
}

function CodeView({ systemId }: { systemId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const project = useProject();
  const awareness = useWorkspace((s) => s.awareness);
  const role = useWorkspace((s) => s.role);
  const readOnly = role === "viewer";

  useEffect(() => {
    const text = project.code(systemId);
    if (!host.current || !text) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          basicSetup,
          javascript(),
          // カーソル・選択の共有（awareness は閲覧権限のある人にだけ中継される）
          yCollab(text, awareness),
          EditorState.readOnly.of(readOnly),
          EditorView.theme({
            "&": { fontSize: "12.5px", height: "100%" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
            ".cm-gutters": { background: "#f6f2ec", border: "none" },
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [project, systemId, awareness, readOnly]);

  return (
    <div
      ref={host}
      style={{
        height: 420,
        overflow: "hidden",
        borderTop: "1px solid rgba(38,38,46,.08)",
        background: "#fff",
      }}
    />
  );
}
