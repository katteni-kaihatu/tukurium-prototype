import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DebugSettingsDoc } from "./debugSettings";
import { ProjectDoc } from "./projectDoc";

describe("保存しないデバッグ設定", () => {
  it("型定義を停止位置にしない", () => {
    const project = new ProjectDoc();
    const id = project.addTypeDef("type", "export interface T { x: number }");
    const debug = new DebugSettingsDoc(project);
    expect(debug.add(id, 1)).toBeNull();
    expect(debug.read().breakpoints).toEqual([]);
    debug.dispose();
    project.doc.destroy();
  });
  it("共有し、行の前への共同編集に追従し、付けた行を消すと条件も消える", () => {
    const a = new ProjectDoc();
    const id = a.addSystem("test", "first();\nsecond();\nlast();");
    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const da = new DebugSettingsDoc(a);
    const db = new DebugSettingsDoc(b);
    da.setEnabled(true);
    da.add(id, 2);
    Y.applyUpdate(db.doc, Y.encodeStateAsUpdate(da.doc));
    expect(db.read().breakpoints[0]?.line).toBe(2);
    b.code(id)?.insert(0, "added();\n");
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    expect(da.read().breakpoints[0]?.line).toBe(3);
    const text = a.code(id);
    if (!text) throw new Error("コードがありません");
    const start = text.toString().indexOf("second");
    text.delete(start, 1);
    text.insert(start, "S");
    da.prune();
    expect(da.read().breakpoints[0]?.line).toBe(3);
    text.delete(start, "second();\n".length);
    da.prune();
    expect(da.read().breakpoints).toEqual([]);
    da.dispose();
    db.dispose();
    a.doc.destroy();
    b.doc.destroy();
  });
  const withPoint = (code: string, line: number) => {
    const project = new ProjectDoc();
    const id = project.addSystem("test", code);
    const debug = new DebugSettingsDoc(project);
    debug.add(id, line);
    const text = project.code(id);
    if (!text) throw new Error("コードがありません");
    return { debug, text, lines: () => debug.read().breakpoints.map((p) => p.line) };
  };
  it("行の中身を消してから前の行とつなげると、条件も消える", () => {
    const { debug, text, lines } = withPoint("first();\nsecond();\nlast();", 2);
    text.delete("first();\n".length, "second();".length);
    expect(lines()).toEqual([2]);
    text.delete("first();".length, 1);
    expect(lines()).toEqual([]);
    debug.dispose();
  });
  it("前の行の終わりから付けた行の終わりまでを消すと、条件も消える", () => {
    const { debug, text, lines } = withPoint("first();\nsecond();\nlast();", 2);
    text.delete("first();".length, "\nsecond();".length);
    expect(lines()).toEqual([]);
    debug.dispose();
  });
  it("中身を残して前の行とつなげたときと、中身を打ち直したときは、条件を残す", () => {
    const joined = withPoint("first();\nsecond();\nlast();", 2);
    joined.text.delete("first();".length, 1);
    expect(joined.lines()).toEqual([1]);
    joined.debug.dispose();
    const retyped = withPoint("first();\nsecond();\nlast();", 2);
    retyped.text.delete("first();\n".length, "second();".length);
    retyped.text.insert("first();\n".length, "other();");
    expect(retyped.lines()).toEqual([2]);
    retyped.debug.dispose();
  });
  it("制作データとそのYjs保存には設定を入れない。切っても条件は残す", () => {
    const project = new ProjectDoc();
    const id = project.addSystem("test", "run();");
    const before = Y.encodeStateAsUpdate(project.doc);
    const debug = new DebugSettingsDoc(project);
    debug.add(id, 1, "logpoint");
    debug.setEnabled(true);
    debug.setEnabled(false);
    expect(debug.read().breakpoints).toHaveLength(1);
    expect(Y.encodeStateAsUpdate(project.doc)).toEqual(before);
    debug.dispose();
    project.doc.destroy();
  });
});
