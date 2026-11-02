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

/** 親をたどって、Entity のワールド座標系での姿勢を求める。Transform がない Entity は原点として扱う。 */
export function worldTransform(world: World, id: EntityId, root?: Matrix4): WorldTransform {
  const chain: EntityId[] = [];
  for (let e: EntityId | null = id; e !== null && world.has(e); e = world.parentOf(e))
    chain.unshift(e);
  const m = root ? root.clone() : new Matrix4();
  for (const e of chain) {
    const t = world.get(e, BUILTIN.Transform);
    if (!t) continue;
    m.multiply(localMatrix(t.position as Vec3, t.rotation as Vec3, t.scale as Vec3));
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
