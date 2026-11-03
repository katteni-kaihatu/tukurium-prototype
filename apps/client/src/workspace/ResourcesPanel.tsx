import { NEW_SYSTEM_CODE } from "@tukurium/repo-model";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { ASSET_ACCEPT, assetUrl, uploadAsset } from "./assets";
import { useCanEdit, useProject } from "./hooks";
import styles from "./ResourcesPanel.module.css";
import {
  BUILTIN_FOLDER,
  KIND_META,
  type ResItem,
  type ResKind,
  resourceItems,
  sortItems,
  usageOf,
} from "./resourceItems";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useProblems, useProjectDiagnostics } from "./useProblems";

type View = "icon" | "list" | "detail";
const VIEWS: { id: View; label: string }[] = [
  { id: "icon", label: "アイコン" },
  { id: "list", label: "一覧" },
  { id: "detail", label: "詳細" },
];
const VIEW_KEY = "tukurium.resources.view";

const loadView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "detail" ? v : "icon";
  } catch {
    return "icon";
  }
};

/**
 * Resources：リポジトリの KokoState 定義・System・マテリアル・素材（アウトプット間で共有）。
 * デザインどおり、左にフォルダの木、右にいまのフォルダの中身を並べる。
 * - クリックで選ぶ（Inspector に出る）、ダブルクリックで開く（フォルダに入る・コードを開く）
 * - ドラッグして、フォルダ（木か中身のフォルダ）へ移せる
 * - フォルダは並べ方だけの情報で、実行には関わらない（コミットには入る）
 */
