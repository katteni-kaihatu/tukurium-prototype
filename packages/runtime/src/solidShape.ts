import RAPIER from "@dimforge/rapier3d-compat";
import type { KokoStateValues, Vec3 } from "@tukurium/eks";

/** 剛体と同じ重力（m/s²）。プレイヤーの落下もこれに合わせる。 */
export const GRAVITY = 9.81;

/**
 * 高さ 0 の地面。Entity ではないので、レイや onCollision には出てこない。
 * 半分の幅は 200m。これより大きい一枚の板は、Rapier の当たりで足元が沈む。
 * 剛体用の地面は原点を中心にする。プレイヤー用は、いる場所へ板を追従させる。
 */
export const GROUND_HALF_EXTENT = 200;
/** プレイヤーの足元に追従させる地面の半分の幅（m） */
export const PLAYER_GROUND_HALF = 80;
export const GROUND_THICKNESS = 1;

/** 平面の当たり判定の厚さ（m）。上面を見た目の平面に合わせ、下へ伸ばしてすり抜けにくくする。 */
export const PLANE_THICKNESS = 0.2;

/** プレイヤーのカプセル。足元が位置、目の高さはこれより少し下。 */
export const PLAYER_RADIUS = 0.28;
export const PLAYER_HEIGHT = 1.7;
/** 体と床のすき間。0 に近いほど、足元 0 から段を上れる。 */
export const PLAYER_SKIN = 0.01;
/** 足元からカプセル中心までの高さ */
export const PLAYER_CENTER = PLAYER_HEIGHT / 2;

export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function vec3Of(value: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return [fallback[0], fallback[1], fallback[2]];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2]),
  ];
}

/** 高さ 0 を上面にした厚い地面を置く。centerX / centerZ は板の中心。 */
export function addSessionGround(
  world: RAPIER.World,
  halfExtent = GROUND_HALF_EXTENT,
  centerX = 0,
  centerZ = 0,
): RAPIER.RigidBody {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, -GROUND_THICKNESS / 2, centerZ),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(halfExtent, GROUND_THICKNESS / 2, halfExtent).setFriction(0.9),
    body,
  );
  return body;
}

/**
 * Collider と Mesh から Rapier の形を作る。
 * shape が mesh（または空）のときは Mesh の形、size が 0,0,0 のときは Mesh の大きさ。
 * 拡大率は形の寸法に焼き込む（剛体側では拡大しない）。
 */
export function resolvedCollider(
  collider: KokoStateValues | undefined,
  mesh: KokoStateValues | undefined,
  scale: Vec3,
  events: boolean,
): { desc: RAPIER.ColliderDesc; key: string } {
  const requested = String(collider?.shape ?? "mesh");
  const followShape = requested === "mesh" || requested === "";
  const shape = followShape ? String(mesh?.shape ?? "box") : requested;
  const raw = vec3Of(collider?.size, [0, 0, 0]);
  const followSize = raw[0] === 0 && raw[1] === 0 && raw[2] === 0;
  const base = followSize ? vec3Of(mesh?.size, [1, 1, 1]) : raw;
  const sx = Math.max(Math.abs(base[0] * scale[0]), 0.001);
  const sy = Math.max(Math.abs(base[1] * scale[1]), 0.001);
  const sz = Math.max(Math.abs(base[2] * scale[2]), 0.001);
  const offset = vec3Of(collider?.offset, [0, 0, 0]);
  const tx = offset[0] * scale[0];
  const ty = offset[1] * scale[1] - (shape === "plane" ? PLANE_THICKNESS / 2 : 0);
  const tz = offset[2] * scale[2];
  const sensor = Boolean(collider?.sensor);
  const friction = finiteNumber(collider?.friction, 0.6);
  const restitution = finiteNumber(collider?.restitution, 0);

  let desc: RAPIER.ColliderDesc;
  switch (shape) {
    case "sphere":
      desc = RAPIER.ColliderDesc.ball(sx / 2);
      break;
    case "cylinder":
      desc = RAPIER.ColliderDesc.cylinder(sy / 2, sx / 2);
      break;
    case "capsule":
      desc = RAPIER.ColliderDesc.capsule(Math.max(sy / 2 - sx / 2, 0.001), sx / 2);
      break;
    case "plane":
      desc = RAPIER.ColliderDesc.cuboid(sx / 2, PLANE_THICKNESS / 2, sz / 2);
      break;
    default:
      desc = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
  }
  desc
    .setTranslation(tx, ty, tz)
    .setSensor(sensor)
    .setFriction(friction)
    .setRestitution(restitution)
    .setDensity(0);
  if (events) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  const key = [shape, sx, sy, sz, tx, ty, tz, sensor ? 1 : 0, friction, restitution]
    .map((v) => (typeof v === "number" ? v.toFixed(4) : String(v)))
    .join("|");
  return { desc, key };
}
