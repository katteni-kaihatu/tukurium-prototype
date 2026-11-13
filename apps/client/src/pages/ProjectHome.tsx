import type { SocialProfile } from "@tukurium/shared";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useApp } from "../app/store";
import { editProject } from "../main-menu/editing";
import { AVAILABILITY, useSocial } from "../main-menu/socialStore";
import { useMainMenu } from "../main-menu/store";
import { useWorkspace } from "../workspace/store";
import styles from "./ProjectHome.module.css";
import { ProjectLink, useProjectNavigate } from "./ProjectNavigation";
import {
  editingRepoIds,
  type KindFilter,
  kindLabel,
  type ListedProject,
  type ListedRelease,
  latestVersions,
  listProjects,
  listReleases,
  type ProjectActivity,
  type ProjectSort,
  savedLabel,
  type VisibilityFilter,
  visibilityLabel,
} from "./projectList";

type Tab = "overview" | "projects" | "releases";

/** プロジェクトウィンドウのホーム。左が人、右が一覧。 */
export function ProjectHome({
  name,
  self,
  repos,
  releases,
  activity,
  embedded,
}: {
  name: string;
  self: boolean;
  repos: ListedProject[];
  releases: ListedRelease[];
  activity: Record<string, ProjectActivity>;
  embedded: boolean;
}) {
  const [tab, setTab] = useState<Tab>("projects");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [sort, setSort] = useState<ProjectSort>("updated");
  const [releaseQuery, setReleaseQuery] = useState("");
  const [releaseKind, setReleaseKind] = useState<KindFilter>("all");
  const [releaseSort, setReleaseSort] = useState<ProjectSort>("updated");
  const root = useRef<HTMLDivElement>(null);
  const profile = useSocial((s) => s.data?.profile);
  const session = useApp((s) => s.session);
  const userId = useApp((s) => s.me?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const editingPending = useMainMenu((s) => s.editingPending);
  const editingError = useMainMenu((s) => s.editingError);
  const navigate = useProjectNavigate();
  const editing = editingRepoIds(session?.workspaces ?? [], userId, workspaceId);
  const now = Date.now();
  const projects = listProjects(repos, { query, kind, visibility, sort });
  const recent = listProjects(repos, {
    query: "",
    kind: "all",
    visibility: "all",
    sort: "updated",
  });
  const releaseRows = listReleases(releases, {
    query: releaseQuery,
    kind: releaseKind,
    sort: releaseSort,
  });
  const recentReleases = listReleases(releases, { query: "", kind: "all", sort: "updated" });
  const editingRows = recent.filter((repo) => editing.has(repo.id));
  const versions = latestVersions(releases);

  const selectTab = (next: Tab) => {
    setTab(next);
    root.current?.parentElement?.scrollTo({ top: 0 });
  };

  return (
    <div className={embedded ? `${styles.home} ${styles.embedded}` : styles.home} ref={root}>
      <div className={styles.tabs} role="tablist" aria-label="プロジェクト">
        <TabButton id="overview" current={tab} onSelect={selectTab} icon={<ListIcon />}>
          概要
        </TabButton>
        <TabButton
          id="projects"
          current={tab}
          onSelect={selectTab}
          icon={<FolderIcon />}
          count={repos.length}
        >
          プロジェクト
        </TabButton>
        <TabButton
          id="releases"
          current={tab}
          onSelect={selectTab}
          icon={<BoxIcon />}
          count={releases.length}
        >
          リリース
        </TabButton>
        <span className={styles.tabSpace} />
        {!self && (
          <button type="button" className={styles.tabLink} onClick={() => navigate("/u/me")}>
            自分のプロジェクト
          </button>
        )}
        <button type="button" className={styles.tabLink} onClick={() => navigate("/explore")}>
          探す
        </button>
      </div>
      <div className={styles.columns}>
        <aside
          className={styles.side}
          aria-label={self ? "自分のプロフィール" : `${name} のプロフィール`}
        >
          <span className={styles.avatar} aria-hidden="true">
            {name.trim().slice(0, 1) || "?"}
          </span>
          <h1>{name}</h1>
          <p className={styles.handle}>@{name}</p>
          {self && profile && <StatusLine profile={profile} />}
          {self && (
            <button
              type="button"
              className={styles.edit}
              onClick={() => useMainMenu.getState().showWindow("status")}
            >
              プロフィールを編集
            </button>
          )}
          <p className={styles.counts}>
            {repos.length} プロジェクト・{releases.length} リリース
          </p>
        </aside>
        <div className={styles.main} role="tabpanel">
          {editingError && (
            <p className={styles.error} role="alert">
              {editingError}
            </p>
          )}
          {editingPending && <p className={styles.note}>ワークスペースを開いています…</p>}
          {tab === "overview" && (
            <Overview
              self={self}
              editingRows={editingRows}
              recent={recent}
              releases={recentReleases}
              activity={activity}
              editing={editing}
              versions={versions}
              now={now}
              onTab={selectTab}
            />
          )}
          {tab === "projects" && (
            <>
              <div className={styles.tools}>
                <input
                  className={styles.search}
                  value={query}
                  placeholder="プロジェクトを探す…"
                  aria-label="プロジェクトを探す"
                  onChange={(event) => setQuery(event.target.value)}
                />
                <FilterMenu
                  label="種類"
                  value={kind}
                  options={[
                    { value: "all", label: "すべて" },
                    { value: "item", label: "アイテム" },
                    { value: "world", label: "ワールド" },
                    { value: "library", label: "ライブラリ" },
                  ]}
                  onChange={setKind}
                />
                <FilterMenu
                  label="公開範囲"
                  value={visibility}
                  options={[
                    { value: "all", label: "すべて" },
                    { value: "public", label: "公開" },
                    { value: "private", label: "非公開" },
                  ]}
                  onChange={setVisibility}
                />
                <FilterMenu
                  label="並べ替え"
                  value={sort}
                  options={[
                    { value: "updated", label: "更新が新しい" },
                    { value: "name", label: "名前" },
                    { value: "created", label: "作成が新しい" },
                  ]}
                  onChange={setSort}
                />
                {self && (
                  <ProjectLink className={styles.primary} to="/new">
                    <FolderPlusIcon />
                    新しいプロジェクト
                  </ProjectLink>
                )}
              </div>
              {repos.length === 0 ? (
                <p className={styles.empty}>まだプロジェクトはありません。</p>
              ) : projects.length === 0 ? (
                <p className={styles.empty}>条件に合うプロジェクトはありません。</p>
              ) : (
                <ProjectRows
                  repos={projects}
                  activity={activity}
                  editing={editing}
                  versions={versions}
                  now={now}
                />
              )}
            </>
          )}
          {tab === "releases" && (
            <>
              <div className={styles.tools}>
                <input
                  className={styles.search}
                  value={releaseQuery}
                  placeholder="リリースを探す…"
                  aria-label="リリースを探す"
                  onChange={(event) => setReleaseQuery(event.target.value)}
                />
                <FilterMenu
                  label="種類"
                  value={releaseKind}
                  options={[
                    { value: "all", label: "すべて" },
                    { value: "item", label: "アイテム" },
                    { value: "world", label: "ワールド" },
                    { value: "library", label: "ライブラリ" },
                  ]}
                  onChange={setReleaseKind}
                />
                <FilterMenu
                  label="並べ替え"
                  value={releaseSort}
                  options={[
                    { value: "updated", label: "更新が新しい" },
                    { value: "name", label: "名前" },
                  ]}
                  onChange={setReleaseSort}
                />
              </div>
              {releases.length === 0 ? (
                <p className={styles.empty}>まだリリースはありません。</p>
              ) : releaseRows.length === 0 ? (
                <p className={styles.empty}>条件に合うリリースはありません。</p>
              ) : (
                <ReleaseRows releases={releaseRows} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  id,
  current,
  onSelect,
  icon,
  count,
  children,
}: {
  id: Tab;
  current: Tab;
  onSelect: (tab: Tab) => void;
  icon: ReactNode;
  count?: number;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      className={styles.tab}
      aria-selected={current === id}
      onClick={() => onSelect(id)}
    >
      {icon}
      {children}
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </button>
  );
}

function StatusLine({ profile }: { profile: SocialProfile }) {
  const note = profile.note.trim();
  const line = note
    ? `${AVAILABILITY[profile.availability]}・${note}`
    : AVAILABILITY[profile.availability];
  return (
    <p className={styles.status} data-status={profile.availability}>
      <span className={styles.dot} aria-hidden="true" />
      {line}
    </p>
  );
}

function Overview({
  self,
  editingRows,
  recent,
  releases,
  activity,
  editing,
  versions,
  now,
  onTab,
}: {
  self: boolean;
  editingRows: ListedProject[];
  recent: ListedProject[];
  releases: ListedRelease[];
  activity: Record<string, ProjectActivity>;
  editing: Set<string>;
  versions: Map<string, number>;
  now: number;
  onTab: (tab: Tab) => void;
}) {
  return (
    <>
      {self && (
        <section className={styles.block} aria-label="いま編集している">
          <div className={styles.blockHead}>
            <h2>いま編集している</h2>
          </div>
          {editingRows.length === 0 ? (
            <p className={styles.empty}>編集中のプロジェクトはありません。</p>
          ) : (
            <ProjectRows
              repos={editingRows}
              activity={activity}
              editing={editing}
              versions={versions}
              now={now}
            />
          )}
        </section>
      )}
      <section className={styles.block} aria-label="近ごろのプロジェクト">
        <div className={styles.blockHead}>
          <h2>近ごろのプロジェクト</h2>
          {recent.length > 3 && (
            <button type="button" className={styles.textButton} onClick={() => onTab("projects")}>
              すべて
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <p className={styles.empty}>まだプロジェクトはありません。</p>
        ) : (
          <ProjectRows
            repos={recent.slice(0, 3)}
            activity={activity}
            editing={editing}
            versions={versions}
            now={now}
          />
        )}
      </section>
      <section className={styles.block} aria-label="出したリリース">
        <div className={styles.blockHead}>
          <h2>出したリリース</h2>
          {releases.length > 3 && (
            <button type="button" className={styles.textButton} onClick={() => onTab("releases")}>
              すべて
            </button>
          )}
        </div>
        {releases.length === 0 ? (
          <p className={styles.empty}>まだリリースはありません。</p>
        ) : (
          <ReleaseRows releases={releases.slice(0, 3)} />
        )}
      </section>
    </>
  );
}

function ProjectRows({
  repos,
  activity,
  editing,
  versions,
  now,
}: {
  repos: ListedProject[];
  activity: Record<string, ProjectActivity>;
  editing: Set<string>;
  versions: Map<string, number>;
  now: number;
}) {
  return (
    <ul className={styles.rows}>
      {repos.map((repo) => {
        const saved = activity[repo.id];
        const version = versions.get(repo.id);
        return (
          <li className={styles.row} key={repo.id}>
            <div>
              <div className={styles.titleLine}>
                <ProjectLink className={styles.title} to={`/p/${repo.id}`}>
                  {repo.name}
                </ProjectLink>
                <span className={styles.badge}>{visibilityLabel(repo.visibility)}</span>
              </div>
              {repo.forkedFrom && (
                <p className={styles.origin}>
                  <ProjectLink to={`/p/${repo.forkedFrom.repoId}`}>
                    {repo.forkedFrom.repoName}
                  </ProjectLink>
                  {" からフォーク"}
                </p>
              )}
              {repo.description && <p className={styles.desc}>{repo.description}</p>}
              <p className={styles.meta}>
                <span className={styles.kind} data-kind={repo.kind}>
                  <span className={styles.dot} aria-hidden="true" />
                  {kindLabel(repo.kind)}
                </span>
                {version != null && <span>リリース v{version}</span>}
                {editing.has(repo.id) && (
                  <span className={styles.editing}>ワークスペースで編集中</span>
                )}
                {saved && <span className={styles.when}>{savedLabel(saved.savedAt, now)}</span>}
              </p>
            </div>
            <div className={styles.aside}>
              <OpenMenu repoId={repo.id} name={repo.name} />
              <span className={styles.sparkSlot}>
                {saved && <Sparkline counts={saved.counts} />}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ReleaseRows({ releases }: { releases: ListedRelease[] }) {
  return (
    <ul className={styles.rows}>
      {releases.map((release) => (
        <li className={styles.row} key={release.id}>
          <div>
            <div className={styles.titleLine}>
              <ProjectLink className={styles.title} to={`/p/${release.repoId}`}>
                {release.name}
              </ProjectLink>
              {release.version != null && <span className={styles.badge}>v{release.version}</span>}
            </div>
            {release.repoName && release.repoName !== release.name && (
              <p className={styles.origin}>{release.repoName}</p>
            )}
            <p className={styles.meta}>
              <span className={styles.kind} data-kind={release.kind}>
                <span className={styles.dot} aria-hidden="true" />
                {kindLabel(release.kind)}
              </span>
              {release.at > 0 && (
                <span className={styles.when}>{savedLabel(release.at, Date.now())}</span>
              )}
            </p>
          </div>
          <div className={styles.aside}>
            <OpenMenu repoId={release.repoId} name={release.name} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function OpenMenu({ repoId, name }: { repoId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const session = useApp((s) => s.session);
  const pending = useMainMenu((s) => s.editingPending);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div className={styles.open} ref={ref}>
      <ProjectLink className={styles.openMain} to={`/p/${repoId}`} aria-label={`${name} を開く`}>
        <PencilIcon />
        開く
      </ProjectLink>
      <button
        type="button"
        className={styles.openMore}
        aria-label={`${name} のほかの操作`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          const rect = ref.current?.getBoundingClientRect();
          setUp(rect ? rect.bottom + 140 > window.innerHeight : false);
          setOpen((value) => !value);
        }}
      >
        <ChevronIcon />
      </button>
      {open && (
        <div className={styles.pop} role="menu" data-up={up || undefined}>
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() => {
              setOpen(false);
              editProject(repoId);
            }}
          >
            {session ? "このセッションで編集する" : "セッションを選んで編集する"}
          </button>
        </div>
      )}
    </div>
  );
}

function FilterMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const current = options.find((option) => option.value === value) ?? options[0];
  const active = current !== undefined && current.value !== options[0]?.value;
  return (
    <div className={styles.filter} ref={ref}>
      <button
        type="button"
        data-active={active || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{active && current ? current.label : label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className={styles.pop} role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeRef.current();
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open, ref]);
}

function Sparkline({ counts }: { counts: number[] }) {
  const width = 128;
  const height = 36;
  const pad = 3;
  const max = Math.max(2, ...counts);
  const step = counts.length > 1 ? (width - pad * 2) / (counts.length - 1) : 0;
  const points = counts
    .map((count, index) => {
      const x = counts.length > 1 ? pad + index * step : width / 2;
      const y = height - 6 - (count / max) * (height - 14);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className={styles.spark} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function ListIcon() {
  return (
    <Svg>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </Svg>
  );
}

function FolderIcon() {
  return (
    <Svg>
      <path d="M3 7h6l2 2h10v10H3z" />
    </Svg>
  );
}

function FolderPlusIcon() {
  return (
    <Svg>
      <path d="M3 7h6l2 2h10v10H3z" />
      <path d="M12 12v6M9 15h6" />
    </Svg>
  );
}

function BoxIcon() {
  return (
    <Svg>
      <path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10" />
    </Svg>
  );
}

function PencilIcon() {
  return (
    <Svg>
      <path d="M4 20l4-1L20 7l-3-3L5 16z" />
    </Svg>
  );
}

function ChevronIcon() {
  return (
    <Svg>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}
