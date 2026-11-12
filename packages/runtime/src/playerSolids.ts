import RAPIER from "@dimforge/rapier3d-compat";
import type { EntityId, Vec3, World } from "@tukurium/eks";
import { BUILTIN } from "@tukurium/repo-model";
import { isInHand } from "./holding";
import { initPhysics } from "./physics";
import {
  addSessionGround,
  PLAYER_CENTER,
  PLAYER_GROUND_HALF,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SKIN,
  resolvedCollider,
} from "./solidShape";
import { localMatrix, worldTransform } from "./transform";

export interface SolidSource {
  /** 同じ Entity ID が複数の World にあっても混ざらないようにする印 */
  id: string;
  world: World;
  /** この World をセッションの座標へ移す（編集空間のアンカー） */
  origin: Vec3;
}

interface SolidBody {
  body: RAPIER.RigidBody;
  key: string;
}

/**
 * プレイヤーが歩くための当たり判定。
 * ホストの物理とは別の Rapier ワールドで、Collider（sensor 以外）と高さ 0 の地面にカプセルを滑らせる。
 * 手に持っている物は含めない（視点の前で自分を押さないため）。
 */
export class PlayerSolids {
  readonly ready: Promise<void>;
  private world: RAPIER.World | null = null;
  private ground: RAPIER.RigidBody | null = null;
  /** 最後に問い合わせへ反映した地面の中心（x, z）。ここから離れたら板を寄せ直す。 */
  private groundCenter: [number, number] = [0, 0];
  private controller: RAPIER.KinematicCharacterController | null = null;
  private body: RAPIER.RigidBody | null = null;
  private collider: RAPIER.Collider | null = null;
  private readonly bodies = new Map<string, SolidBody>();
  private readonly readers = new Map<string, () => { world: World; origin: Vec3 } | null>();
  private disposed = false;

  constructor() {
    this.ready = initPhysics().then(() => this.mount());
    // 失敗しても、移動側は高さ 0 の仮の地面に戻る。rejection を未処理にしない。
    this.ready.catch(() => undefined);
  }

  /** 毎フレーム、いま見えている World を渡す相手を登録する。戻り値で外す。 */
  bind(id: string, read: () => { world: World; origin: Vec3 } | null): () => void {
    this.readers.set(id, read);
    return () => {
      this.readers.delete(id);
    };
  }

  /** 登録された World を当たり判定へ反映する。移動の前に呼ぶ。 */
  prepare(): void {
    if (!this.world) return;
    const sources: SolidSource[] = [];
    for (const [id, read] of this.readers) {
      const src = read();
      if (src) sources.push({ id, world: src.world, origin: src.origin });
    }
    this.sync(sources);
  }

  /** 足元の位置と、このフレームの移動希望から、ぶつかったあとの足元を返す。準備前は null。 */
  move(feet: Vec3, delta: Vec3, snap: boolean): { position: Vec3; grounded: boolean } | null {
    if (!this.world || !this.controller || !this.body || !this.collider) return null;
    // 大きな一枚板は高さがずれる。板の中心から離れたら、その場に作り直して問い合わせに載せる。
    const dx = feet[0] - this.groundCenter[0];
    const dz = feet[2] - this.groundCenter[1];
    if (dx * dx + dz * dz > 20 * 20) {
      if (this.ground) this.world.removeRigidBody(this.ground);
      this.ground = addSessionGround(this.world, PLAYER_GROUND_HALF, feet[0], feet[2]);
      this.groundCenter = [feet[0], feet[2]];
      this.world.step();
    }
    if (snap) this.controller.enableSnapToGround(0.3);
    else this.controller.disableSnapToGround();
    this.body.setTranslation({ x: feet[0], y: feet[1] + PLAYER_CENTER, z: feet[2] }, true);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.controller.computeColliderMovement(
      this.collider,
      { x: delta[0], y: delta[1], z: delta[2] },
      undefined,
      undefined,
      (c) => c.handle !== this.collider?.handle,
    );
    const m = this.controller.computedMovement();
    const position: Vec3 = [feet[0] + m.x, feet[1] + m.y, feet[2] + m.z];
    // 下向きの移動が遮られたら、地面に付いている（段差の上でも）
    const blockedDown = delta[1] < -1e-5 && m.y > delta[1] + 1e-4;
    this.body.setTranslation(
      { x: position[0], y: position[1] + PLAYER_CENTER, z: position[2] },
      true,
    );
    return { position, grounded: this.controller.computedGrounded() || blockedDown };
  }

