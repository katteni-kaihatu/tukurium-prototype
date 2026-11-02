import { NEW_SYSTEM_CODE } from "@tukurium/repo-model";
import { useRef, useState } from "react";
import { ASSET_ACCEPT, assetUrl, uploadAsset } from "./assets";
import { useCanEdit, useProject } from "./hooks";
import { type Selection, useWorkspace } from "./store";
import ui from "./ui.module.css";

type Tab = "koko" | "system" | "material" | "asset";

const TABS: { id: Tab; label: string }[] = [
  { id: "koko", label: "KokoState" },
  { id: "system", label: "System" },
  { id: "material", label: "Material" },
  { id: "asset", label: "素材" },
];

const KIND_LABEL: Record<string, string> = { model: "GLB", image: "画像", audio: "音声" };

/** Resources：リポジトリの KokoState 定義・System・マテリアル（アウトプット間で共有） */
export function ResourcesPanel() {
  const { selection, select, openSystem } = useWorkspace();
  const project = useProject();
  const canEdit = useCanEdit();
  useWorkspace((s) => s.rev);
  const [tab, setTab] = useState<Tab>("koko");
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = canEdit;

  const items: { id: string; name: string; sub: string; kind: Exclude<Tab, "asset"> }[] =
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
      : tab === "asset"
        ? []
        : tab === "system"
          ? project
              .systems()
              .map((s) => ({ id: s.id, name: s.name, sub: "Script", kind: "system" }))
          : project.materials().map((m) => ({
              id: m.id,
              name: m.name,
              sub: m.color.toUpperCase(),
              kind: "material",
            }));

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
        {tab === "asset" ? (
          <AssetSection editing={editing} />
        ) : (
          items.length === 0 && <p className={ui.empty}>＋ New から作れます</p>
        )}
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

/** 素材（GLB・画像・音声）：取り込みと一覧。中身はサーバーに置き、制作データには ID と名前だけを入れる */
function AssetSection({ editing }: { editing: boolean }) {
  const project = useProject();
  useWorkspace((s) => s.rev);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assets = project.assets();

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) project.addAsset(await uploadAsset(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <div className={ui.toolbar}>
        <input
          ref={input}
          type="file"
          accept={ASSET_ACCEPT}
          multiple
          hidden
          aria-label="素材ファイルを選ぶ"
          onChange={(e) => void onFiles(e.target.files)}
        />
        <button
          type="button"
          className={ui.btn}
          disabled={!editing || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "取り込み中…" : "＋ 素材を取り込む"}
        </button>
        <span className={ui.muted}>
          GLB・PNG・JPEG・WebP・MP3・OGG・WAV（1 ファイル 20MB まで）
        </span>
      </div>
      {error && <p className={ui.error}>{error}</p>}
      {assets.length === 0 ? (
        <p className={ui.empty}>まだありません</p>
      ) : (
        <ul className={ui.list} aria-label="素材">
          {assets.map((a) => (
            <li key={a.id} className={ui.item} style={{ cursor: "default" }}>
              {a.kind === "image" && (
                <img
                  src={assetUrl(a.id)}
                  alt=""
                  width={28}
                  height={28}
                  style={{ objectFit: "cover", borderRadius: 4 }}
                />
              )}
              <span className={ui.itemName}>{a.name}</span>
              <span className={ui.badge}>{KIND_LABEL[a.kind] ?? a.kind}</span>
              {a.kind === "audio" && (
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`${a.name} を試聴`}
                  onClick={() => void new Audio(assetUrl(a.id)).play()}
                >
                  ▶
                </button>
              )}
              {editing && (
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`${a.name} を外す`}
                  onClick={() => project.removeAsset(a.id)}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className={ui.muted}>
        GLB は Mesh の model、画像はマテリアルの「画像」、音声は AudioSource の clip
        か、スクリプトの audio.play("名前", e.id) で使えます。
      </p>
    </>
  );
}
