import type { AssetDef, AssetKind } from "@tukurium/repo-model";

const BY_EXT: Record<string, string> = {
  glb: "model/gltf-binary",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

export const ASSET_ACCEPT = Object.keys(BY_EXT)
  .map((e) => `.${e}`)
  .join(",");

/** 素材をサーバーに置き、制作データに加えるための情報を返す */
export async function uploadAsset(file: File): Promise<AssetDef> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const contentType = BY_EXT[ext] ?? file.type;
  if (!contentType)
    throw new Error("対応していないファイルです（GLB・PNG・JPEG・WebP・MP3・OGG・WAV）");
  let token = "";
  try {
    token = localStorage.getItem("tukurium.token") ?? "";
  } catch {
    // トークンがなければサーバーが断る
  }
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": contentType, "x-tukurium-token": token },
    body: file,
  });
  const body = (await res.json()) as { id?: string; kind?: AssetKind; error?: string };
  if (!res.ok || !body.id || !body.kind)
    throw new Error(body.error ?? `アップロードに失敗しました（${res.status}）`);
  return { id: body.id, kind: body.kind, contentType, name: file.name.replace(/\.[^.]+$/, "") };
}

export const assetUrl = (id: string) => `/api/assets/${id}`;
