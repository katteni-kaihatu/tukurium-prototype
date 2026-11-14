import { FIELD_TYPE, type KokoStateDef, KokoStateRegistry, type RefTarget } from "@tukurium/eks";

/**
 * Built-in の KokoState。利用者定義と同じ仕組みに載せ、ID は固定する。
 * 描画・物理・入力など、アプリ側が意味を知っているものだけをここに置く。
 */
export const BUILTIN = {
  Transform: "builtin.Transform",
  Mesh: "builtin.Mesh",
  Collider: "builtin.Collider",
  RigidBody: "builtin.RigidBody",
  EquipmentTool: "builtin.EquipmentTool",
  Grabbable: "builtin.Grabbable",
  AudioSource: "builtin.AudioSource",
  Label: "builtin.Label",
} as const;

/** KokoState の役割。KokoState を選ぶ画面で、タグとして絞り込みに使う */
export const KOKO_ROLES = [
  { id: "transform", label: "配置" },
  { id: "look", label: "見た目" },
  { id: "physics", label: "物理" },
  { id: "interaction", label: "操作" },
  { id: "audio", label: "音" },
  { id: "text", label: "文字" },
  { id: "game", label: "遊び" },
] as const;
export type KokoRole = (typeof KOKO_ROLES)[number]["id"];

/** プロシージャルメッシュの形状。size の意味は各 KokoState 定義のコメントを参照。 */
export const MESH_SHAPES = ["box", "sphere", "cylinder", "capsule", "plane"] as const;
export type MeshShape = (typeof MESH_SHAPES)[number];

/** Collider の形。mesh は Mesh の形と大きさに合わせる */
export const COLLIDER_SHAPES = ["mesh", "box", "sphere", "cylinder", "capsule", "plane"] as const;
export type ColliderShape = (typeof COLLIDER_SHAPES)[number];

export const RIGID_BODY_TYPES = ["fixed", "dynamic", "kinematic"] as const;

