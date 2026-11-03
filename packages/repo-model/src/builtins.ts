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
  Grabbable: "builtin.Grabbable",
  AudioSource: "builtin.AudioSource",
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
      /** GLB の素材 ID。指定すると形状の代わりにモデルを表示する（当たり判定は size のまま） */
      { id: "model", name: "model", type: "resource", default: null },
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
      /** 視点に対する位置（m）。右クリックで持ったときは、持った瞬間の位置を入れる */
      { id: "offset", name: "offset", type: "vec3", default: [0.25, -0.22, -0.5] },
      /** 視点に対する角度（度）。右クリックで持ったときは、持った瞬間の角度を入れる */
      { id: "rotation", name: "rotation", type: "vec3", default: [0, 0, 0] },
      /** 持っている人の ID。空なら、見ている人みんなが自分の手に持つ（銃のサンプルなど） */
      { id: "player", name: "player", type: "string", default: "" },
    ],
  },
  {
    id: BUILTIN.Grabbable,
    name: "Grabbable",
    builtin: true,
    fields: [
      /** 以前、持ったときに目の前へ寄せる距離だった。いまは持った位置を保つので使わない */
      { id: "distance", name: "distance", type: "number", default: 1.2 },
    ],
  },
  {
    id: BUILTIN.AudioSource,
    name: "AudioSource",
    builtin: true,
    fields: [
      /** 音声の素材 ID */
      { id: "clip", name: "clip", type: "resource", default: null },
      { id: "volume", name: "volume", type: "number", default: 1 },
    ],
  },
];

/** Resource 型の Built-in フィールドが参照する素材の種類 */
export const RESOURCE_KIND: Record<string, "material" | "model" | "image" | "audio"> = {
  [`${BUILTIN.Mesh}/material`]: "material",
  [`${BUILTIN.Mesh}/model`]: "model",
  [`${BUILTIN.AudioSource}/clip`]: "audio",
};

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
