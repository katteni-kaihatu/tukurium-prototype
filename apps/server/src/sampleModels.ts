import { type AssetStore, assetId } from "./assets/assetStore";
import { OFFICIAL_THUMBNAIL_BLOBS } from "./officialThumbnails.generated";
import { SAMPLE_MODEL_BLOBS } from "./sampleModels.generated";

/**
 * 同梱の素材（森の木のモデル・公式ライブラリのサムネイル）を、素材置き場へ入れる
 * （同じ中身なら ID は変わらない）
 */
export async function seedSampleModels(assets: AssetStore): Promise<void> {
  for (const blob of [...SAMPLE_MODEL_BLOBS, ...OFFICIAL_THUMBNAIL_BLOBS]) {
    const data = Buffer.from(blob.base64, "base64");
    const id = await assets.put(data, blob.contentType);
    if (id !== blob.id || id !== assetId(data)) {
      throw new Error(`同梱の素材「${blob.name}」の中身と ID が違います`);
    }
  }
}
