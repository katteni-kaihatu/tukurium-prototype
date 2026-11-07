import { describe, expect, it } from "vitest";
import type { DiffEntry, DiffLine } from "./diffView";
import { revertAsk } from "./revertAsk";

function entry(partial: Partial<DiffEntry> = {}): DiffEntry {
  return {
    id: "entity:e",
    group: "entity",
    groupLabel: "エンティティ",
    name: "柱",
    kind: "modified",
    lines: [],
    ...partial,
  };
}

function line(partial: Partial<DiffLine> & Pick<DiffLine, "label">): DiffLine {
  return { before: null, after: null, ...partial };
}

describe("戻す前の確認", () => {
  it("欄ひとつなら、名前と欄を言う", () => {
    expect(
      revertAsk(
        entry({
          lines: [
            line({
              label: "shape",
              before: "円柱",
              after: "ボックス",
              section: { key: "state:mesh", label: "Mesh", change: "modified" },
            }),
          ],
        }),
      ),
    ).toBe("柱 の Mesh の shape を、最後に保存した形に戻しますか？");
  });

  it("同じ KokoState の複数の欄は、その名前でまとめる", () => {
    const section = { key: "state:mesh", label: "Mesh", change: "modified" as const };
    expect(
      revertAsk(
        entry({
          lines: [line({ label: "色", section }), line({ label: "形", section })],
        }),
      ),
    ).toBe("柱 の Mesh を、最後に保存した形に戻しますか？");
  });

  it("新しいものは、消えると知らせる", () => {
    expect(revertAsk(entry({ kind: "added", name: "箱" }))).toBe(
      "箱 は最後の保存にありません。消しますか？",
    );
  });

  it("消えたものは、戻ると知らせる", () => {
    expect(revertAsk(entry({ kind: "removed", name: "箱" }))).toBe("消えた 箱 を、戻しますか？");
  });

  it("中身がまだ無いときは、保存した形に戻すとだけ言う", () => {
    expect(revertAsk(null)).toBe("最後に保存した形に戻しますか？");
  });
});
