import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** 受け付ける素材の種類（要件 §5）。拡張子ではなく Content-Type で判定する。 */
export const ASSET_TYPES: Record<string, "model" | "image" | "audio"> = {
  "model/gltf-binary": "model",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "audio/mpeg": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
};

/** 1 ファイルの上限（初版の仮置き：計画 §10） */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export interface StoredAsset {
  data: Buffer;
  contentType: string;
}

/** 素材の置き場。中身の SHA-256 を ID にする（同じファイルは 1 つだけ置かれる）。 */
export interface AssetStore {
  put(data: Buffer, contentType: string): Promise<string>;
  get(id: string): Promise<StoredAsset | null>;
}

const starts = (data: Uint8Array, ...bytes: number[]) =>
  data.length >= bytes.length && bytes.every((b, i) => data[i] === b);
const ascii = (data: Uint8Array, at: number, text: string) =>
  data.length >= at + text.length && [...text].every((ch, i) => data[at + i] === ch.charCodeAt(0));

/** 宣言した種類と、ファイルの先頭が一致するか（壊れた取り込みを拒む） */
export function assetBytesMatch(contentType: string, data: Uint8Array): boolean {
  switch (contentType) {
    case "image/png":
      return starts(data, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(data, 0xff, 0xd8, 0xff);
    case "image/webp":
      return ascii(data, 0, "RIFF") && ascii(data, 8, "WEBP");
    case "model/gltf-binary":
      return ascii(data, 0, "glTF");
    case "audio/wav":
    case "audio/x-wav":
      return ascii(data, 0, "RIFF") && ascii(data, 8, "WAVE");
    case "audio/ogg":
      return ascii(data, 0, "OggS");
    case "audio/mpeg": {
      const second = data[1];
      return (
        ascii(data, 0, "ID3") ||
        (second !== undefined && data[0] === 0xff && (second & 0xe0) === 0xe0)
      );
    }
    default:
      return false;
  }
}

export const assetId = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const validId = (id: string) => /^[0-9a-f]{64}$/.test(id);

/** ディスクに置く（S3 互換ストレージがないとき） */
export class DiskAssetStore implements AssetStore {
  constructor(private readonly dir: string) {}

  async put(data: Buffer, contentType: string): Promise<string> {
    const id = assetId(data);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, id), data);
    await writeFile(join(this.dir, `${id}.type`), contentType);
    return id;
  }

  async get(id: string): Promise<StoredAsset | null> {
    if (!validId(id)) return null;
    try {
      const [data, contentType] = await Promise.all([
        readFile(join(this.dir, id)),
        readFile(join(this.dir, `${id}.type`), "utf8"),
      ]);
      return { data, contentType };
    } catch {
      return null;
    }
  }
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** S3 互換ストレージに置く */
export class S3AssetStore implements AssetStore {
  private readonly s3: S3Client;
  private ready: Promise<void> | null = null;

  constructor(private readonly config: S3Config) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  private ensureBucket(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      } catch {
        await this.s3.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
      }
    })();
    return this.ready;
  }

  async put(data: Buffer, contentType: string): Promise<string> {
    await this.ensureBucket();
    const id = assetId(data);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: `assets/${id}`,
        Body: data,
        ContentType: contentType,
      }),
    );
    return id;
  }

  async get(id: string): Promise<StoredAsset | null> {
    if (!validId(id)) return null;
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: `assets/${id}` }),
      );
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) return null;
      return {
        data: Buffer.from(bytes),
        contentType: res.ContentType ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  }
}
