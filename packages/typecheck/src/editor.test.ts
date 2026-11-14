import {
  gunAndTargetSample,
  officialLibraries,
  packageManifest,
  packageResourceId,
} from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { TypeChecker } from "./checker";
import { nodeTypeCheckerOptions } from "./node";

function fixture() {
  const snapshot = gunAndTargetSample();
  const gun = snapshot.kokostates.find((k) => k.name === "Gun");
  if (!gun) throw new Error("Gun がありません");
  gun.description = "残弾と射撃の設定";
  const ammo = gun.fields.find((f) => f.name === "ammo");
  if (!ammo) throw new Error("ammo がありません");
  ammo.description = "残っている弾の数。*/ も文章として読めます。";
  const code =
    'import Gun from "./Gun.koko";\nexport default system({ query: { with: [Gun] }, onUpdate(e) { const gun = e.get(Gun); gun.ammo = 1; world.raycast([0,0,0], [0,0,1], 10); } });';
  snapshot.systems.push({ id: "sys_editor", name: "Editor", code });
  const checker = new TypeChecker(nodeTypeCheckerOptions());
  const input = { snapshot, packages: new Map(), hostDeclarations: hostApiDeclarations() };
  checker.prepare(input);
  const location = { fileId: "sys_editor", code, position: code.indexOf("ammo") + 1 };
  return { checker, location, input };
}

describe("エディタからの型の問い合わせ", () => {
  it("取り出した KokoState のフィールドに型と JSDoc が残り、コメントの終端も宣言を壊さない", () => {
    const { checker, location } = fixture();
    const info = checker.query({ ...location, kind: "hover" });
    expect(info?.display).toContain("ammo: number");
    expect(info?.documentation).toContain("残っている弾の数");
    expect(info?.diagnostics).toEqual([]);
    expect(checker.checkSystem(location.fileId)).toEqual([]);
  });

  it("変数と Host API の型と説明を返す", () => {
    const { checker, location } = fixture();
    const variable = checker.query({
      ...location,
      kind: "hover",
      position: location.code.indexOf("const gun") + 7,
    });
    expect(variable?.display).toContain("const gun:");
    const api = checker.query({
      ...location,
      kind: "hover",
      position: location.code.indexOf("raycast") + 1,
    });
    expect(api?.display).toContain("raycast");
    expect(api?.documentation.length).toBeGreaterThan(0);
    expect(api?.definition).toBeNull();
  });

  it("フィールドの候補と、選んだ候補の型・説明を返す", () => {
    const { checker, location } = fixture();
    const position = location.code.indexOf("ammo");
    const entries = checker.query({ ...location, kind: "completions", position });
    expect(entries.map((e) => e.name)).toContain("ammo");
    const details = checker.query({ ...location, kind: "details", position, name: "ammo" });
    expect(details?.display).toContain("number");
    expect(details?.documentation).toContain("残っている弾の数");
  });

  it("KokoState と同じファイルの変数の定義へ移れる", () => {
    const { checker, location } = fixture();
    const koko = checker.query({
      ...location,
      kind: "hover",
      position: location.code.indexOf("get(Gun") + 5,
    });
    expect(koko?.documentation).toContain("残弾と射撃の設定");
    expect(koko?.definition).toMatchObject({ kind: "koko", id: "ks_gun" });
    const variable = checker.query({
      ...location,
      kind: "definition",
      position: location.code.indexOf("gun.ammo") + 1,
    });
    expect(variable).toMatchObject({ kind: "code", id: "sys_editor", line: 2 });
  });

  it("一つのファイルだけを差し替え、新しい型と型エラーを返す", () => {
    const { checker, location } = fixture();
    const code = "const message = 123; message.toUpperCase();";
    const info = checker.query({
      ...location,
      kind: "hover",
      code,
      position: code.indexOf("message.to") + 1,
    });
    expect(info?.display).toContain("123");
    const error = checker.query({
      ...location,
      kind: "hover",
      code,
      position: code.indexOf("toUpperCase") + 1,
    });
    expect(error?.diagnostics.length).toBeGreaterThan(0);
    expect(checker.query({ ...location, kind: "hover", fileId: "removed" })).toBeNull();
  });

  it("型の定義のエディタを開ける位置を返し、その編集中の本文も読める", () => {
    const { checker, input, location } = fixture();
    input.snapshot.types = [
      { id: "td_card", name: "Card", code: "export interface Card { rank: number }" },
    ];
    checker.prepare(input);
    const code = 'import type { Card } from "./Card.types"; let card: Card;';
    expect(
      checker.query({
        ...location,
        code,
        kind: "definition",
        position: code.lastIndexOf("Card") + 1,
      }),
    ).toMatchObject({ kind: "code", id: "td_card", line: 1 });
    const typeCode = "export interface Card { rank: string }";
    expect(
      checker.query({
        fileId: "td_card",
        code: typeCode,
        kind: "hover",
        position: typeCode.indexOf("rank") + 1,
      })?.display,
    ).toContain("rank: string");
  });

  it("別のフォルダに同じ名前の KokoState があっても定義を区別する", () => {
    const { checker, input, location } = fixture();
    input.snapshot.folders = [{ id: "folder", name: "Other", parent: null }];
    input.snapshot.placement = { other_gun: "folder" };
    input.snapshot.kokostates.push({ id: "other_gun", name: "Gun", fields: [] });
    checker.prepare(input);
    const code = 'import Gun from "./Other/Gun.koko"; Gun;';
    expect(
      checker.query({
        ...location,
        code,
        kind: "definition",
        position: code.lastIndexOf("Gun") + 1,
      }),
    ).toMatchObject({ kind: "koko", id: "other_gun" });
  });

  it("Built-in と公式ライブラリの KokoState の定義と説明を返す", () => {
    const { checker, input, location } = fixture();
    const library = officialLibraries().find((l) => l.alias === "combat");
    if (!library) throw new Error("ライブラリがありません");
    const dependency = {
      alias: library.alias,
      packageId: library.workId,
      version: 1,
      contentHash: "test",
    };
    input.packages.set(library.alias, {
      status: "ready",
      dependency,
      manifest: packageManifest(library.snapshot, library.outputId),
    });
    checker.prepare(input);
    const code =
      'import Health from "@combat/Health.koko"; import Transform from "@builtin/Transform.koko"; Health; Transform;';
    const health = checker.query({
      ...location,
      code,
      kind: "hover",
      position: code.lastIndexOf("Health") + 1,
    });
    expect(health?.definition).toMatchObject({
      kind: "koko",
      id: packageResourceId(dependency, "ks_health"),
    });
    expect(health?.documentation).toContain("体力");
    expect(
      checker.query({
        ...location,
        code,
        kind: "definition",
        position: code.lastIndexOf("Transform") + 1,
      }),
    ).toMatchObject({ kind: "koko", id: "builtin.Transform" });
  });
});
