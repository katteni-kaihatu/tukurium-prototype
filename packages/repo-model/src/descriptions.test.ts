import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { fromFiles, toFiles } from "./files";
import { ProjectDoc } from "./projectDoc";
import { gunAndTargetSample } from "./samples";

describe("KokoState の説明", () => {
  it("保存と読み込みで、KokoState とフィールドの説明を保つ", () => {
    const snapshot = gunAndTargetSample();
    expect(fromFiles(toFiles(snapshot)).kokostates).toEqual(snapshot.kokostates);
    const doc = new ProjectDoc();
    doc.load(snapshot);
    expect(doc.snapshot().kokostates).toEqual(snapshot.kokostates);
  });

  it("別々の説明を同時に編集しても両方残り、説明を消す操作も同期する", () => {
    const a = new ProjectDoc();
    a.load(gunAndTargetSample());
    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const av = Y.encodeStateVector(a.doc),
      bv = Y.encodeStateVector(b.doc);
    const ka = a.kokostate("ks_gun"),
      kb = b.kokostate("ks_gun");
    if (!ka || !kb) throw new Error("Gun がありません");
    a.updateKokoState({ ...ka, description: "全体の説明" });
    b.updateKokoState({
      ...kb,
      fields: kb.fields.map((f) => (f.name === "ammo" ? { ...f, description: "残弾数" } : f)),
    });
    const au = Y.encodeStateAsUpdate(a.doc, av),
      bu = Y.encodeStateAsUpdate(b.doc, bv);
    Y.applyUpdate(a.doc, bu);
    Y.applyUpdate(b.doc, au);
    expect(a.kokostate("ks_gun")).toEqual(b.kokostate("ks_gun"));
    expect(a.kokostate("ks_gun")?.description).toBe("全体の説明");
    expect(a.kokostate("ks_gun")?.fields[0]?.description).toBe("残弾数");
    const next = a.kokostate("ks_gun");
    if (!next) throw new Error("Gun がありません");
    a.updateKokoState({
      ...next,
      description: undefined,
      fields: next.fields.map((f) => ({ ...f, description: undefined })),
    });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.kokostate("ks_gun")?.description).toBeUndefined();
    expect(b.kokostate("ks_gun")?.fields[0]?.description).toBeUndefined();
  });
});
