import { type KokoStateDef, KokoStateRegistry } from "@tukurium/eks";

/**
 * Built-in の KokoState。利用者定義と同じ仕組みに載せ、ID は固定する。
 * 描画・物理・入力など、アプリ側が意味を知っているものだけをここに置く。
 */
export const BUILTIN = {
  Transform: "builtin.Transform",
  Mesh: "builtin.Mesh",
  Collider: "builtin.Collider",
  RigidBody: "builtin.RigidBody",
  Held: "builtin.Held",
} as const;

/** プロシージャルメッシュの形状。size の意味は形状ごとに異なる（docs/PLAN.md §6 参照）。 */
export const MESH_SHAPES = ["box", "sphere", "cylinder", "capsule", "plane"] as const;
export type MeshShape = (typeof MESH_SHAPES)[number];

export const RIGID_BODY_TYPES = ["fixed", "dynamic", "kinematic"] as const;

export const BUILTIN_KOKOSTATES: KokoStateDef[] = [
  {
    id: BUILTIN.Transform,
    name: "Transform",
    builtin: true,
    fields: [
      { id: "position", name: "position", type: "vec3", default: [0, 0, 0] },
      /** オイラー角（度） */
      { id: "rotation", name: "rotation", type: "vec3", default: [0, 0, 0] },
      { id: "scale", name: "scale", type: "vec3", default: [1, 1, 1] },
    ],
  },
  {
    id: BUILTIN.Mesh,
    name: "Mesh",
    builtin: true,
    fields: [
      { id: "shape", name: "shape", type: "string", default: "box" },
      /** box: 幅・高さ・奥行き／sphere: 直径（x）／cylinder・capsule: 直径（x）と高さ（y）／plane: 幅（x）と奥行き（z） */
      { id: "size", name: "size", type: "vec3", default: [1, 1, 1] },
      { id: "material", name: "material", type: "resource", default: null },
      /** マテリアル未指定のときの色 */
      { id: "color", name: "color", type: "color", default: "#d8d2c6" },
    ],
  },
  {
    id: BUILTIN.Collider,
    name: "Collider",
    builtin: true,
    fields: [
      /** true なら当たり判定だけ（押し返さない） */
      { id: "sensor", name: "sensor", type: "boolean", default: false },
    ],
  },
  {
    id: BUILTIN.RigidBody,
    name: "RigidBody",
    builtin: true,
    fields: [
      { id: "type", name: "type", type: "string", default: "dynamic" },
      { id: "linvel", name: "linvel", type: "vec3", default: [0, 0, 0] },
    ],
  },
  {
    id: BUILTIN.Held,
    name: "Held",
    builtin: true,
    fields: [
      /** Play 中、自分の視点に対してこの位置に持つ（m） */
      { id: "offset", name: "offset", type: "vec3", default: [0.25, -0.22, -0.5] },
    ],
  },
];

export function isBuiltin(id: string): boolean {
  return id.startsWith("builtin.");
}

/** Built-in と利用者定義をまとめた登録簿を作る。 */
export function buildRegistry(userDefs: KokoStateDef[]): KokoStateRegistry {
  const registry = new KokoStateRegistry();
  for (const def of BUILTIN_KOKOSTATES) registry.register(def);
  for (const def of userDefs) registry.register(def);
  return registry;
}
