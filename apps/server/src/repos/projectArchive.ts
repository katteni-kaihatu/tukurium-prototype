import { type FileMap, fromFiles, type ProjectSnapshot } from "@tukurium/repo-model";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  ASSET_TYPES,
  type AssetStore,
  assetBytesMatch,
  assetId,
  MAX_ASSET_BYTES,
} from "../assets/assetStore";
import type { RepoMeta, User } from "../store/store";
import { HttpError, type RepoService } from "./service";

/**
 * プロジェクトの Zip（エクスポート・インポート）の形。
 *
 * - `tukurium-project.json`：この Zip の説明（名前・説明・種類・元のプロジェクト・素材の種類）
 * - `project/…`：最新の保存（コミット）のファイル。リポジトリの中と同じ並び（人が読める JSON と .ts）
 * - `asset-files/<素材 ID>`：素材の本体（モデル・画像・音声）。ID は中身の SHA-256
 *
 * 保存の履歴は入れない。インポートすると、そこから履歴が始まる新しいプロジェクトになる。
 */
export const ARCHIVE_META = "tukurium-project.json";
const PROJECT_DIR = "project/";
const ASSET_DIR = "asset-files/";

export interface ArchiveMeta {
  format: 1;
  name: string;
  description: string;
  kind: string;
  exportedAt: string;
  /** 書き出したときのプロジェクト（ほかのサーバーへ持っていくと、たどれないことがある） */
  source: { repoId: string; repoName: string; commit: string };
  assets: { id: string; contentType: string }[];
}

export interface ArchiveAsset {
  id: string;
  contentType: string;
  data: Uint8Array;
}

/** Zip 全体の大きさの上限（アップロード） */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
/** 展開したあとの合計の上限 */
const MAX_EXPANDED_BYTES = 400 * 1024 * 1024;
/** 制作データ（テキスト）の合計の上限 */
const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export function writeProjectArchive(
  meta: Omit<ArchiveMeta, "format" | "assets">,
  files: FileMap,
  assets: ArchiveAsset[],
): Uint8Array {
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const full: ArchiveMeta = {
    format: 1,
    ...meta,
    assets: assets.map((a) => ({ id: a.id, contentType: a.contentType })),
  };
  entries[ARCHIVE_META] = strToU8(`${JSON.stringify(full, null, 2)}\n`);
  for (const [path, content] of Object.entries(files))
    entries[`${PROJECT_DIR}${path}`] = strToU8(content);
  // 素材はたいてい圧縮済み（GLB・PNG・MP3 など）なので、縮めずに入れる
  for (const a of assets) entries[`${ASSET_DIR}${a.id}`] = [a.data, { level: 0 }];
  return zipSync(entries, { level: 6 });
}

const bad = (message: string) => new HttpError(400, message);

/** Zip の中の制作データのパスとして受け付けるか（上へたどる・絶対パスなどを拒む） */
const safePath = (path: string) =>
  path.length > 0 &&
  path.length <= 512 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** Zip を読み、形と素材の中身を確かめる。合わなければ 400 で拒む。 */
