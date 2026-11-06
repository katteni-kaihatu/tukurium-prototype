import { BUILTIN_KOKOSTATES } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { catalogEntries, catalogTags, filterCatalog } from "./kokoCatalog";

const gun = {
  id: "ks_gun",
  name: "Gun",
  role: "game",
  fields: [{ id: "ammo", name: "ammo", type: "number" as const, default: 5 }],
};
const tag = { id: "ks_tag", name: "Enemy", fields: [] };
const pkgHealth = { id: "pkg:w1@1:ks_hp", name: "Health", role: "game", fields: [] };
const entries = catalogEntries([...BUILTIN_KOKOSTATES, gun, tag, pkgHealth], (d) =>
  d.id.startsWith("pkg:") ? "combat" : null,
);
const names = (q: string, sel: string[] = []) =>
  filterCatalog(entries, q, new Set(sel)).map((e) => e.def.name);

describe("KokoState を選ぶ画面の絞り込み", () => {
  it("検索は名前・フィールド名・別名に当てる。並びは自作 → ライブラリ → Built-in", () => {
    expect(names("ammo")).toEqual(["Gun"]);
    expect(names("combat")).toEqual(["Health"]);
    expect(names("").slice(0, 3)).toEqual(["Enemy", "Gun", "Health"]);
  });

  it("同じ組のタグはどれか、組をまたぐと両方に合うものだけ", () => {
    expect(names("", ["role:physics"])).toEqual(["Collider", "RigidBody"]);
    expect(names("", ["role:physics", "role:audio"])).toEqual([
      "AudioSource",
      "Collider",
      "RigidBody",
    ]);
    expect(names("", ["role:game"])).toEqual(["Gun", "Health"]);
    expect(names("", ["role:game", "source:project"])).toEqual(["Gun"]);
    expect(names("", ["role:none"])).toEqual(["Enemy"]);
  });

  it("タグの件数は、検索ともう一方の組の選択を当てた数。無いタグは出さない", () => {
    const tags = catalogTags(entries, "", new Set(["source:builtin"]));
    const count = (id: string) => tags.find((t) => t.id === id)?.count;
    expect(count("role:physics")).toBe(2);
    expect(count("role:game")).toBe(0);
    expect(count("source:project")).toBe(2);
    expect(count("source:pkg:combat")).toBe(1);
    expect(tags.find((t) => t.id === "source:pkg:combat")?.label).toBe("@combat");
    const onlyBuiltin = catalogTags(
      catalogEntries(BUILTIN_KOKOSTATES, () => null),
      "",
      new Set(),
    );
    expect(onlyBuiltin.some((t) => t.id === "role:game" || t.id === "source:project")).toBe(false);
  });
});
