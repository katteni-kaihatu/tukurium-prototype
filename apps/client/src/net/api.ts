import { type FieldSchemas, parseValue } from "@tukurium/eks";
import type {
  FileChange,
  PackageManifest,
  PackageResolution,
  ProjectSnapshot,
  Provenance,
} from "@tukurium/repo-model";
import type { SessionSummary, SocialProfile, UserInfo } from "@tukurium/shared";

export interface RepoMeta {
  id: string;
  owner: string;
  ownerName: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  kind: string;
  forkedFrom: { repoId: string; repoName: string; commit: string } | null;
  createdAt: string;
  /** 一覧に出すサムネイル（いまの版の最初のアウトプットのもの。ADR 0046） */
  thumbnail?: string | null;
}

export interface WorkPerms {
  use: boolean;
  view: boolean;
  fork: boolean;
}

export interface Release {
  id: string;
  workId: string;
  version: number;
  commit: string;
  createdAt: string;
  /** ライブラリの版の content hash（サーバーがリリースのときに計算する。ADR 0015） */
  contentHash?: string;
  /** その版を出した保存のメッセージ。詳細でだけ付く */
  comment?: string;
}

/** ライブラリの版の中身（公開したものだけ） */
export interface PackageVersion {
  packageId: string;
  version: number;
  contentHash: string;
  manifest: PackageManifest;
  /** 依存の依存（間のライブラリの作者の許可でサーバーが取り出したもの） */
  dependencies?: PackageResolution[];
}

export interface Work {
  id: string;
  repoId: string;
  outputId: string;
  name: string;
  owner: string;
  /** 作者が付ける公開タグ。旧データでは省略されている。 */
  tags?: string[];
  ownerName?: string;
  repoName?: string;
  perms: WorkPerms;
  latest?: Release | null;
  /** リリースしたアウトプットの種類。ワールドは原点、アイテムは視線の先に置く */
  outputKind?: "item" | "world" | "library" | null;
  /** リリースした版のサムネイル（画像の素材 ID。ADR 0046） */
  thumbnail?: string | null;
  /** 公式の発行者の作品か（名前ではなく発行者で決まる。ADR 0016） */
  official?: boolean;
  /** マーケットへの登録（登録していなければ null） */
  market?: MarketInfo | null;
  /** ワールドの一覧だけ：マーケットの価格（登録していなければ null） */
  price?: number | null;
  /** ワールドの一覧だけ：見ている人が使えるか（有料で入手していなければ false） */
  unlocked?: boolean;
  createdAt: string;
}

export interface MarketInfo {
  /** 価格（ポイント）。0 は無料 */
  price: number;
  autoPublish: boolean;
  /** マーケットで公開している版 */
  release: Release | null;
  listedAt: string;
  /** 入手した人の数 */
  acquisitions: number;
}

export type MarketEvent = { id: string; workId: string; at: string } & (
  | { kind: "listed"; version: number; price: number }
  | { kind: "published"; version: number; auto: boolean }
  | { kind: "price"; from: number; to: number }
  | { kind: "unlisted" }
);

export type MarketKind = "all" | "item" | "world";
export type MarketSort = "new" | "popular" | "cheap";

/** マイページ：自分の作品と、入手の記録（誰が買ったかは含まない） */
export interface MyMarket {
  balance: number;
  listed: Work[];
  unlisted: Work[];
  sales: {
    id: string;
    workId: string;
    workName: string;
    version: number | null;
    price: number;
    earned: number;
    at: string;
  }[];
}

export interface ListingInput {
  price: number;
  tags?: string[];
  autoPublish: boolean;
  releaseId?: string;
}

/** 作品の詳細。公開プロジェクトだけ project が付く */
export interface WorkDetail extends Work {
  releases: Release[];
  /** マーケットの履歴（新しい順） */
  history: MarketEvent[];
  project: { id: string; name: string } | null;
}

export interface OwnedItem {
  userId: string;
  workId: string;
  releaseId: string;
  acquiredAt: string;
  work: Work | null;
  release: Release | null;
  available: boolean;
  reason: string | null;
}