  sync(sources: readonly SolidSource[]): void {
    const rapier = this.world;
    if (!rapier) return;
    const wanted = new Set<string>();
    for (const source of sources) {
      const root = localMatrix(source.origin, [0, 0, 0], [1, 1, 1]);
      for (const id of source.world.query({ with: [BUILTIN.Collider] })) {
        const collider = source.world.get(id, BUILTIN.Collider);
        if (!collider || collider.sensor || isInHand(source.world, id)) continue;
        const keyId = `${source.id}/${id}`;
        wanted.add(keyId);
        this.upsert(rapier, keyId, source.world, id, root);
      }
    }
    for (const key of [...this.bodies.keys()]) if (!wanted.has(key)) this.remove(key);
    rapier.propagateModifiedBodyPositionsToColliders();
    // 作った直後のコライダーは、一度進めないとクエリに乗らない
    rapier.step();
  }

  dispose(): void {
    this.disposed = true;
    this.bodies.clear();
    this.readers.clear();
    this.controller = null;
    this.ground = null;
    this.body = null;
    this.collider = null;
    this.world?.free();
    this.world = null;
  }

  private mount(): void {
    if (this.disposed) return;
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const ground = addSessionGround(world, PLAYER_GROUND_HALF);
    const controller = world.createCharacterController(PLAYER_SKIN);
    controller.setSlideEnabled(true);
    controller.enableAutostep(0.35, 0.2, true);
    controller.enableSnapToGround(0.3);
    controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((55 * Math.PI) / 180);
    controller.setApplyImpulsesToDynamicBodies(false);
    const half = Math.max(PLAYER_HEIGHT / 2 - PLAYER_RADIUS, 0.05);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PLAYER_CENTER, 0),
    );
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(half, PLAYER_RADIUS), body);
    world.step();
    this.world = world;
    this.ground = ground;
    this.controller = controller;
    this.body = body;
    this.collider = collider;
  }

  private upsert(
    rapier: RAPIER.World,
    keyId: string,
    world: World,
    id: EntityId,
    root: ReturnType<typeof localMatrix>,
  ): void {
    const wt = worldTransform(world, id, root);
    const mesh = world.get(id, BUILTIN.Mesh);
    const collider = world.get(id, BUILTIN.Collider);
    const { desc, key } = resolvedCollider(
      collider,
      mesh,
      [wt.scale.x, wt.scale.y, wt.scale.z],
      false,
    );
    let rec = this.bodies.get(keyId);
    if (rec && rec.key !== key) {
      this.remove(keyId);
      rec = undefined;
    }
    if (!rec) {
      // 固定にする。キネマティックの床は接触が溢れて、立っているあいだ歩けなくなる。
      const body = rapier.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(wt.position.x, wt.position.y, wt.position.z)
          .setRotation(wt.quaternion),
      );
      rapier.createCollider(desc, body);
      rec = { body, key };
      this.bodies.set(keyId, rec);
      return;
    }
    rec.body.setTranslation(wt.position, true);
    rec.body.setRotation(wt.quaternion, true);
  }

  private remove(keyId: string): void {
    const rec = this.bodies.get(keyId);
    if (!rec || !this.world) return;
    this.world.removeRigidBody(rec.body);
    this.bodies.delete(keyId);
  }
}
