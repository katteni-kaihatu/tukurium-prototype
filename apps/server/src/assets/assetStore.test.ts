import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetId, DiskAssetStore, S3AssetStore } from "./assetStore";

describe("DiskAssetStore", () => {
  it("保存して読み出せる。不正な ID は null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tk-assets-"));
    const store = new DiskAssetStore(dir);
    const data = Buffer.from("glb-data");
    const id = await store.put(data, "model/gltf-binary");
    expect(id).toBe(assetId(data));
    expect(await store.get(id)).toEqual({ data, contentType: "model/gltf-binary" });
    expect(await store.get("../etc/passwd")).toBeNull();
    await rm(dir, { recursive: true });
  });
});

// 実際の S3 互換ストレージで確かめる（TEST_S3_ENDPOINT があるときだけ。pnpm services:up で起動できる）
const endpoint = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!endpoint)("S3AssetStore", () => {
  it("バケットがなければ作り、保存して読み出せる", async () => {
    const store = new S3AssetStore({
      endpoint: endpoint as string,
      region: "us-east-1",
      bucket: `tk-test-${Date.now()}`,
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "tukurium",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "tukurium-dev-secret",
    });
    const data = Buffer.from(`audio-${Date.now()}`);
    const id = await store.put(data, "audio/ogg");
    const got = await store.get(id);
    expect(got?.contentType).toBe("audio/ogg");
    expect(got?.data.equals(data)).toBe(true);
    expect(await store.get("f".repeat(64))).toBeNull();
  }, 30_000); // 新しいバケットへの最初の書き込みは時間がかかることがある
});