export function ResourcesPanel() {
  const { selection, select, openSystem, placeEditor } = useWorkspace();
  const project = useProject();
  const editing = useCanEdit();
  const problems = useProblems();
  const { summary } = useProjectDiagnostics();
  const rev = useWorkspace((s) => s.rev);
  const [cwd, setCwd] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(loadView);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  const all = useMemo(() => resourceItems(project), [project, rev]);
  const byId = new Map(all.map((x) => [x.id, x]));
  // 消えたフォルダにいたら、いちばん上へ
  const here = cwd && byId.get(cwd)?.kind === "folder" ? cwd : null;
  const readOnlyHere = here === BUILTIN_FOLDER;
  const kids = (parent: string | null) => sortItems(all.filter((x) => x.parent === parent));
  const folderKids = (parent: string | null) => kids(parent).filter((x) => x.kind === "folder");

  const crumbs: { id: string | null; name: string }[] = [{ id: null, name: project.name }];
  const chain: ResItem[] = [];
  for (let c = here ? byId.get(here) : undefined; c; c = c.parent ? byId.get(c.parent) : undefined)
    chain.unshift(c);
  for (const c of chain) crumbs.push({ id: c.id, name: c.name });
  const ancestors = new Set(chain.map((c) => c.id));

  const query = q.trim();
  const list: ResItem[] = query
    ? (() => {
        const out: ResItem[] = [];
        const walk = (pid: string | null) => {
          for (const x of kids(pid)) {
            if (x.name.toLowerCase().includes(query.toLowerCase())) out.push(x);
            if (x.kind === "folder") walk(x.id);
          }
        };
        walk(here);
        return out;
      })()
    : kids(here);

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // 覚えられなくても表示はできる
    }
  };

  const go = (id: string | null) => {
    setCwd(id);
    setSel(null);
    setQ("");
    if (id) setOpened((o) => ({ ...o, [id]: true }));
  };

  /**
   * 問題の印。自分の問題（塗りつぶし）と、中や関係するものの問題（輪郭）を分ける。
   * スクリプトの問題（構文など）は System 自身の問題に数える。
   */
  const badgeOf = (it: ResItem): Badge | null => {
    const s = summary.get(it.id);
    const script = it.kind === "system" ? problems.filter((p) => p.systemId === it.id).length : 0;
    const errors = (s?.errors ?? 0) + script;
    if (errors > 0) return { tone: "error", label: `エラー ${errors} 件` };
    if (s?.warnings) return { tone: "warning", label: `注意 ${s.warnings} 件` };
    if (s?.nestedErrors)
      return { tone: "nestedError", label: `中や関係するものにエラー ${s.nestedErrors} 件` };
    if (s?.nestedWarnings)
      return { tone: "nestedWarning", label: `中や関係するものに注意 ${s.nestedWarnings} 件` };
    return null;
  };
  const kindText = (it: ResItem) => {
    const b = badgeOf(it);
    return b?.tone === "error"
      ? "エラー"
      : b?.tone === "warning"
        ? "注意"
        : KIND_META[it.kind].label;
  };

  const pick = (it: ResItem) => {
    setSel(it.id);
    if (it.kind === "koko" || it.kind === "builtin") select({ kind: "koko", id: it.id });
    else if (it.kind === "system") select({ kind: "system", id: it.id });
    else if (it.kind === "material") select({ kind: "material", id: it.id });
  };
  /** このパネルが 3D ならコードも 3D、2D なら 2D で開く */
  const openCode = (id: string) => {
    const mode =
      root.current?.closest("[data-mode]")?.getAttribute("data-mode") === "3d" ? "3d" : "2d";
    placeEditor(mode);
    openSystem(id);
  };
  const open = (it: ResItem) => {
    if (it.kind === "folder") go(it.id);
    else if (it.kind === "system") openCode(it.id);
    else pick(it);
  };
  // ここで選んだもの。まだ何も選んでいなければ、Inspector で選んでいるもの
  const isSelected = (it: ResItem) =>
    sel !== null ? sel === it.id : selection !== null && selection.id === it.id;

  /** 作ったものは、いまのフォルダに入れる */
  const placeHere = (id: string) => {
    if (here && !readOnlyHere) project.moveResource(id, here);
  };
  const create = (kind: "folder" | "koko" | "script" | "material") => {
    setNewOpen(false);
    setError(null);
    // 作ったものを入れるフォルダ。そこで空いている名前を付ける（同じ場所で名前がぶつからないように）
    const target = readOnlyHere ? null : here;
    const numbered = (b: string, n: number) => `${b}${n}`;
    try {
      if (kind === "folder") {
        const id = project.addFolder(project.freeName("新しいフォルダ", target), target);
        setSel(id);
        setRenaming(id);
      } else if (kind === "koko") {
        // KokoState の名前は、いまはプロジェクト全体でも一つ（Registry の決まり）
        let n = 1;
        const taken = (name: string) =>
          project.registry().idOf(name) !== undefined || project.siblingNameTaken(name, target);
        while (taken(`NewKokoState${n}`)) n++;
        const id = project.addKokoState(`NewKokoState${n}`);
        placeHere(id);
        pick({ id, kind: "koko", name: "", parent: here });
      } else if (kind === "script") {
        const id = project.addSystem(
          project.freeName("NewSystem", target, numbered),
          NEW_SYSTEM_CODE,
        );
        placeHere(id);
        pick({ id, kind: "system", name: "", parent: here });
        openCode(id);
      } else {
        const id = project.addMaterial(project.freeName("Material", target, numbered));
        placeHere(id);
        pick({ id, kind: "material", name: "", parent: here });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const uploaded = await uploadAsset(f);
        const target = readOnlyHere ? null : here;
        // 同じ場所に同じ名前があれば、空いている名前にする
        const asset = project.siblingNameTaken(uploaded.name, target, uploaded.id)
          ? { ...uploaded, name: project.freeName(uploaded.name, target) }
          : uploaded;
        project.addAsset(asset);
        placeHere(asset.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // ---- ドラッグしてフォルダへ移す ----
  const canMove = (it: ResItem) => editing && it.kind !== "builtin" && it.id !== BUILTIN_FOLDER;
  const moveInto = (id: string, folder: string | null) => {
    const it = byId.get(id);
    if (!it || !canMove(it) || folder === BUILTIN_FOLDER || folder === id) return;
    if (project.siblingNameTaken(it.name, folder, id)) {
      setError(`移す先に「${it.name}」という名前があります`);
      return;
    }
    setError(null);
    if (it.kind === "folder") project.moveFolder(id, folder);
    else project.moveResource(id, folder);
  };
  const dragProps = (it: ResItem) =>
    canMove(it)
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData("application/x-tukurium-resource", it.id);
            e.dataTransfer.effectAllowed = "move";
          },
        }
      : {};
  const dropProps = (folder: string | null) =>
    editing && folder !== BUILTIN_FOLDER
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes("application/x-tukurium-resource")) return;
            e.preventDefault();
            // いちばん内側のフォルダだけが受け取る（中身の欄はいまのフォルダとして受け取る）
            e.stopPropagation();
            setDropTarget(folder ?? "__root");
          },
          onDragLeave: () => setDropTarget(null),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            const id = e.dataTransfer.getData("application/x-tukurium-resource");
            if (id) moveInto(id, folder);
          },
        }
      : {};
  const dropping = (folder: string | null) => dropTarget === (folder ?? "__root");

  // ---- フォルダの木 ----
  const tree: ReactNode[] = [];
  const walk = (id: string | null, name: string, depth: number) => {
    const subs = folderKids(id);
    const key = id ?? "__root";
    const isOpen = opened[key] ?? (id === null || ancestors.has(id));
    const current = here === id;
    const folderItem = id ? byId.get(id) : undefined;
    tree.push(
      <div
        key={key}
        className={styles.treeRow}
        data-current={current || undefined}
        data-drop={dropping(id) || undefined}
        style={{ paddingLeft: depth * 12 }}
        {...dropProps(id)}
      >
        {subs.length > 0 ? (
          <button
            type="button"
            className={styles.chev}
            aria-label={isOpen ? `${name} を閉じる` : `${name} を開く`}
            onClick={() => setOpened((o) => ({ ...o, [key]: !isOpen }))}
          >
            <Chevron open={isOpen} />
          </button>
        ) : (
          <span className={styles.chevSpace} />
        )}
        <button
          type="button"
          role="treeitem"
          aria-selected={current}
          className={styles.treeItem}
          onClick={() => go(id)}
        >
          <FolderIcon size={15} filled={current} />
          <span className={styles.treeLabel}>{name}</span>
          {folderItem && <BadgeDot badge={badgeOf(folderItem)} inline />}
        </button>
      </div>,
    );
    if (isOpen) for (const f of subs) walk(f.id, f.name, depth + 1);
  };
  walk(null, project.name, 0);

  const selected = sel ? byId.get(sel) : undefined;
  const assetSel = selected && ["model", "image", "audio"].includes(selected.kind);

  return (
    <div className={styles.root} ref={root}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolBtn}
          aria-label="ひとつ上のフォルダへ"
          title="ひとつ上へ"
          disabled={here === null}
          onClick={() => go(here ? (byId.get(here)?.parent ?? null) : null)}
        >
          <svg {...icon(16)} aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
        <nav aria-label="場所" className={styles.crumbs}>
          {crumbs.map((c, i) => (
            <span key={c.id ?? "__root"} className={styles.crumb}>
              {i > 0 && (
                <svg {...icon(12)} aria-hidden="true" className={styles.crumbSep}>
                  <path d="M9 6l6 6-6 6" />
                </svg>
              )}
              <button
                type="button"
                className={styles.crumbBtn}
                aria-current={i === crumbs.length - 1 ? "location" : undefined}
                onClick={() => go(c.id)}
                {...dropProps(c.id)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <label className={styles.search}>
          <svg {...icon(14)} aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            aria-label="このフォルダ内をさがす"
            placeholder="この中をさがす"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <fieldset className={styles.views} aria-label="表示形式">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={styles.viewBtn}
              aria-label={v.label}
              title={v.label}
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
            >
              <ViewIcon view={v.id} />
            </button>
          ))}
        </fieldset>
        <div className={styles.newWrap}>
          <button
            type="button"
            className={styles.newBtn}
            aria-haspopup="menu"
            aria-expanded={newOpen}
            disabled={!editing || readOnlyHere}
            onClick={() => setNewOpen((v) => !v)}
          >
            <svg {...icon(14, 2.4)} aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New
          </button>
          {newOpen && (
            <div role="menu" aria-label="新規作成" className={styles.menu}>
              <NewItem
                kind="folder"
                label="フォルダ"
                sub="中身を分けて整理する"
                onClick={() => create("folder")}
              />
              <NewItem
                kind="koko"
                label="KokoState"
                sub="独自のデータ（フィールド）を定義する"
                onClick={() => create("koko")}
              />
              <NewItem
                kind="system"
                label="Script"
                sub="コードで振る舞いを書く System"
                onClick={() => create("script")}
              />
              <NewItem
                kind="material"
                label="Material"
                sub="色・粗さ・金属感・画像"
                onClick={() => create("material")}
              />
              <NewItem
                kind="image"
                label="素材を取り込む"
                sub="GLB・PNG・JPEG・WebP・MP3・OGG・WAV（20MB まで）"
                onClick={() => {
                  setNewOpen(false);
                  fileInput.current?.click();
                }}
              />
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept={ASSET_ACCEPT}
            multiple
            hidden
            aria-label="素材ファイルを選ぶ"
            onChange={(e) => void onFiles(e.target.files)}
          />
        </div>
      </div>
      {error && <p className={ui.error}>{error}</p>}

      <div className={styles.body}>
        <div role="tree" aria-label="フォルダ" className={styles.tree}>
          {tree}
        </div>
        <section className={styles.content} aria-label="中身" {...dropProps(here)}>
          {busy && <p className={ui.muted}>取り込み中…</p>}
          {view === "icon" && (
            <div className={styles.grid}>
              {list.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={styles.tile}
                  aria-label={`${it.name}（${KIND_META[it.kind].label}）`}
                  aria-pressed={isSelected(it)}
                  data-drop={(it.kind === "folder" && dropping(it.id)) || undefined}
                  onClick={() => pick(it)}
                  onDoubleClick={() => open(it)}
                  {...dragProps(it)}
                  {...(it.kind === "folder" ? dropProps(it.id) : {})}
                >
                  <span
                    className={styles.thumb}
                    style={{ background: KIND_META[it.kind].bg, color: KIND_META[it.kind].fg }}
                  >
                    <KindIcon item={it} size={30} large />
                    <BadgeDot badge={badgeOf(it)} />
                  </span>
                  <span className={styles.tileName}>{it.name}</span>
                  <span className={styles.tileKind}>{kindText(it)}</span>
                </button>
              ))}
            </div>
          )}
          {view === "list" && (
            <div className={styles.rows}>
              {list.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={styles.row}
                  aria-label={`${it.name}（${KIND_META[it.kind].label}）`}
                  aria-pressed={isSelected(it)}
                  data-drop={(it.kind === "folder" && dropping(it.id)) || undefined}
                  onClick={() => pick(it)}
                  onDoubleClick={() => open(it)}
                  {...dragProps(it)}
                  {...(it.kind === "folder" ? dropProps(it.id) : {})}
                >
                  <SmallIcon item={it} />
                  <span className={styles.rowName}>{it.name}</span>
                  {query && (
                    <span className={styles.rowWhere}>
                      in {it.parent ? (byId.get(it.parent)?.name ?? "") : project.name}
                    </span>
                  )}
                  <span className={styles.rowKind}>{kindText(it)}</span>
                </button>
              ))}
            </div>
          )}
          {view === "detail" && (
            <section aria-label="詳細" className={styles.table}>
              <div className={styles.tableHead} aria-hidden="true">
                <span>Name</span>
                <span>Type</span>
                <span>Usage</span>
              </div>
              {list.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={styles.tableRow}
                  aria-label={`${it.name}（${KIND_META[it.kind].label}）`}
                  aria-pressed={isSelected(it)}
                  onClick={() => pick(it)}
                  onDoubleClick={() => open(it)}
                  {...dragProps(it)}
                  {...(it.kind === "folder" ? dropProps(it.id) : {})}
                >
                  <span className={styles.cellName}>
                    <SmallIcon item={it} />
                    <span className={styles.rowName}>{it.name}</span>
                  </span>
                  <span>{kindText(it)}</span>
                  <span className={styles.usage}>{usageOf(project, it, all)}</span>
                </button>
              ))}
            </section>
          )}
          {list.length === 0 && (
            <p className={styles.empty}>
              {query
                ? `「${query}」は見つかりません`
                : readOnlyHere
                  ? "Built-in はありません"
                  : "空のフォルダです。New から作るか、ここへドラッグして移せます"}
            </p>
          )}
        </section>
      </div>

      <div className={styles.footer}>
        <span>{list.length} 項目</span>
        {selected && renaming === selected.id ? (
          <input
            className={ui.input}
            aria-label="フォルダの名前"
            defaultValue={selected.name}
            // biome-ignore lint/a11y/noAutofocus: 名前を付け始めた直後に入力できるように
            autoFocus
            style={{ height: 26, width: 160 }}
            onBlur={(e) => {
              try {
                setError(null);
                project.renameFolder(selected.id, e.target.value);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          selected && <span className={styles.selLabel}>{selected.name}</span>
        )}
        {selected?.kind === "folder" && selected.id !== BUILTIN_FOLDER && editing && (
          <>
            <button
              type="button"
              className={styles.footBtn}
              onClick={() => setRenaming(selected.id)}
            >
              名前を変える
            </button>
            <button
              type="button"
              className={styles.footBtn}
              title="中身はひとつ上のフォルダへ移ります"
              onClick={() => {
                project.removeFolder(selected.id);
                setSel(null);
              }}
            >
              フォルダを消す
            </button>
          </>
        )}
        {selected?.kind === "audio" && (
          <button
            type="button"
            className={styles.footBtn}
            onClick={() => void new Audio(assetUrl(selected.id)).play()}
          >
            ▶ 試聴
          </button>
        )}
        {assetSel && editing && selected && (
          <button
            type="button"
            className={styles.footBtn}
            onClick={() => {
              project.removeAsset(selected.id);
              setSel(null);
            }}
          >
            素材を外す
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span className={styles.hint}>ダブルクリックで開く · ドラッグでフォルダへ移す</span>
      </div>
    </div>
  );
}

function NewItem(props: { kind: ResKind; label: string; sub: string; onClick: () => void }) {
  const meta = KIND_META[props.kind];
  return (
    <button type="button" role="menuitem" className={styles.menuItem} onClick={props.onClick}>
      <span className={styles.menuIcon} style={{ background: meta.bg, color: meta.fg }}>
        <KindIcon
          item={{ id: "", kind: props.kind, name: "", parent: null, color: "#C9A27A" }}
          size={16}
        />
      </span>
      <span className={styles.menuText}>
        <span className={styles.menuLabel}>{props.label}</span>
        <span className={styles.menuSub}>{props.sub}</span>
      </span>
    </button>
  );
}

function SmallIcon({ item }: { item: ResItem }) {
  const meta = KIND_META[item.kind];
  return (
    <span className={styles.smallIcon} style={{ background: meta.bg, color: meta.fg }}>
      <KindIcon item={item} size={14} />
    </span>
  );
}

const icon = (size: number, stroke = 2) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: stroke,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

function FolderIcon({ size, filled }: { size: number; filled?: boolean }) {
  return (
    <svg {...icon(size)} aria-hidden="true" style={{ color: "#9A6B00", flex: "none" }}>
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill={filled ? "#FDD046" : "#FFF1BF"}
      />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      {...icon(12, 2.4)}
      aria-hidden="true"
      style={{ transition: "transform .12s", transform: open ? undefined : "rotate(-90deg)" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ViewIcon({ view }: { view: View }) {
  return (
    <svg {...icon(14)} aria-hidden="true">
      {view === "icon" && (
        <>
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
        </>
      )}
      {view === "list" && <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />}
      {view === "detail" && <path d="M4 5h16v14H4zM4 10h16M10 10v9" />}
    </svg>
  );
}

/** 種類ごとのアイコン（画像は中身の縮小、マテリアルは色の玉） */
function KindIcon({ item, size, large }: { item: ResItem; size: number; large?: boolean }) {
  if (item.kind === "image" && large && item.id) {
    return <img src={assetUrl(item.id)} alt="" className={styles.imageThumb} />;
  }
  if (item.kind === "material") {
    return (
      <span
        className={styles.ball}
        style={{ width: large ? "52%" : size, background: item.color ?? "#ccc" }}
      />
    );
  }
  const p = icon(size, large ? 1.7 : 2);
  switch (item.kind) {
    case "folder":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    case "koko":
    case "builtin":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
          <path d="M4 7l8 4 8-4M12 11v10" />
        </svg>
      );
    case "system":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
        </svg>
      );
    case "model":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
          <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
        </svg>
      );
    case "image":
      return (
        <svg {...p} aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="M21 16l-5-5-8 8" />
        </svg>
      );
    case "audio":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M9 18V6l10-2v12" />
          <circle cx="6.5" cy="18" r="2.5" />
          <circle cx="16.5" cy="16" r="2.5" />
        </svg>
      );
  }
}

interface Badge {
  tone: "error" | "warning" | "nestedError" | "nestedWarning";
  label: string;
}

/** 問題の印（色だけに頼らず、title と aria-label で件数を伝える） */
function BadgeDot({ badge, inline }: { badge: Badge | null; inline?: boolean }) {
  if (!badge) return null;
  return (
    <span
      className={inline ? styles.badgeInline : styles.errorDot}
      data-tone={badge.tone}
      role="img"
      aria-label={badge.label}
      title={badge.label}
    />
  );
}
