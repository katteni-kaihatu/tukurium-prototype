import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import { normalizeName, ResourcePathIndex, validateName } from "./resourcePath";
import type { ProjectSnapshot } from "./schema";

function snap(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    version: 1,
    name: "p",
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    outputs: [],
    entities: [],
    folders: [],
    placement: {},
    ...over,
  };
}

const koko = (id: string, name: string) => ({ id, name, fields: [] });
const sys = (id: string, name: string) => ({ id, name, code: "" });

describe("ResourcePathIndex", () => {
  it("別のフォルダにある同じ名前の KokoState を、別々の ID に解決する", () => {
    const idx = ResourcePathIndex.fromSnapshot(
      snap({
        kokostates: [koko("ks_a", "Gun"), koko("ks_b", "Gun")],
        folders: [
          { id: "f_a", name: "A", parent: null },
          { id: "f_b", name: "B", parent: null },
        ],
        placement: { ks_a: "f_a", ks_b: "f_b" },
      }),
    );
    expect(idx.pathOf("ks_a")).toBe("/A/Gun.koko");
    expect(idx.pathOf("ks_b")).toBe("/B/Gun.koko");
    expect(idx.resolve("/A/Gun.koko")).toEqual({ ok: true, id: "ks_a", kind: "kokostate" });
    expect(idx.resolve("/B/Gun.koko")).toEqual({ ok: true, id: "ks_b", kind: "kokostate" });
  });

  it("System の入っているフォルダを基準に、相対パスを解決する", () => {
    const idx = ResourcePathIndex.fromSnapshot(
      snap({
        kokostates: [koko("ks_gun", "Gun"), koko("ks_hp", "Health")],
        systems: [sys("sys_shoot", "Shoot")],
        folders: [
          { id: "f_combat", name: "Combat", parent: null },
          { id: "f_states", name: "States", parent: "f_combat" },
          { id: "f_systems", name: "Systems", parent: "f_combat" },
        ],
        placement: { ks_gun: "f_states", ks_hp: "f_systems", sys_shoot: "f_systems" },
      }),
    );
    expect(idx.resolve("../States/Gun.koko", "sys_shoot")).toMatchObject({
      ok: true,
      id: "ks_gun",
    });
    expect(idx.resolve("./Health.koko", "sys_shoot")).toMatchObject({ ok: true, id: "ks_hp" });
    expect(idx.resolve("Health.koko", "sys_shoot")).toMatchObject({ ok: true, id: "ks_hp" });
    expect(idx.resolve("../../Combat/States/Gun.koko", "sys_shoot")).toMatchObject({
      ok: true,
      id: "ks_gun",
    });
  });

  it("いちばん上より外へ出る .. は解決しない", () => {
    const idx = ResourcePathIndex.fromSnapshot(snap({ systems: [sys("s", "S")] }));
    expect(idx.resolve("../Gun.koko", "s")).toEqual({ ok: false, reason: "escapes-root" });
  });

  it("相対パスには基準の System が要る", () => {
    const idx = ResourcePathIndex.fromSnapshot(snap());
    expect(idx.resolve("./Gun.koko")).toEqual({ ok: false, reason: "no-base" });
  });

  it("@builtin/ は Built-in の固定 ID に解決する", () => {
    const idx = ResourcePathIndex.fromSnapshot(snap());
    expect(idx.resolve("@builtin/Transform.koko")).toEqual({
      ok: true,
      id: BUILTIN.Transform,
      kind: "kokostate",
    });
    expect(idx.resolve("@builtin/Nope.koko")).toEqual({ ok: false, reason: "not-found" });
    expect(idx.pathOf(BUILTIN.Mesh)).toBe("@builtin/Mesh.koko");
  });

  it("拡張子で種類を区別する", () => {
    const idx = ResourcePathIndex.fromSnapshot(
      snap({
        materials: [{ id: "m_wood", name: "Wood", color: "#a07040", roughness: 1, metalness: 0 }],
        assets: [{ id: "sha", name: "Bark", kind: "image", contentType: "image/png" }],
      }),
    );
    expect(idx.pathOf("m_wood")).toBe("/Wood.material");
    expect(idx.pathOf("sha")).toBe("/Bark.image");
    expect(idx.resolve("/Wood.koko")).toEqual({ ok: false, reason: "not-found" });
    expect(idx.resolve("/Wood.material")).toMatchObject({ ok: true, id: "m_wood" });
  });

  it("フォルダのパスと、大文字・小文字や NFC の違いを同じとみなす解決", () => {
    const idx = ResourcePathIndex.fromSnapshot(
      snap({
        kokostates: [koko("ks", "Café")],
        folders: [{ id: "f", name: "States", parent: null }],
        placement: { ks: "f" },
      }),
    );
    expect(idx.pathOf("f")).toBe("/States");
    expect(idx.resolve("/States")).toEqual({ ok: true, id: "f", kind: "folder" });
    expect(idx.resolve("/states/CAFÉ.koko")).toMatchObject({ ok: true, id: "ks" });
  });

  it("名前を変えたり移したりしても ID は同じで、パスだけが変わる", () => {
    const base = snap({
      kokostates: [koko("ks", "Gun")],
      folders: [
        { id: "f_a", name: "A", parent: null },
        { id: "f_b", name: "B", parent: null },
      ],
      placement: { ks: "f_a" },
    });
    const moved = snap({
      ...base,
      kokostates: [koko("ks", "Rifle")],
      folders: [
        { id: "f_a", name: "A", parent: "f_b" },
        { id: "f_b", name: "Weapons", parent: null },
      ],
    });
    expect(ResourcePathIndex.fromSnapshot(base).pathOf("ks")).toBe("/A/Gun.koko");
    const idx = ResourcePathIndex.fromSnapshot(moved);
    expect(idx.pathOf("ks")).toBe("/Weapons/A/Rifle.koko");
    expect(idx.resolve("/Weapons/A/Rifle.koko")).toMatchObject({ id: "ks" });
  });

  it("同じ親の直下でぶつかる名前は、種類をまたいで見つけ、どれにも解決しない", () => {
    const idx = ResourcePathIndex.fromSnapshot(
      snap({
        kokostates: [koko("ks", "Gun")],
        systems: [sys("sy", "gun")],
        folders: [{ id: "f", name: "GUN", parent: null }],
      }),
    );
    expect(idx.collisions()).toEqual([{ parent: null, key: "gun", ids: ["f", "ks", "sy"] }]);
    expect(idx.resolve("/Gun.koko")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("輪になったフォルダはパスを持たない", () => {
    const idx = ResourcePathIndex.fromSnapshot(
      snap({
        kokostates: [koko("ks", "Gun")],
        folders: [
          { id: "f_a", name: "A", parent: "f_b" },
          { id: "f_b", name: "B", parent: "f_a" },
        ],
        placement: { ks: "f_a" },
      }),
    );
    expect(idx.cycles()).toEqual([["f_a", "f_b"]]);
    expect(idx.pathOf("f_a")).toBeNull();
    expect(idx.pathOf("ks")).toBeNull();
  });

  it("ないフォルダを指す置き場所は、いちばん上に置いたものとして扱う", () => {
    const idx = ResourcePathIndex.fromSnapshot(
      snap({ kokostates: [koko("ks", "Gun")], placement: { ks: "f_gone" } }),
    );
    expect(idx.pathOf("ks")).toBe("/Gun.koko");
  });
});

describe("名前の規則", () => {
  it("使えない名前", () => {
    expect(validateName("Gun")).toBeNull();
    expect(validateName("")).toBe("empty");
    expect(validateName("  ")).toBe("empty");
    expect(validateName("a/b")).toBe("slash");
    expect(validateName("a\0b")).toBe("nul");
    expect(validateName(".")).toBe("dot");
    expect(validateName("..")).toBe("dot");
    expect(validateName("@builtin")).toBe("reserved");
    expect(validateName("@builtinX")).toBe("reserved");
  });

  it("比べるときは NFC にして大文字・小文字をそろえる", () => {
    expect(normalizeName("Café")).toBe(normalizeName("CAFÉ"));
  });
});

describe("spellingFor（リファクタリングで書き直すパス）", () => {
  const idx = ResourcePathIndex.fromSnapshot(
    snap({
      kokostates: [koko("ks_gun", "Gun"), koko("ks_top", "Top"), koko("ks_hp", "Health")],
      systems: [sys("s_deep", "Deep"), sys("s_top", "TopSys")],
      folders: [
        { id: "f_c", name: "Combat", parent: null },
        { id: "f_st", name: "States", parent: "f_c" },
        { id: "f_sy", name: "Systems", parent: "f_c" },
      ],
      placement: { ks_gun: "f_st", ks_hp: "f_sy", s_deep: "f_sy" },
    }),
  );

  it("System のフォルダからの相対パス", () => {
    expect(idx.spellingFor("ks_gun", "s_deep", "relative")).toBe("../States/Gun.koko");
    expect(idx.spellingFor("ks_hp", "s_deep", "relative")).toBe("./Health.koko");
    expect(idx.spellingFor("ks_top", "s_deep", "relative")).toBe("../../Top.koko");
    expect(idx.spellingFor("ks_gun", "s_top", "relative")).toBe("./Combat/States/Gun.koko");
  });

  it("いちばん上からのパスと Built-in", () => {
    expect(idx.spellingFor("ks_gun", "s_deep", "absolute")).toBe("/Combat/States/Gun.koko");
    expect(idx.spellingFor(BUILTIN.Transform, "s_deep", "relative")).toBe(
      "@builtin/Transform.koko",
    );
  });
});
