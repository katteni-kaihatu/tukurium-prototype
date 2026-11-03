import { createHash } from "node:crypto";
import { SAMPLE_MODEL } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { SAMPLE_MODEL_BLOBS } from "./sampleModels.generated";

describe("同梱の木のモデル", () => {
  it("中身の SHA-256 が、サンプルの指す ID と一致する", () => {
    const byName = new Map(SAMPLE_MODEL_BLOBS.map((b) => [b.name, b]));
    for (const model of Object.values(SAMPLE_MODEL)) {
      const blob = byName.get(model.name);
      expect(blob?.id).toBe(model.id);
      const data = Buffer.from(blob?.base64 ?? "", "base64");
      expect(createHash("sha256").update(data).digest("hex")).toBe(model.id);
      expect(data.subarray(0, 4).toString("ascii")).toBe("glTF");
    }
  });
});