export const BUILTIN_KOKOSTATES: KokoStateDef[] = [
  {
    id: BUILTIN.Transform,
    name: "Transform",
    role: "transform",
    builtin: true,
    fields: [
      { id: "position", name: "position", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
      /** オイラー角（度） */
      { id: "rotation", name: "rotation", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
      { id: "scale", name: "scale", type: FIELD_TYPE.vec3, default: [1, 1, 1] },
    ],
  },
  {
    id: BUILTIN.Mesh,
    name: "Mesh",
    role: "look",
    builtin: true,
    fields: [
      { id: "shape", name: "shape", type: FIELD_TYPE.string, default: "box" },
      /** box: 幅・高さ・奥行き／sphere: 直径（x）／cylinder・capsule: 直径（x）と高さ（y）／plane: 幅（x）と奥行き（z） */
      { id: "size", name: "size", type: FIELD_TYPE.vec3, default: [1, 1, 1] },
      { id: "material", name: "material", type: FIELD_TYPE.material, default: undefined },
      /** マテリアル未指定のときの色 */
      { id: "color", name: "color", type: FIELD_TYPE.color, default: "#d8d2c6" },
      /** GLB の素材 ID。指定すると形状の代わりにモデルを表示する（当たり判定は Collider。形を mesh にするとこの size） */
      { id: "model", name: "model", type: FIELD_TYPE.model, default: undefined },
    ],
  },
  {
    id: BUILTIN.Collider,
    name: "Collider",
    role: "physics",
    builtin: true,
    fields: [
      /**
       * mesh なら Mesh の形。box / sphere / cylinder / capsule / plane はその形だけを使う。
       * プレイヤーと RigidBody の両方が、sensor でなければここにぶつかる。
       */
      { id: "shape", name: "shape", type: FIELD_TYPE.string, default: "mesh" },
      /** 0,0,0 なら Mesh の大きさ（無ければ 1m）。それ以外は、この当たり判定だけの大きさ（m） */
      { id: "size", name: "size", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
      /** Entity の中心からのずれ（m）。拡大率は掛かる */
      { id: "offset", name: "offset", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
      /** true なら押し返さず、当たったことだけが届く */
      { id: "sensor", name: "sensor", type: FIELD_TYPE.boolean, default: false },
      /** 滑りにくさ。0 でツルツル */
      { id: "friction", name: "friction", type: FIELD_TYPE.number, default: 0.6 },
      /** 跳ね返り。0 で跳ねない */
      { id: "restitution", name: "restitution", type: FIELD_TYPE.number, default: 0 },
    ],
  },
  {
    id: BUILTIN.RigidBody,
    name: "RigidBody",
    role: "physics",
    builtin: true,
    fields: [
      /** dynamic: 重力で動く / kinematic: Transform に付いて動く / fixed: 動かない */
      { id: "type", name: "type", type: FIELD_TYPE.string, default: "dynamic" },
      /** 重さ（kg）。形では変わらない */
      { id: "mass", name: "mass", type: FIELD_TYPE.number, default: 1 },
      /** 重力の倍率。0 ならその場に浮く */
      { id: "gravityScale", name: "gravityScale", type: FIELD_TYPE.number, default: 1 },
      /** 速度の減衰。大きいほどすぐ止まる */
      { id: "linearDamping", name: "linearDamping", type: FIELD_TYPE.number, default: 0.05 },
      { id: "angularDamping", name: "angularDamping", type: FIELD_TYPE.number, default: 0.1 },
      /** 速度（m/s）。実行が書き、スクリプトからも変えられる */
      { id: "linvel", name: "linvel", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
      /** 回転の速度（ラジアン/s） */
      { id: "angvel", name: "angvel", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
      /** 速い物が薄い床をすり抜けないようにする */
      { id: "ccd", name: "ccd", type: FIELD_TYPE.boolean, default: true },
      /**
       * 軸の固定（ADR 0078）。true の軸には、ぶつかっても重力でも動かない（dynamic のときだけ効く）。
       * 軸はワールドの軸で、親や自分の向きでは変わらない。固定した軸の位置・角度は、今の値のまま保つ。
       */
      { id: "lockMoveX", name: "lockMoveX", type: FIELD_TYPE.boolean, default: false },
      { id: "lockMoveY", name: "lockMoveY", type: FIELD_TYPE.boolean, default: false },
      { id: "lockMoveZ", name: "lockMoveZ", type: FIELD_TYPE.boolean, default: false },
      /** その軸まわりの回転を止める。3 つとも true なら、倒れも転がりもしない */
      { id: "lockRotateX", name: "lockRotateX", type: FIELD_TYPE.boolean, default: false },
      { id: "lockRotateY", name: "lockRotateY", type: FIELD_TYPE.boolean, default: false },
      { id: "lockRotateZ", name: "lockRotateZ", type: FIELD_TYPE.boolean, default: false },
    ],
  },
  {
    id: BUILTIN.Grabbable,
    name: "Grabbable",
    role: "interaction",
    builtin: true,
    fields: [
      /** 以前、持ったときに目の前へ寄せる距離だった。いまは持った位置を保つので使わない */
      { id: "distance", name: "distance", type: FIELD_TYPE.number, default: 1.2 },
      /** 右クリックで持っている人の ID（Host が入れる）。空なら誰も持っていない */
      { id: "player", name: "player", type: FIELD_TYPE.string, default: "" },
      /** 持っている間の、視点に対する位置（m）と角度（度）。持った瞬間の位置関係を Host が入れる */
      { id: "offset", name: "offset", type: FIELD_TYPE.vec3, default: [0, 0, -1.2] },
      { id: "rotation", name: "rotation", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
    ],
  },
  {
    // 左クリックで開くリングメニューから右手に装備する道具（ADR 0053）。装備した人の入力だけが onInput に届く
    id: BUILTIN.EquipmentTool,
    name: "EquipmentTool",
    role: "interaction",
    builtin: true,
    fields: [
      /** 装備している間の、視点に対する位置（m）。右手で前に構えた位置 */
      { id: "offset", name: "offset", type: FIELD_TYPE.vec3, default: [0.25, -0.22, -0.5] },
      /** 装備している間の、視点に対する角度（度） */
      { id: "rotation", name: "rotation", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
      /** 装備している人の ID（Host が入れる）。空なら置いてある */
      { id: "player", name: "player", type: FIELD_TYPE.string, default: "" },
    ],
  },
  {
    id: BUILTIN.AudioSource,
    name: "AudioSource",
    role: "audio",
    builtin: true,
    fields: [
      /** 音声の素材 ID */
      { id: "clip", name: "clip", type: FIELD_TYPE.audio, default: undefined },
      { id: "volume", name: "volume", type: FIELD_TYPE.number, default: 1 },
    ],
  },
  {
    id: BUILTIN.Label,
    name: "Label",
    role: "text",
    builtin: true,
    fields: [
      /** 出す文字。空なら表示しない */
      { id: "text", name: "text", type: FIELD_TYPE.string, default: "" },
      { id: "color", name: "color", type: FIELD_TYPE.color, default: "#26262e" },
      /** 文字の高さ（m） */
      { id: "size", name: "size", type: FIELD_TYPE.number, default: 0.16 },
    ],
  },
];

/** リソースの参照が指す先 → 参照するリソースの種類（マテリアルか、素材の種類） */
export const RESOURCE_FIELD_KIND: Record<
  Exclude<RefTarget, "entity">,
  "material" | "model" | "image" | "audio"
> = {
  texture: "image",
  material: "material",
  model: "model",
  audio: "audio",
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