export interface MarketPage {
  items: Work[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface FriendEntry {
  user: UserInfo;
  profile: SocialProfile;
  presence: { online: boolean; sessions: SessionSummary[] };
}
export interface SocialState {
  profile: SocialProfile;
  friends: FriendEntry[];
  incoming: { user: UserInfo; createdAt: string }[];
  outgoing: { user: UserInfo; createdAt: string }[];
  invitations: { incoming: InvitationView[]; outgoing: InvitationView[] };
}
export interface InvitationView {
  id: string;
  from: UserInfo | null;
  to: UserInfo | null;
  session: SessionSummary | null;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
}
export interface PersonResult {
  user: UserInfo;
  relation: "none" | "friend" | "incoming" | "outgoing";
}

export interface RepoDetail extends RepoMeta {
  head: string | null;
  outputs: { id: string; name: string; kind: string }[];
  provenance: Provenance[];
  works: (Work & { releases: Release[] })[];
  canFork: boolean;
  isOwner: boolean;
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  parents: string[];
}

export interface ExtractSelection {
  outputs: string[];
  kokostates: string[];
  systems: string[];
  materials: string[];
  assets: string[];
}

function token(): string {
  try {
    return localStorage.getItem("tukurium.token") ?? "";
  } catch {
    return "";
  }
}

/** 素材の URL（素材にも権限があるので、本人確認のトークンを付ける） */
export const assetUrl = (id: string) => `/api/assets/${id}?t=${encodeURIComponent(token())}`;

async function call<T>(
  method: string,
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method,
    signal,
    headers: {
      "x-tukurium-token": token(),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // 制作データの値を欠かさず受け取るため、タグ付きの JSON として読む（ADR 0065）
  const data = (await res
    .text()
    .then(parseValue)
    .catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `エラー（${res.status}）`);
  return data;
}

/** プロジェクトを Zip にして、ブラウザでダウンロードする（最新の保存と素材が入る） */
async function downloadProjectZip(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/repos/${encodeURIComponent(id)}/export`, {
    headers: { "x-tukurium-token": token() },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `エラー（${res.status}）`);
  }
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.trim() || "project"}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // クリックの処理が済んでから捨てる
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** Zip から新しいプロジェクトを作る */
async function uploadProjectZip(
  file: Blob,
  options: { name?: string; description?: string; visibility?: "public" | "private" },
): Promise<RepoMeta> {
  const params = new URLSearchParams();
  if (options.name?.trim()) params.set("name", options.name.trim());
  if (options.description) params.set("description", options.description);
  if (options.visibility) params.set("visibility", options.visibility);
  const res = await fetch(`/api/repos/import?${params}`, {
    method: "POST",
    headers: { "x-tukurium-token": token(), "content-type": "application/zip" },
    body: file,
  });
  const data = (await res
    .text()
    .then(parseValue)
    .catch(() => ({}))) as RepoMeta & { error?: string };
  if (!res.ok)
    throw new Error(
      data.error ?? (res.status === 413 ? "Zip ファイルが大きすぎます" : `エラー（${res.status}）`),
    );
  return data;
}

/** リポジトリ・作品の API（サーバーの repos/routes.ts） */
export const api = {
  invite: (to: string, sessionId: string) =>
    call<InvitationView>("POST", "/api/me/invitations", { to, sessionId }),
  respondInvite: (id: string, action: "accept" | "decline" | "cancel") =>
    call<InvitationView>("POST", `/api/me/invitations/${encodeURIComponent(id)}/respond`, {
      action,
    }),
  social: () => call<SocialState>("GET", "/api/me/social"),
  updateSocial: (profile: SocialProfile) => call<SocialProfile>("PATCH", "/api/me/social", profile),
  people: (query: string, signal?: AbortSignal) =>
    call<PersonResult[]>("GET", `/api/people?q=${encodeURIComponent(query)}`, undefined, signal),
  requestFriend: (id: string) =>
    call("POST", `/api/me/friends/${encodeURIComponent(id)}/request`, {}),
  acceptFriend: (id: string) =>
    call("POST", `/api/me/friends/${encodeURIComponent(id)}/accept`, {}),
  removeFriend: (id: string) => call("DELETE", `/api/me/friends/${encodeURIComponent(id)}`),
  market: (
    query = "",
    offset = 0,
    signal?: AbortSignal,
    tags: string[] = [],
    kind: MarketKind = "all",
    sort: MarketSort = "new",
  ) => {
    const params = new URLSearchParams({ q: query, offset: String(offset), kind, sort });
    for (const tag of tags) params.append("tag", tag);
    return call<MarketPage>("GET", `/api/market?${params}`, undefined, signal);
  },
  wallet: () => call<{ balance: number }>("GET", "/api/me/wallet"),
  myMarket: () => call<MyMarket>("GET", "/api/me/market"),
  registerListing: (workId: string, body: ListingInput) =>
    call<Work>("POST", "/api/market/listings", { workId, ...body }),
  editListing: (workId: string, body: Partial<ListingInput>) =>
    call<Work>("PATCH", `/api/market/listings/${encodeURIComponent(workId)}`, body),
  unlist: (workId: string) =>
    call<{ ok: true }>("DELETE", `/api/market/listings/${encodeURIComponent(workId)}`),
  ownedItems: (signal?: AbortSignal) =>
    call<OwnedItem[]>("GET", "/api/me/items", undefined, signal),
  acquireItem: (workId: string) =>
    call<OwnedItem & { balance: number }>(
      "POST",
      `/api/me/items/${encodeURIComponent(workId)}`,
      {},
    ),
  updateItem: (workId: string, releaseId: string) =>
    call<OwnedItem>("PUT", `/api/me/items/${encodeURIComponent(workId)}`, { releaseId }),
  removeItem: (workId: string) =>
    call<{ ok: true }>("DELETE", `/api/me/items/${encodeURIComponent(workId)}`),
  createRepo: (body: {
    name: string;
    description?: string;
    kind: "item" | "world";
    visibility: "public" | "private";
    template: "empty" | "sample" | "gun" | "range" | "forest" | "marubatsu";
  }) => call<RepoMeta>("POST", "/api/repos", body),
  exportRepo: downloadProjectZip,
  importRepo: uploadProjectZip,
  repos: (owner?: string) =>
    call<RepoMeta[]>("GET", owner ? `/api/repos?owner=${encodeURIComponent(owner)}` : "/api/repos"),
  repo: (id: string) => call<RepoDetail>("GET", `/api/repos/${id}`),
  updateRepo: (
    id: string,
    body: { name?: string; description?: string; visibility?: "public" | "private" },
  ) => call<RepoMeta>("PATCH", `/api/repos/${id}`, body),
  commits: (id: string) => call<CommitInfo[]>("GET", `/api/repos/${id}/commits`),
  files: (id: string, commit?: string) =>
    call<Record<string, string>>(
      "GET",
      `/api/repos/${id}/files${commit ? `?commit=${commit}` : ""}`,
    ),
  /** 開いているワークスペースへ取り込むための、取り出し元の中身（フォークできる人だけ） */
  importSource: (id: string) =>
    call<{
      repoId: string;
      repoName: string;
      commit: string;
      snapshot: ProjectSnapshot;
      schemas?: FieldSchemas;
    }>("GET", `/api/repos/${id}/import-source`),
  snapshot: (id: string, commit?: string) =>
    call<ProjectSnapshot>("GET", `/api/repos/${id}/snapshot${commit ? `?commit=${commit}` : ""}`),
  diff: (id: string, oid: string) =>
    call<FileChange[]>("GET", `/api/repos/${id}/commits/${oid}/diff`),
  fork: (id: string, name?: string) => call<RepoMeta>("POST", `/api/repos/${id}/fork`, { name }),
  extract: (
    id: string,
    selection: ExtractSelection,
    target: { name: string } | { repoId: string },
  ) =>
    call<{ repo: RepoMeta; commit: string }>("POST", `/api/repos/${id}/extract`, {
      selection,
      target,
    }),
  publish: (repoId: string, outputId: string, tags?: string[]) =>
    call<Work>("POST", "/api/works", { repoId, outputId, tags }),
  works: (owner?: string) =>
    call<Work[]>("GET", owner ? `/api/works?owner=${encodeURIComponent(owner)}` : "/api/works"),
  work: (id: string) => call<WorkDetail>("GET", `/api/works/${encodeURIComponent(id)}`),
  updateWork: (id: string, body: { name?: string; perms?: Partial<WorkPerms>; tags?: string[] }) =>
    call<Work>("PATCH", `/api/works/${id}`, body),
  release: (workId: string) => call<Release>("POST", `/api/works/${workId}/releases`, {}),
  packageVersion: (workId: string, version: number) =>
    call<PackageVersion>("GET", `/api/works/${workId}/releases/${version}/package`),
  user: (id: string) =>
    call<{ id: string; name: string; repos: RepoMeta[]; works: Work[] }>("GET", `/api/users/${id}`),
};
