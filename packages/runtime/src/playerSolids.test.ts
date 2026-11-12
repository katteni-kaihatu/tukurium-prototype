import { type KokoStateValues, World } from "@tukurium/eks";
import { BUILTIN, buildRegistry } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { PlayerSolids } from "./playerSolids";
import { GRAVITY } from "./solidShape";

let solids: PlayerSolids | undefined;
afterEach(() => {
  solids?.dispose();
  solids = undefined;
});

function scene(
  parts: {
    id: string;
    position?: [number, number, number];
    shape?: string;
    size?: [number, number, number];
    collider?: KokoStateValues;
  }[],
): World {
  const world = new World(buildRegistry([]));
  for (const p of parts) {
    world.spawn(p.id, null);
    world.add(p.id, BUILTIN.Transform, {
      position: p.position ?? [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    world.add(p.id, BUILTIN.Mesh, {
      shape: p.shape ?? "box",
      size: p.size ?? [1, 1, 1],
      material: null,
      color: "#ffffff",
    });
    world.add(p.id, BUILTIN.Collider, p.collider ?? {});
  }
  return world;
}

async function load(world: World, origin: [number, number, number] = [0, 0, 0]): Promise<void> {
  solids = new PlayerSolids();
  await solids.ready;
  solids.sync([{ id: "s", world, origin }]);
}

/** 重力を掛けながら、水平速度（m/s）で歩く */
function walk(
  from: [number, number, number],
  velocity: [number, number, number],
  frames: number,
): { position: [number, number, number]; grounded: boolean } {
  if (!solids) throw new Error("準備ができていません");
  let pos = from;
  let vy = 0;
  let grounded = from[1] <= 0.05;
  for (let i = 0; i < frames; i++) {
    if (grounded && vy < 0) vy = 0;
    vy -= GRAVITY / 60;
    const moved = solids.move(pos, [velocity[0] / 60, vy / 60, velocity[2] / 60], vy <= 0);
    if (!moved) throw new Error("当たり判定がまだ使えません");
    pos = moved.position;
    grounded = moved.grounded;
  }
  return { position: pos, grounded };
}

describe("プレイヤーの当たり判定", () => {
  it("何も無いところでは高さ 0 の地面で止まり、下へ抜けない", async () => {
    await load(scene([]));
    const landed = walk([0, 2, 0], [0, 0, 0], 180);
    expect(landed.grounded).toBe(true);
    expect(landed.position[1]).toBeGreaterThanOrEqual(-0.02);
    expect(landed.position[1]).toBeLessThan(0.08);
    const down = solids?.move(landed.position, [0, -0.4, 0], true);
    expect(down?.position[1]).toBeGreaterThanOrEqual(-0.02);
  });

  it("壁の中へは進めず、sensor の壁はすり抜ける", async () => {
    await load(scene([{ id: "wall", position: [0, 1.5, -2], size: [4, 3, 0.4] }]));
    const blocked = walk([0, 0, 0], [0, 0, -3], 120);
    expect(blocked.position[2]).toBeLessThan(-1);
    expect(blocked.position[2]).toBeGreaterThan(-1.7);

    solids?.dispose();
    await load(
      scene([
        { id: "wall", position: [0, 1.5, -2], size: [4, 3, 0.4], collider: { sensor: true } },
      ]),
    );
    const through = walk([0, 0, 0], [0, 0, -3], 120);
    expect(through.position[2]).toBeLessThan(-4);
  });

  it("ワールドの床の上を歩き続けられる", async () => {
    await load(scene([{ id: "floor", position: [0, 0.02, 0], shape: "plane", size: [40, 1, 40] }]));
    const walked = walk([0, 0, 0], [0, 0, -3], 90);
    expect(walked.position[2]).toBeLessThan(-2);
    expect(walked.position[1]).toBeGreaterThan(-0.05);
    expect(walked.position[1]).toBeLessThan(0.2);
  });

  it("床の上に立ち、低い段は上れる", async () => {
    await load(scene([{ id: "deck", position: [0, 0.5, 0], size: [3, 1, 3] }]));
    const stood = walk([0, 3, 0], [0, 0, 0], 180);
    expect(stood.grounded).toBe(true);
    expect(stood.position[1]).toBeGreaterThan(0.9);
    expect(stood.position[1]).toBeLessThan(1.2);

    solids?.dispose();
    await load(scene([{ id: "curb", position: [0, 0.12, -2.5], size: [3, 0.24, 3] }]));
    const stepped = walk([0, 0, 0], [0, 0, -2], 90);
    expect(stepped.position[2]).toBeLessThan(-1);
    expect(stepped.position[1]).toBeGreaterThan(0.15);
  });

  it("編集空間のアンカーだけずらした壁にもぶつかる", async () => {
    await load(scene([{ id: "wall", position: [0, 1, 0], size: [0.4, 2, 4] }]), [10, 0, 0]);
    const blocked = walk([8, 0, 0], [3, 0, 0], 90);
    expect(blocked.position[0]).toBeGreaterThan(9.2);
    expect(blocked.position[0]).toBeLessThan(9.7);
  });

  it("原点から離れた編集空間でも、高さ 0 で止まる", async () => {
    await load(scene([]));
    const landed = walk([-500, 2, 12], [0, 0, 0], 180);
    expect(landed.grounded).toBe(true);
    expect(landed.position[1]).toBeGreaterThanOrEqual(-0.02);
    expect(landed.position[1]).toBeLessThan(0.08);
    expect(landed.position[0]).toBeCloseTo(-500, 1);
  });

  it("上向きの移動は地面に吸い付かない", async () => {
    await load(scene([]));
    const up = solids?.move([0, 0, 0], [0, 0.25, 0], false);
    expect(up?.position[1]).toBeGreaterThan(0.15);
    expect(up?.grounded).toBe(false);
  });
});
