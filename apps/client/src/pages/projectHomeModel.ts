/** プロジェクトウィンドウの一覧で使う、表示用の絞り込みと時刻。 */

export type ProjectSort = "updated" | "name" | "created";
export type KindFilter = "all" | "item" | "world" | "library";
export type VisibilityFilter = "all" | "public" | "private";

export interface ListedProject {
  id: string;
  name: string;
  description: string;
  kind: string;
  visibility: "public" | "private";
  createdAt: string;
  updatedAt: number;
  forkedFrom: { repoId: string; repoName: string } | null;
}

export interface ListedRelease {
  id: string;
  name: string;
  repoId: string;
  repoName: string;
  kind: string;
  version: number | null;
  at: number;
}

export interface ProjectActivity {
  savedAt: number;
  counts: number[];
}

const KIND_LABEL: Record<string, string> = {
  item: "アイテム",
  world: "ワールド",
  library: "ライブラリ",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? "そのほか";
}

export function visibilityLabel(visibility: "public" | "private"): string {
  return visibility === "public" ? "公開" : "非公開";
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** いまから遡った週ごとの保存回数。右端がいちばん新しい週。 */
export function sparkCounts(timestamps: number[], now: number, buckets = 12): number[] {
  const start = now - buckets * WEEK;
  const counts = Array.from({ length: buckets }, () => 0);
  for (const ts of timestamps) {
    if (ts < start || ts > now) continue;
    const index = Math.min(buckets - 1, Math.floor((ts - start) / WEEK));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

export function savedAtOf(timestamps: number[], createdAt: string, now: number): number {
  let newest = 0;
  for (const ts of timestamps) if (ts > newest) newest = ts;
  if (newest > 0) return newest;
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? created : now;
}

export function activityFromCommits(
  timestamps: number[],
  createdAt: string,
  now: number,
): ProjectActivity {
  const savedAt = savedAtOf(timestamps, createdAt, now);
  return { savedAt, counts: sparkCounts(timestamps.length > 0 ? timestamps : [savedAt], now) };
}

function calendarDays(ts: number, now: number): number {
  const a = new Date(ts);
  const b = new Date(now);
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

/** 「2時間前に保存」のような、一覧に出す保存の時刻。 */
export function savedLabel(ts: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return "たった今保存";
  if (minutes < 60) return `${minutes}分前に保存`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前に保存`;
  const days = calendarDays(ts, now);
  if (days <= 1) return "昨日に保存";
  if (days < 7) return `${days}日前に保存`;
  if (days < 14) return "先週に保存";
  const date = new Date(ts);
  return `${date.getMonth() + 1}月${date.getDate()}日に保存`;
}

export function listProjects(
  repos: ListedProject[],
  opts: { query: string; kind: KindFilter; visibility: VisibilityFilter; sort: ProjectSort },
): ListedProject[] {
  const query = opts.query.trim().toLocaleLowerCase();
  const rows = repos.filter((repo) => {
    if (opts.kind !== "all" && repo.kind !== opts.kind) return false;
    if (opts.visibility !== "all" && repo.visibility !== opts.visibility) return false;
    if (!query) return true;
    return `${repo.name}\n${repo.description}`.toLocaleLowerCase().includes(query);
  });
  rows.sort((a, b) => compareProjects(a, b, opts.sort));
  return rows;
}

function compareProjects(a: ListedProject, b: ListedProject, sort: ProjectSort): number {
  if (sort === "name") return a.name.localeCompare(b.name, "ja");
  if (sort === "created") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return b.updatedAt - a.updatedAt;
}

/** プロジェクトごとに、いちばん新しいリリースの版。 */
export function latestVersions(releases: ListedRelease[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const release of releases) {
    if (release.version == null) continue;
    const prev = versions.get(release.repoId) ?? 0;
    if (release.version > prev) versions.set(release.repoId, release.version);
  }
  return versions;
}

export function listReleases(
  releases: ListedRelease[],
  opts: { query: string; kind: KindFilter; sort: ProjectSort },
): ListedRelease[] {
  const query = opts.query.trim().toLocaleLowerCase();
  const rows = releases.filter((release) => {
    if (opts.kind !== "all" && release.kind !== opts.kind) return false;
    if (!query) return true;
    return `${release.name}\n${release.repoName}`.toLocaleLowerCase().includes(query);
  });
  rows.sort((a, b) => (opts.sort === "name" ? a.name.localeCompare(b.name, "ja") : b.at - a.at));
  return rows;
}

/** いま開いているワークスペースが指しているプロジェクト。 */
export function editingRepoIds(
  workspaces: { id: string; repoId: string | null; present: string[] }[],
  userId: string | undefined,
  openWorkspaceId: string | null,
): Set<string> {
  const ids = new Set<string>();
  for (const workspace of workspaces) {
    if (!workspace.repoId) continue;
    const here = workspace.id === openWorkspaceId;
    const present = userId !== undefined && workspace.present.includes(userId);
    if (here || present) ids.add(workspace.repoId);
  }
  return ids;
}
