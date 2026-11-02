import { NEW_SYSTEM_CODE } from "@tukurium/repo-model";
import { useState } from "react";
import { type Selection, useWorkspace } from "./store";
import ui from "./ui.module.css";

type Tab = "koko" | "system" | "material";

const TABS: { id: Tab; label: string }[] = [
  { id: "koko", label: "KokoState" },
  { id: "system", label: "System" },
  { id: "material", label: "Material" },
];

/** Resources：リポジトリの KokoState 定義・System・マテリアル（アウトプット間で共有） */
export function ResourcesPanel() {
  const { project, selection, select, openSystem, mode } = useWorkspace();
  useWorkspace((s) => s.rev);
  const [tab, setTab] = useState<Tab>("koko");
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = mode === "edit";

  const items: { id: string; name: string; sub: string; kind: Tab }[] =
    tab === "koko"
      ? project
          .registry()
          .all()
          .filter((d) => !d.builtin)
          .map((d) => ({
            id: d.id,
            name: d.name,
            sub: `${d.fields.length} fields`,
            kind: "koko",
          }))
      : tab === "system"
        ? project.systems().map((s) => ({ id: s.id, name: s.name, sub: "Script", kind: "system" }))
        : project
            .materials()
            .map((m) => ({ id: m.id, name: m.name, sub: m.color.toUpperCase(), kind: "material" }));

  const builtins =
    tab === "koko"
      ? project
          .registry()
          .all()
          .filter((d) => d.builtin)
      : [];

  const create = (kind: "koko" | "script" | "material") => {
    setMenu(false);
    setError(null);
    try {
      if (kind === "koko") {
        let n = 1;
        const taken = (name: string) => project.registry().idOf(name) !== undefined;
        while (taken(`NewKokoState${n}`)) n++;
        const id = project.addKokoState(`NewKokoState${n}`);
        setTab("koko");
        select({ kind: "koko", id });
      } else if (kind === "script") {
        const id = project.addSystem(`NewSystem${project.systems().length + 1}`, NEW_SYSTEM_CODE);
        setTab("system");
        select({ kind: "system", id });
        openSystem(id);
      } else {
        const id = project.addMaterial(`Material${project.materials().length + 1}`);
        setTab("material");
        select({ kind: "material", id });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isSelected = (kind: Tab, id: string) =>
    selection?.kind === kind && (selection as Extract<Selection, { kind: Tab }>).id === id;

  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <div className={ui.tabs} role="tablist" aria-label="リソースの種類">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className={ui.tab}
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className={ui.btn}
              aria-haspopup="menu"
              aria-expanded={menu}
              disabled={!editing}
              onClick={() => setMenu((v) => !v)}
            >
              ＋ New
            </button>
            {menu && (
              <ul className={ui.menu} style={{ right: 0, top: 34 }}>
                <li>
                  <button type="button" className={ui.menuItem} onClick={() => create("koko")}>
                    KokoState<small>独自のデータ（フィールド）を定義する</small>
                  </button>
                </li>
                <li>
                  <button type="button" className={ui.menuItem} onClick={() => create("script")}>
                    Script（JavaScript）<small>コードで振る舞いを書く System</small>
                  </button>
                </li>
                <li>
                  <button type="button" className={ui.menuItem} onClick={() => create("material")}>
                    Material<small>色・粗さ・金属感</small>
                  </button>
                </li>
                <li>
                  <button type="button" className={ui.menuItem} disabled>
                    Node System（準備中）<small>ノードで振る舞いを組む</small>
                  </button>
                </li>
                <li>
                  <button type="button" className={ui.menuItem} disabled>
                    Shader（準備中）<small>独自のシェーダー</small>
                  </button>
                </li>
                <li>
                  <button type="button" className={ui.menuItem} disabled>
                    画像・音声・GLB の取り込み（準備中）<small>M3 で対応</small>
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>
        {error && <p className={ui.error}>{error}</p>}
        <ul className={ui.list}>
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className={ui.item}
                aria-current={isSelected(it.kind, it.id) || undefined}
                onClick={() => select({ kind: it.kind, id: it.id })}
                onDoubleClick={() => it.kind === "system" && openSystem(it.id)}
              >
                <span className={ui.itemName}>{it.name}</span>
                <span className={ui.badge}>{it.sub}</span>
              </button>
            </li>
          ))}
        </ul>
        {items.length === 0 && <p className={ui.empty}>＋ New から作れます</p>}
        {tab === "system" && items.length > 0 && (
          <p className={ui.muted}>ダブルクリックでコードを開きます</p>
        )}
      </div>
      {builtins.length > 0 && (
        <div className={ui.section}>
          <h3 className={ui.sectionTitle}>Built-in</h3>
          <ul className={ui.list}>
            {builtins.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className={ui.item}
                  aria-current={isSelected("koko", d.id) || undefined}
                  onClick={() => select({ kind: "koko", id: d.id })}
                >
                  <span className={ui.itemName}>{d.name}</span>
                  <span className={ui.badge}>Built-in</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
