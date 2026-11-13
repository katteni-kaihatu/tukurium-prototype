import { describe, expect, it } from "vitest";
import { BUILTIN } from "../builtins";
import type { EntityDef, ProjectSnapshot } from "../schema";
import { checkProjectReferences } from "./references";

function snap(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    version: 1,
    name: "p",
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    outputs: [{ id: "out", name: "射撃場", kind: "item", systems: [], keep: [] }],
    entities: [],
    folders: [],
    placement: {},
    ...over,
  };
}
const ent = (
  id: string,
  states: EntityDef["states"] = {},
  over: Partial<EntityDef> = {},
): EntityDef => ({
  id,
  name: id,
  parent: null,
  output: "out",
  order: 0,
  states,
  ...over,
});
const mat = (id: string, map: string | null = null) => ({
  id,
  name: id,
  color: "#fff",
  roughness: 1,
  metalness: 0,
  map,
});
const codes = (s: ProjectSnapshot) =>
  checkProjectReferences(s)
    .map((d) => [d.code, d.subject.id, d.severity])
    .sort();

describe("checkProjectReferences", () => {
  it("参照が全部そろっていれば何も出さない", () => {
    expect(
      codes(
        snap({
          materials: [mat("m", "img")],
          assets: [
            { id: "img", name: "Bark", kind: "image", contentType: "image/png" },
            { id: "glb", name: "Gun", kind: "model", contentType: "model/gltf-binary" },
          ],
          entities: [ent("e", { [BUILTIN.Mesh]: { material: "m", model: "glb" } })],
        }),
      ),
    ).toEqual([]);
  });

  it("Material がない画像を指すと、Material を対象に一件出す", () => {
    const ds = checkProjectReferences(snap({ materials: [mat("m", "gone")] }));
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      code: "missing-resource",
      severity: "error",
      provider: "references",
      subject: { kind: "material", id: "m" },
      location: { kind: "property", path: ["map"] },
    });
  });

  it("種類の違う素材を指すと、別の問題として出す", () => {
    expect(
      codes(
        snap({
          materials: [mat("m", "snd")],
          assets: [{ id: "snd", name: "Bang", kind: "audio", contentType: "audio/mpeg" }],
          entities: [ent("e", { [BUILTIN.Mesh]: { material: "snd", model: undefined } })],
        }),
      ),
    ).toEqual([
      ["wrong-resource-kind", "e", "error"],
      ["wrong-resource-kind", "m", "error"],
    ]);
  });

  it("アウトプットのサムネイルは、Resources にある画像だけ（ADR 0046）", () => {
    const out = (thumbnail: string) => [
      { id: "out", name: "射撃場", kind: "item" as const, systems: [], keep: [], thumbnail },
    ];
    const assets = [
      { id: "img", name: "thumb", kind: "image" as const, contentType: "image/png" },
      { id: "snd", name: "Bang", kind: "audio" as const, contentType: "audio/mpeg" },
    ];
    expect(checkProjectReferences(snap({ outputs: out("img"), assets }))).toEqual([]);
    expect(checkProjectReferences(snap({ outputs: out("gone"), assets }))[0]).toMatchObject({
      code: "missing-resource",
      subject: { kind: "output", id: "out" },
      location: { kind: "property", path: ["thumbnail"] },
    });
    expect(checkProjectReferences(snap({ outputs: out("snd"), assets }))[0]).toMatchObject({
      code: "wrong-resource-kind",
      subject: { kind: "output", id: "out" },
    });
  });

  it("Entity のリソース・Entity のフィールドの参照切れ", () => {
    const ds = checkProjectReferences(
      snap({
        kokostates: [
          {
            id: "ks_aim",
            name: "Aim",
            fields: [
              { id: "f_t", name: "target", type: "EntityRef | undefined", default: undefined },
            ],
          },
        ],
        entities: [
          ent("e", {
            [BUILTIN.AudioSource]: { clip: "gone" },
            ks_aim: { f_t: "ent_gone" },
          }),
        ],
      }),
    );
    expect(ds.map((d) => [d.code, d.location])).toEqual([
      ["missing-resource", { kind: "property", path: [BUILTIN.AudioSource, "clip"] }],
      ["missing-entity", { kind: "property", path: ["ks_aim", "f_t"] }],
    ]);
    expect(ds[1]?.related).toEqual([{ kind: "kokostate", id: "ks_aim" }]);
  });

  it("定義のない KokoState を持つ Entity を警告する", () => {
    expect(codes(snap({ entities: [ent("e", { ks_gone: {} })] }))).toEqual([
      ["missing-kokostate", "e", "warning"],
    ]);
  });

  it("Entity の親子とアウトプットのくい違い", () => {
    expect(
      codes(
        snap({
          outputs: [
            { id: "out", name: "a", kind: "item", systems: [], keep: [] },
            { id: "out2", name: "b", kind: "item", systems: [], keep: [] },
          ],
          entities: [
            ent("lost", {}, { output: "out_gone" }),
            ent("orphan", {}, { parent: "ent_gone" }),
            ent("a", {}, { parent: "b" }),
            ent("b", {}, { parent: "a" }),
            ent("p", {}),
            ent("c", {}, { parent: "p", output: "out2" }),
          ],
        }),
      ),
    ).toEqual([
      ["entity-output-missing", "lost", "error"],
      ["entity-parent-cycle", "a", "error"],
      ["entity-parent-missing", "orphan", "error"],
      ["entity-parent-other-output", "c", "error"],
    ]);
  });

  it("アウトプットの System と状態維持マークの参照切れを警告する", () => {
    expect(
      codes(
        snap({
          kokostates: [
            {
              id: "ks",
              name: "Gun",
              fields: [{ id: "f", name: "ammo", type: "number", default: 0 }],
            },
          ],
          entities: [ent("e", { ks: { f: 1 } })],
          outputs: [
            {
              id: "out",
              name: "a",
              kind: "item",
              systems: [{ id: "sys_gone", enabled: true }],
              keep: [
                { entity: "e", koko: "ks", field: "f" },
                { entity: "e", koko: "ks", field: "f_gone" },
                { entity: "ent_gone", koko: "ks", field: "f" },
              ],
            },
          ],
        }),
      ),
    ).toEqual([
      ["keep-invalid", "out", "warning"],
      ["keep-invalid", "out", "warning"],
      ["output-system-missing", "out", "warning"],
    ]);
  });
});
