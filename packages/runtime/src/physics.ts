import RAPIER from "@dimforge/rapier3d-compat";
import type { EntityId, Vec3, World } from "@tukurium/eks";
import { BUILTIN } from "@tukurium/repo-model";
import { quaternionToDegrees, worldTransform, writeTransform } from "./transform";

let initialized: Promise<void> | null = null;

/** Rapier の WASM を読み込む（何度呼んでも 1 回だけ）。 */
export function initPhysics(): Promise<void> {
  initialized ??= RAPIER.init();
  return initialized;
}

interface BodyRecord {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** 形状が変わったら作り直すための鍵 */
  shapeKey: string;
  type: "fixed" | "dynamic" | "kinematic";
}

export interface RayHit {
  entity: EntityId;
  distance: number;
  point: Vec3;
}

export interface CollisionEvent {
  a: EntityId;
  b: EntityId;
  started: boolean;
}

/**
 * EKS の World と Rapier の物理ワールドを対応させる。
 * - Collider を持つ Entity に剛体と当たり判定を作る（RigidBody がなければ動かない剛体）。
 * - 形は Mesh の形状・大きさ × ワールドでの拡大率から作る。
 * - 動く剛体（dynamic）の位置・回転・速度は、計算後に Transform / RigidBody へ書き戻す。
 */
export class Physics {
  readonly rapier: RAPIER.World;
  private readonly bodies = new Map<EntityId, BodyRecord>();
  private readonly byCollider = new Map<number, EntityId>();
  private readonly events = new RAPIER.EventQueue(true);

  constructor() {
    this.rapier = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  }

  /** Entity の追加・削除・形の変化・動かない剛体の移動を物理ワールドに反映する。 */
  sync(world: World): void {
    const wanted = new Set(world.query({ with: [BUILTIN.Collider] }));
    for (const id of [...this.bodies.keys()]) if (!wanted.has(id)) this.remove(id);

    for (const id of wanted) {
      const wt = worldTransform(world, id);
      const mesh = world.get(id, BUILTIN.Mesh);
      const rb = world.get(id, BUILTIN.RigidBody);
      const collider = world.get(id, BUILTIN.Collider);
      // 手に持っている間は、重力で落ちないよう、Transform に合わせて動かす
      const type: BodyRecord["type"] = world.hasState(id, BUILTIN.Held)
        ? "kinematic"
        : ((rb?.type as BodyRecord["type"] | undefined) ?? "fixed");
      const shape = (mesh?.shape as string | undefined) ?? "box";
      const size = (mesh?.size as Vec3 | undefined) ?? [1, 1, 1];
      const s = wt.scale;
      const shapeKey = JSON.stringify([
        shape,
        size,
        s.toArray().map((v) => v.toFixed(4)),
        type,
        collider?.sensor,
      ]);

      let rec = this.bodies.get(id);
      if (rec && rec.shapeKey !== shapeKey) {
        this.remove(id);
        rec = undefined;
      }
      if (!rec) {
        const desc =
          type === "dynamic"
            ? RAPIER.RigidBodyDesc.dynamic()
            : type === "kinematic"
              ? RAPIER.RigidBodyDesc.kinematicPositionBased()
              : RAPIER.RigidBodyDesc.fixed();
        desc.setTranslation(wt.position.x, wt.position.y, wt.position.z).setRotation(wt.quaternion);
        if (type === "dynamic" && rb) {
          const v = rb.linvel as Vec3;
          desc.setLinvel(v[0], v[1], v[2]);
        }
        const body = this.rapier.createRigidBody(desc);
        const cdesc = colliderDesc(shape, [size[0] * s.x, size[1] * s.y, size[2] * s.z])
          .setSensor(Boolean(collider?.sensor))
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        const col = this.rapier.createCollider(cdesc, body);
        rec = { body, collider: col, shapeKey, type };
        this.bodies.set(id, rec);
        this.byCollider.set(col.handle, id);
      } else if (type !== "dynamic") {
        // 動かない剛体・キネマティックは Transform に合わせて動かす
        rec.body.setTranslation(wt.position, true);
        rec.body.setRotation(wt.quaternion, true);
      }
    }
    this.rapier.propagateModifiedBodyPositionsToColliders();
  }

  step(world: World, dt: number): CollisionEvent[] {
    this.rapier.timestep = dt;
    this.rapier.step(this.events);
    // 動く剛体の結果を書き戻す（親子関係のある dynamic は初版では扱わない＝ワールド座標として書く）
    for (const [id, rec] of this.bodies) {
      if (rec.type !== "dynamic" || !world.has(id)) continue;
      const p = rec.body.translation();
      const rotation = quaternionToDegrees(rec.body.rotation());
      // 子は親の姿勢に初期値を足したものとして扱う。ワールド座標を子の Transform に書くと二重になる
      if (world.parentOf(id) !== null && !world.hasState(id, BUILTIN.Transform)) continue;
      writeTransform(world, id, [p.x, p.y, p.z], rotation);
      const rb = world.get(id, BUILTIN.RigidBody);
      if (rb) {
        const v = rec.body.linvel();
        rb.linvel = [v.x, v.y, v.z];
      }
    }
    const out: CollisionEvent[] = [];
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.byCollider.get(h1);
      const b = this.byCollider.get(h2);
      if (a && b) out.push({ a, b, started });
    });
    return out;
  }

  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    exclude: EntityId[] = [],
  ): RayHit | null {
    const len = Math.hypot(...direction);
    if (len === 0 || !Number.isFinite(len)) return null;
    const dir = { x: direction[0] / len, y: direction[1] / len, z: direction[2] / len };
    const ray = new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, dir);
    const excluded = new Set(exclude);
    const hit = this.rapier.castRay(
      ray,
      maxDistance,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (c) => {
        const e = this.byCollider.get(c.handle);
        return e !== undefined && !excluded.has(e);
      },
    );
    if (!hit) return null;
    const entity = this.byCollider.get(hit.collider.handle);
    if (!entity) return null;
    const p = ray.pointAt(hit.timeOfImpact);
    return { entity, distance: hit.timeOfImpact, point: [p.x, p.y, p.z] };
  }

  takeSnapshot(): Uint8Array {
    return this.rapier.takeSnapshot();
  }

  dispose(): void {
    this.events.free();
    this.rapier.free();
    this.bodies.clear();
    this.byCollider.clear();
  }

  /** Entity の剛体を取り除く（次の sync で Transform から作り直される） */
  remove(id: EntityId): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    this.byCollider.delete(rec.collider.handle);
    this.rapier.removeRigidBody(rec.body);
    this.bodies.delete(id);
  }
}

function colliderDesc(shape: string, size: Vec3): RAPIER.ColliderDesc {
  const [x, y, z] = size.map((v) => Math.max(Math.abs(v), 0.001)) as Vec3;
  switch (shape) {
    case "sphere":
      return RAPIER.ColliderDesc.ball(x / 2);
    case "cylinder":
      return RAPIER.ColliderDesc.cylinder(y / 2, x / 2);
    case "capsule":
      return RAPIER.ColliderDesc.capsule(Math.max(y / 2 - x / 2, 0.001), x / 2);
    case "plane":
      return RAPIER.ColliderDesc.cuboid(x / 2, 0.005, z / 2);
    default:
      return RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2);
  }
}
