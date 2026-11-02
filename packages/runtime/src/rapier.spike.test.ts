// M0 技術検証：Rapier の状態を保存・復元して、別のホストで続きを計算できるか。
import { gzipSync } from "node:zlib";
import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await RAPIER.init();
});

function buildWorld(n: number) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50));
  const handles: number[] = [];
  for (let i = 0; i < n; i++) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation((i % 10) * 1.1, 1 + Math.floor(i / 10) * 1.1, 0)
        .setLinvel(0.3 * (i % 3), 0, 0.2),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setRestitution(0.2), body);
    handles.push(body.handle);
  }
  return { world, handles };
}

function positions(world: RAPIER.World, handles: number[]) {
  return handles.map((h) => {
    const t = world.getRigidBody(h).translation();
    return [t.x, t.y, t.z];
  });
}

describe("Rapier スナップショット", () => {
  it("復元したワールドは同じハンドルで、続きを同じ結果で計算できる", () => {
    const { world, handles } = buildWorld(100);
    for (let i = 0; i < 60; i++) world.step();

    const snap = world.takeSnapshot();
    const restored = RAPIER.World.restoreSnapshot(snap);
    expect(restored).not.toBeNull();
    if (!restored) return;

    // ハンドルが保たれる（Entity と剛体の対応表をそのまま使える）
    expect(positions(restored, handles)).toEqual(positions(world, handles));

    for (let i = 0; i < 120; i++) {
      world.step();
      restored.step();
    }
    // 同じ入力なら同じ結果（決定的）
    expect(positions(restored, handles)).toEqual(positions(world, handles));
    const gz = gzipSync(snap).byteLength;
    console.info(
      `[spike] snapshot of 100 bodies after 60 steps: ${(snap.byteLength / 1024).toFixed(1)} KiB (gzip ${(gz / 1024).toFixed(1)} KiB)`,
    );
    world.free();
    restored.free();
  });

  it("シミュレーション前のスナップショットの大きさと取得時間", () => {
    const { world } = buildWorld(100);
    const t0 = performance.now();
    const snap = world.takeSnapshot();
    const took = performance.now() - t0;
    console.info(`[spike] takeSnapshot: ${took.toFixed(2)} ms, ${snap.byteLength} bytes`);
    expect(snap.byteLength).toBeLessThan(512 * 1024);
    world.free();
  });
});