export function readProjectArchive(zip: Uint8Array): {
  meta: ArchiveMeta;
  files: FileMap;
  assets: ArchiveAsset[];
} {
  let count = 0;
  let declared = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (file) => {
        count += 1;
        declared += file.originalSize;
        if (count > MAX_ENTRIES) throw bad("Zip の中のファイルが多すぎます");
        if (declared > MAX_EXPANDED_BYTES) throw bad("Zip を展開すると大きすぎます");
        // フォルダの項目は読まない
        return !file.name.endsWith("/");
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad("Zip ファイルを読めません");
  }
  const total = Object.values(entries).reduce((n, d) => n + d.length, 0);
  if (total > MAX_EXPANDED_BYTES) throw bad("Zip を展開すると大きすぎます");

  const metaBytes = entries[ARCHIVE_META];
  if (!metaBytes) throw bad("Tukurium のプロジェクトの Zip ではありません");
  let meta: ArchiveMeta;
  try {
    meta = JSON.parse(strFromU8(metaBytes)) as ArchiveMeta;
  } catch {
    throw bad(`${ARCHIVE_META} を読めません`);
  }
  if (meta?.format !== 1) throw bad("この Zip の形式には対応していません");
  if (!Array.isArray(meta.assets)) meta.assets = [];

  const files: FileMap = {};
  let projectBytes = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(PROJECT_DIR)) continue;
    const path = name.slice(PROJECT_DIR.length);
    if (!safePath(path)) throw bad(`Zip の中に読めないパスがあります：${name}`);
    projectBytes += data.length;
    if (projectBytes > MAX_PROJECT_BYTES) throw bad("制作データが大きすぎます");
    files[path] = strFromU8(data);
  }
  if (!files["tukurium.json"])
    throw bad("Zip の中に制作データ（project/tukurium.json）がありません");

  const assets: ArchiveAsset[] = [];
  const types = new Map(meta.assets.map((a) => [a?.id, a?.contentType]));
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(ASSET_DIR)) continue;
    const id = name.slice(ASSET_DIR.length);
    if (!/^[0-9a-f]{64}$/.test(id)) throw bad(`素材のファイル名が正しくありません：${name}`);
    const contentType = types.get(id);
    if (typeof contentType !== "string" || !ASSET_TYPES[contentType])
      throw bad(`素材の種類が分かりません：${id.slice(0, 12)}`);
    if (data.length > MAX_ASSET_BYTES) throw bad(`素材が大きすぎます：${id.slice(0, 12)}`);
    if (assetId(Buffer.from(data)) !== id || !assetBytesMatch(contentType, data))
      throw bad(`素材の中身が壊れています：${id.slice(0, 12)}`);
    assets.push({ id, contentType, data });
  }
  return { meta, files, assets };
}

/** ダウンロードするときのファイル名（Content-Disposition） */
export function archiveDisposition(name: string): string {
  const base = name.trim() || "project";
  const ascii = base.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
  return `attachment; filename="${ascii}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`;
}

/** プロジェクトが参照する素材の ID（素材の一覧と、アウトプットのサムネイル） */
function referencedAssets(snap: ProjectSnapshot): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const a of snap.assets ?? []) out.set(a.id, a.contentType);
  for (const o of snap.outputs)
    if (o.thumbnail && !out.has(o.thumbnail)) out.set(o.thumbnail, null);
  return out;
}

/**
 * 最新の保存と、使っている素材を Zip にする。フォーク・抽出と同じく、フォークできる人だけ。
 * 素材置き場に見つからない素材は入れない（参照はそのまま残る）。
 */
export async function exportProject(
  repos: RepoService,
  assetStore: AssetStore,
  user: User,
  repoId: string,
): Promise<{ name: string; zip: Uint8Array }> {
  const repo = await repos.require(repoId);
  if (!(await repos.canFork(user, repo)))
    throw new HttpError(403, "エクスポートする権限がありません");
  const commit = await repos.git.head(repo.id);
  if (!commit) throw new HttpError(409, "まだ保存がありません");
  const files = await repos.git.files(repo.id, commit);
  const assets: ArchiveAsset[] = [];
  for (const [id, declared] of referencedAssets(fromFiles(files))) {
    const got = await assetStore.get(id);
    if (!got) continue;
    assets.push({ id, contentType: declared ?? got.contentType, data: got.data });
  }
  const zip = writeProjectArchive(
    {
      name: repo.name,
      description: repo.description,
      kind: repo.kind,
      exportedAt: new Date().toISOString(),
      source: { repoId: repo.id, repoName: repo.name, commit },
    },
    files,
    assets,
  );
  return { name: repo.name, zip };
}

/** Zip から、新しいプロジェクトを作る（持ち主は取り込んだ人）。素材は素材置き場へ入れる。 */
export async function importProject(
  repos: RepoService,
  assetStore: AssetStore,
  user: User,
  zip: Uint8Array,
  options: { name?: string; description?: string; visibility?: "public" | "private" } = {},
): Promise<RepoMeta> {
  const { meta, files, assets } = readProjectArchive(zip);
  let snapshot: ProjectSnapshot;
  try {
    snapshot = fromFiles(files);
  } catch {
    throw new HttpError(400, "Zip の中の制作データを読めません");
  }
  for (const a of assets) await assetStore.put(Buffer.from(a.data), a.contentType);
  const kind = meta.kind === "world" || meta.kind === "library" ? meta.kind : "item";
  return repos.create(user, {
    name: options.name?.trim() || (typeof meta.name === "string" ? meta.name : snapshot.name),
    description:
      options.description ?? (typeof meta.description === "string" ? meta.description : ""),
    kind,
    visibility: options.visibility ?? "private",
    snapshot,
  });
}
