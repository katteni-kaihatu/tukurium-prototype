import type { EntityId, Vec3, World } from "@tukurium/eks";
import { BUILTIN } from "@tukurium/repo-model";
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";

export interface WorldTransform {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  matrix: Matrix4;
}

const DEG = MathUtils.DEG2RAD;

/** Transform の値（位置・度数のオイラー角・拡大率）から行列を作る。 */
export function localMatrix(position: Vec3, rotationDeg: Vec3, scale: Vec3): Matrix4 {
  const q = new Quaternion().setFromEuler(
    new Euler(rotationDeg[0] * DEG, rotationDeg[1] * DEG, rotationDeg[2] * DEG, "XYZ"),
  );
  return new Matrix4().compose(new Vector3(...position), q, new Vector3(...scale));
}

const DEFAULT_VEC3: Vec3 = [0, 0, 0];
const DEFAULT_SCALE: Vec3 = [1, 1, 1];

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length === 3) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }
  return [fallback[0], fallback[1], fallback[2]];
}

/**
 * Entity の姿勢。Transform が付いていなければ、フィールドの初期値（位置・回転 0、拡大率 1）。
 * Transform は、この初期値からずらすためのもの（ADR 0050）。
 */
export function transformOf(
  world: World,
  id: EntityId,
): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const t = world.get(id, BUILTIN.Transform);
  return {
    position: vec3(t?.position, DEFAULT_VEC3),
    rotation: vec3(t?.rotation, DEFAULT_VEC3),
    scale: vec3(t?.scale, DEFAULT_SCALE),
  };
}

/** 姿勢を書く。付いていなければ Transform を足す（ずれた結果を残すため）。 */
export function writeTransform(world: World, id: EntityId, position: Vec3, rotation: Vec3): void {
  const t = world.get(id, BUILTIN.Transform);
  if (!t) {
    world.add(id, BUILTIN.Transform, {
      position: [position[0], position[1], position[2]],
      rotation: [rotation[0], rotation[1], rotation[2]],
      scale: [1, 1, 1],
    });
    return;
  }
  t.position = [position[0], position[1], position[2]];
  t.rotation = [rotation[0], rotation[1], rotation[2]];
}

/** 親をたどって、Entity のワールド座標系での姿勢を求める。Transform がなければ初期値として扱う。 */
export function worldTransform(world: World, id: EntityId, root?: Matrix4): WorldTransform {
  const chain: EntityId[] = [];
  for (let e: EntityId | null = id; e !== null && world.has(e); e = world.parentOf(e))
    chain.unshift(e);
  const m = root ? root.clone() : new Matrix4();
  for (const e of chain) {
    const t = transformOf(world, e);
    m.multiply(localMatrix(t.position, t.rotation, t.scale));
  }
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  m.decompose(position, quaternion, scale);
  return { position, quaternion, scale, matrix: m };
}

/** クォータニオンを Transform の回転（度数のオイラー角）にする。 */
export function quaternionToDegrees(q: { x: number; y: number; z: number; w: number }): Vec3 {
  const e = new Euler().setFromQuaternion(new Quaternion(q.x, q.y, q.z, q.w), "XYZ");
  return [e.x / DEG, e.y / DEG, e.z / DEG];
}

/** 度数のオイラー角（XYZ）からクォータニオンにする。 */
export function degreesToQuaternion(rotationDeg: Vec3): Quaternion {
  return new Quaternion().setFromEuler(
    new Euler(rotationDeg[0] * DEG, rotationDeg[1] * DEG, rotationDeg[2] * DEG, "XYZ"),
  );
}

/**
 * 視点の向きからカメラの姿勢を求める。FPS のカメラと同じ（ロールは 0、上はできるだけ真上）。
 * 真上・真下付近では右方向が定まらないので、+X を右にする。
 */
export function viewQuaternion(direction: Vec3): Quaternion {
  const forward = new Vector3(...direction);
  if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
  else forward.normalize();
  const right = new Vector3(-forward.z, 0, forward.x);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  else right.normalize();
  const camZ = forward.clone().negate();
  const camY = new Vector3().crossVectors(camZ, right).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, camY, camZ));
}

/** ワールドの位置と角度を、視点からの差にする */
export function poseInView(
  origin: Vec3,
  direction: Vec3,
  position: Vec3,
  rotationDeg: Vec3,
): { offset: Vec3; rotation: Vec3 } {
  const view = viewQuaternion(direction);
  const inverse = view.clone().invert();
  const offset = new Vector3(...position).sub(new Vector3(...origin)).applyQuaternion(inverse);
  const rotation = quaternionToDegrees(inverse.multiply(degreesToQuaternion(rotationDeg)));
  return { offset: offset.toArray() as Vec3, rotation };
}

/** 視点からの差を、ワールドの位置と角度に戻す */
export function placeFromView(
  origin: Vec3,
  direction: Vec3,
  offset: Vec3,
  rotationDeg: Vec3,
): { position: Vec3; rotation: Vec3 } {
  const view = viewQuaternion(direction);
  const position = new Vector3(...origin).add(new Vector3(...offset).applyQuaternion(view));
  const rotation = quaternionToDegrees(view.multiply(degreesToQuaternion(rotationDeg)));
  return { position: position.toArray() as Vec3, rotation };
}

/** 持っているものを、これより手前・奥には動かさない（m） */
const HOLD_NEAR = 0.35;
const HOLD_FAR = 12;

/**
 * 視点からのずれを、同じ方向のまま前後に動かす。
 * deltaMeters が正なら奥へ、負なら手前へ。画面上の位置は変わらない。
 */
export function moveAlongView(offset: Vec3, deltaMeters: number): Vec3 {
  const dist = Math.hypot(offset[0], offset[1], offset[2]);
  const next = Math.min(HOLD_FAR, Math.max(HOLD_NEAR, (dist || HOLD_NEAR) + deltaMeters));
  if (dist < 1e-6) return [0, 0, -next];
  const s = next / dist;
  return [offset[0] * s, offset[1] * s, offset[2] * s];
}

/** 傾きを直し、上下の軸まわりの向きだけ残す */
export function straightenRotation(rotationDeg: Vec3): Vec3 {
  const euler = new Euler().setFromQuaternion(degreesToQuaternion(rotationDeg), "YXZ");
  euler.x = 0;
  euler.z = 0;
  return quaternionToDegrees(new Quaternion().setFromEuler(euler));
}

/** ヨーとピッチ（ラジアン）だけ回す。マウスで見回すときと同じ向き */
export function twistRotation(rotationDeg: Vec3, yaw: number, pitch: number): Vec3 {
  const turned = new Quaternion()
    .setFromEuler(new Euler(pitch, yaw, 0, "YXZ"))
    .multiply(degreesToQuaternion(rotationDeg));
  return quaternionToDegrees(turned);
}
