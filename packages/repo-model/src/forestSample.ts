import { BUILTIN } from "./builtins";
import { SAMPLE_MODEL } from "./sampleModels";
import type { EntityDef, ProjectSnapshot } from "./schema";

const OUT = "out_forest";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 再現できる乱数（森の木の位置を毎回同じにする） */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ModelKind = keyof typeof SAMPLE_MODEL;

interface Spot {
  x: number;
  z: number;
  yaw: number;
  scale: number;
  kind: ModelKind;
}

/** 立ち位置（z = 6）のまわりを空けて、木をばらす */
function treeSpots(): Spot[] {
  const rnd = mulberry32(20261104);
  const spots: Spot[] = [];
  let guard = 0;
  while (spots.length < 36 && guard < 800) {
    guard += 1;
    const ang = rnd() * Math.PI * 2;
    const dist = 4.6 + rnd() * 14;
    const x = Math.cos(ang) * dist;
    const z = 6 + Math.sin(ang) * dist;
    const crowded = spots.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 2.4 ** 2);
    if (crowded) continue;
    const roll = rnd();
    const kind: ModelKind = roll < 0.46 ? "pine" : roll < 0.8 ? "leaf" : "bush";
    const scale = kind === "bush" ? 0.9 + rnd() * 0.45 : 0.82 + rnd() * 0.5;
    spots.push({ x, z, yaw: rnd() * 360, scale, kind });
  }
  return spots;
}

function entity(
  id: string,
  name: string,
  order: number,
  position: [number, number, number],
  rotation: [number, number, number],
  scale: [number, number, number],
  shape: string,
  size: [number, number, number],
  color: string,
  model: string | null = null,
): EntityDef {
  return {
    id,
    name,
    parent: null,
    output: OUT,
    order,
    states: {
      [BUILTIN.Transform]: { position, rotation, scale },
      [BUILTIN.Mesh]: { shape, size, material: null, color, model },
      // 見た目と同じ形で、プレイヤーと落ちる物がぶつかる（ADR 0068）
      [BUILTIN.Collider]: { sensor: false },
    },
  };
}

/** 同梱サンプル：静かな森のワールド。木は同梱の GLB */
export function forestSample(): ProjectSnapshot {
  const models = [SAMPLE_MODEL.pine, SAMPLE_MODEL.leaf, SAMPLE_MODEL.bush];
  const trees = treeSpots().map((s, i) => {
    const model = SAMPLE_MODEL[s.kind];
    const sc = r2(s.scale);
    return entity(
      `ent_tree${i}`,
      `${model.name}${i + 1}`,
      20 + i,
      [r2(s.x), 0, r2(s.z)],
      [0, r2(s.yaw), 0],
      [sc, sc, sc],
      "box",
      [1, 3, 1],
      "#3d6b45",
      model.id,
    );
  });

  const rockSpecs: { x: number; z: number; d: number; color: string }[] = [
    { x: 1.6, z: 4.2, d: 0.7, color: "#8d8a82" },
    { x: -2.1, z: 7.4, d: 0.55, color: "#9a968c" },
    { x: 2.4, z: 8.1, d: 0.4, color: "#7e7b74" },
    { x: -1.2, z: 3.5, d: 0.48, color: "#a39e94" },
  ];
  const rocks = rockSpecs.map((rock, i) =>
    entity(
      `ent_rock${i}`,
      `石${i + 1}`,
      10 + i,
      [rock.x, r2((rock.d / 2) * 0.35), rock.z],
      [0, i * 40, 0],
      [1, 0.55, 1],
      "sphere",
      [rock.d, rock.d, rock.d],
      rock.color,
    ),
  );

  const mushroomSpecs: [number, number][] = [
    [1.1, 5.1],
    [-0.8, 4.6],
    [0.4, 7.8],
    [-1.7, 6.6],
    [2.0, 5.6],
  ];
  const mushrooms = mushroomSpecs.flatMap(([x, z], i) => [
    entity(
      `ent_stem${i}`,
      `きのこの軸${i + 1}`,
      60 + i * 2,
      [x, 0.06, z],
      [0, 0, 0],
      [1, 1, 1],
      "cylinder",
      [0.06, 0.12, 0.06],
      "#efe6d6",
    ),
    entity(
      `ent_cap${i}`,
      `きのこ${i + 1}`,
      61 + i * 2,
      [x, 0.13, z],
      [0, 0, 0],
      [1, 1, 1],
      "cylinder",
      [0.22, 0.07, 0.22],
      i % 2 === 0 ? "#a85a55" : "#c4b48a",
    ),
  ]);

  return {
    version: 1,
    name: "森",
    kokostates: [],
    systems: [],
    materials: [],
    assets: models.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      contentType: m.contentType,
    })),
    folders: [{ id: "f_models", name: "Models", parent: null }],
    placement: Object.fromEntries(models.map((m) => [m.id, "f_models"])),
    outputs: [{ id: OUT, name: "森", kind: "world", systems: [], keep: [] }],
    entities: [
      entity(
        "ent_ground",
        "地面",
        0,
        [0, 0.02, 6],
        [0, 0, 0],
        [1, 1, 1],
        "plane",
        [80, 1, 80],
        "#5f8f5a",
      ),
      entity(
        "ent_clearing",
        "空き地",
        1,
        [0, 0.03, 6],
        [0, 0, 0],
        [1, 1, 1],
        "cylinder",
        [9, 0.02, 9],
        "#8eaf78",
      ),
      entity(
        "ent_log",
        "倒木",
        2,
        [2.3, 0.16, 4.3],
        [82, 28, 0],
        [1, 1, 1],
        "cylinder",
        [0.28, 2.4, 0.28],
        "#6a4b32",
      ),
      ...rocks,
      ...mushrooms,
      ...trees,
    ],
  };
}
