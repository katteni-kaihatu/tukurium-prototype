import RAPIER from "@dimforge/rapier3d-compat";
import type { EntityId, Vec3, World } from "@tukurium/eks";
import { BUILTIN } from "@tukurium/repo-model";
import { isInHand } from "./holding";
import { addSessionGround, finiteNumber, GRAVITY, resolvedCollider, vec3Of } from "./solidShape";
import { worldTransform, writeWorldTransform } from "./transform";

let initialized: Promise<void> | null = null;

/** Rapier の WASM を読み込む（何度呼んでも 1 回だけ）。 */
export function initPhysics(): Promise<void> {
  initialized ??= RAPIER.init();
  return initialized;
}

interface BodyRecord {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** 形や質量が変わったら作り直すための鍵 */
  shapeKey: string;
  type: "fixed" | "dynamic" | "kinematic";
  /** 動かさない軸（ワールドの x・y・z）。dynamic のときだけ使う */
  lockMove: AxisLock;
  lockRotate: AxisLock;
}

/** x・y・z の軸ごとに、固定するか */
type AxisLock = readonly [boolean, boolean, boolean];

/** 固定した軸の成分を 0 にした速度。固定した軸へは、スクリプトが書いた速度でも動かさない */
function freeOnly(v: Vec3, lock: AxisLock): Vec3 {
  return [lock[0] ? 0 : v[0], lock[1] ? 0 : v[1], lock[2] ? 0 : v[2]];
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
 * - 形は Collider の shape / size。未指定なら Mesh に合わせる。
 * - 高さ 0 に、Entity ではない地面を置く。動く剛体はここで止まる。
 * - 動く剛体（dynamic）の位置・回転・速度は、計算後に Transform / RigidBody へ書き戻す。
 * - スクリプトが書いた速度は、次の計算の前に剛体へ戻す。
 * - RigidBody の lockMove* / lockRotate* が true の軸には動かさない（ワールドの軸。ADR 0077）。
 */
export class Physics {
  readonly rapier: RAPIER.World;
  private readonly bodies = new Map<EntityId, BodyRecord>();
  private readonly byCollider = new Map<number, EntityId>();
  private readonly events = new RAPIER.EventQueue(true);

  constructor() {
    this.rapier = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.rapier.integrationParameters.maxCcdSubsteps = 4;
    addSessionGround(this.rapier);
  }

  /** Entity の追加・削除・形の変化・動かない剛体の移動を物理ワールドに反映する。 */
  sync(world: World): void {
    const wanted = new Set(world.query({ with: [BUILTIN.Collider] }));
    for (const id of [...this.bodies.keys()]) if (!wanted.has(id)) this.remove(id);

    for (const id of wanted) {
      const wt = worldTransform(world, id);
      const mesh = world.get(id, BUILTIN.Mesh);
      const rb = world.get(id, BUILTIN.RigidBody);
      // 手に持っている間は、重力で落ちないよう、Transform に合わせて動かす
      const type: BodyRecord["type"] = isInHand(world, id)
        ? "kinematic"
        : ((rb?.type as BodyRecord["type"] | undefined) ?? "fixed");
      const { desc: cdesc, key: shapePart } = resolvedCollider(
        world.get(id, BUILTIN.Collider),
        mesh,
        [wt.scale.x, wt.scale.y, wt.scale.z],
        true,
      );
      const mass = Math.max(finiteNumber(rb?.mass, 1), 0.001);
      const gravityScale = finiteNumber(rb?.gravityScale, 1);
      const linearDamping = Math.max(finiteNumber(rb?.linearDamping, 0.05), 0);
      const angularDamping = Math.max(finiteNumber(rb?.angularDamping, 0.1), 0);
      const ccd = rb?.ccd !== false;
      const lockMove: AxisLock = [
        rb?.lockMoveX === true,
        rb?.lockMoveY === true,
        rb?.lockMoveZ === true,
      ];
      const lockRotate: AxisLock = [
        rb?.lockRotateX === true,
        rb?.lockRotateY === true,
        rb?.lockRotateZ === true,
      ];
      const shapeKey = [
        shapePart,
        type,
        mass,
        gravityScale,
        linearDamping,
        angularDamping,
        ccd,
        lockMove.map(Number).join(""),
        lockRotate.map(Number).join(""),
      ].join("|");

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
          const v = freeOnly(vec3Of(rb.linvel), lockMove);
          const w = freeOnly(vec3Of(rb.angvel), lockRotate);
          desc.setLinvel(v[0], v[1], v[2]).setAngvel({ x: w[0], y: w[1], z: w[2] });
          desc
            .setAdditionalMass(mass)
            .setGravityScale(gravityScale)
            .setLinearDamping(linearDamping)
            .setAngularDamping(angularDamping)
            .setCcdEnabled(ccd)
            .enabledTranslations(!lockMove[0], !lockMove[1], !lockMove[2])
            .enabledRotations(!lockRotate[0], !lockRotate[1], !lockRotate[2]);
        }
        const body = this.rapier.createRigidBody(desc);
        const col = this.rapier.createCollider(cdesc, body);
        rec = { body, collider: col, shapeKey, type, lockMove, lockRotate };
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
    // スクリプトが書いた速度を、計算の前に戻す（計算後に書き戻すので、変えていなければ同じ値）
    for (const [id, rec] of this.bodies) {
      if (rec.type !== "dynamic" || !world.has(id)) continue;
      const rb = world.get(id, BUILTIN.RigidBody);
      if (!rb) continue;
      const v = freeOnly(vec3Of(rb.linvel), rec.lockMove);
      const w = freeOnly(vec3Of(rb.angvel), rec.lockRotate);
      rec.body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
      rec.body.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
    }
    this.rapier.timestep = dt;
    this.rapier.step(this.events);
    // 動く剛体の結果（ワールド座標）を書き戻す。親のある Entity には、親から見た値に直して書く
    for (const [id, rec] of this.bodies) {
      if (rec.type !== "dynamic" || !world.has(id)) continue;
      writeWorldTransform(world, id, rec.body.translation(), rec.body.rotation());
      const rb = world.get(id, BUILTIN.RigidBody);
      if (rb) {
        const v = rec.body.linvel();
        const w = rec.body.angvel();
        rb.linvel = [v.x, v.y, v.z];
        rb.angvel = [w.x, w.y, w.z];
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
