import type {
  FileChange,
  PackageManifest,
  PackageResolution,
  ProjectSnapshot,
  Provenance,
} from "@tukurium/repo-model";

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
  ownerName?: string;
  repoName?: string;
  perms: WorkPerms;
  latest?: Release | null;
  /** リリースしたアウトプットの種類。ワールドは原点、アイテムは視線の先に置く */
  outputKind?: "item" | "world" | "library" | null;
  /** 公式の発行者の作品か（名前ではなく発行者で決まる。ADR 0016） */
  official?: boolean;
  createdAt: string;
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

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "x-tukurium-token": token(),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `エラー（${res.status}）`);
  return data;
}

/** リポジトリ・作品の API（サーバーの repos/routes.ts） */
export const api = {
  createRepo: (body: {
    name: string;
    description?: string;
    kind: "item" | "world";
    visibility: "public" | "private";
    template: "empty" | "sample" | "gun" | "range";
  }) => call<RepoMeta>("POST", "/api/repos", body),
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
  publish: (repoId: string, outputId: string) =>
    call<Work>("POST", "/api/works", { repoId, outputId }),
  works: (owner?: string) =>
    call<Work[]>("GET", owner ? `/api/works?owner=${encodeURIComponent(owner)}` : "/api/works"),
  updateWork: (id: string, body: { name?: string; perms?: Partial<WorkPerms> }) =>
    call<Work>("PATCH", `/api/works/${id}`, body),
  release: (workId: string) => call<Release>("POST", `/api/works/${workId}/releases`, {}),
  packageVersion: (workId: string, version: number) =>
    call<PackageVersion>("GET", `/api/works/${workId}/releases/${version}/package`),
  user: (id: string) =>
    call<{ id: string; name: string; repos: RepoMeta[]; works: Work[] }>("GET", `/api/users/${id}`),
};
