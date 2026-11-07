import { BUILTIN } from "./builtins";
import type { EntityDef, ProjectSnapshot } from "./schema";

/** 新しいリポジトリの初期内容。空のアイテム 1 つ。 */
export function emptyProject(name: string): ProjectSnapshot {
  return {
    version: 1,
    name,
    kokostates: [],
    systems: [],
    materials: [],
    outputs: [{ id: "out_main", name, kind: "item", systems: [], keep: [] }],
    entities: [],
  };
}

export const NEW_SYSTEM_CODE = `// KokoState は import で読み込む（例：import Gun from "./Gun.koko";）
export default system({
  // この System が処理する Entity の条件（import した KokoState）
  query: { with: [], without: [] },

  onUpdate(e, dt) {
    // 毎フレーム呼ばれる
  },
});
`;

const SHOOT = `// 射撃：Gun を持つ Entity が、入力 fire で視線の先に弾を撃つ
export default system({
  query: { with: ["Gun"] },

  onUpdate(e, dt) {
    e.Gun.cooldown = Math.max(0, e.Gun.cooldown - dt);
  },

  onInput(e, ev) {
    const gun = e.Gun;
    if (ev.action === "reload" && ev.phase === "down") {
      gun.ammo = gun.maxAmmo;
      log("リロード", gun.ammo);
      return;
    }
    if (ev.action !== "fire" || ev.phase !== "down") return;
    if (gun.ammo <= 0) {
      log("弾切れ（R でリロード）");
      return;
    }
    if (gun.cooldown > 0) return;
    gun.ammo -= 1;
    gun.cooldown = gun.interval;
    const hit = world.raycast(ev.origin, ev.direction, 100);
    if (!hit) return;
    // 当たった点に火花を出し、相手が公開している Damage を送る（別の作者の的にも届く。ADR 0012）
    hit.effect("spark", { color: "#ffd166" });
    hit.send("Damage", { amount: gun.damage });
  },
});
`;

const TARGET = `// 的：Damage を受けると hp が減り、0 になると倒れて、しばらくすると戻る
export default system({
  query: { with: ["Target", "Transform", "Mesh"] },

  // 外に公開する操作（ほかの作者の銃からも呼べる）
  contracts: {
    Damage(e, damage) {
      if (e.Target.hp <= 0) return;
      e.Target.hp -= damage.amount;
      if (e.Target.hp <= 0) {
        e.Target.downTime = e.Target.respawn;
        e.Transform.rotation = [0, 0, 0];
        e.Mesh.color = "#8a8792";
        log(e.id, "命中！倒れた");
      } else {
        e.Mesh.color = "#fdd046";
        log(e.id, "命中 残り", e.Target.hp);
      }
    },
  },

  onUpdate(e, dt) {
    if (e.Target.hp > 0) return;
    e.Target.downTime -= dt;
    if (e.Target.downTime <= 0) {
      e.Target.hp = e.Target.maxHp;
      e.Transform.rotation = [90, 0, 0];
      e.Mesh.color = "#c0392b";
    }
  },
});
`;

/** 同梱サンプル：銃と的（M1 では 1 つのアウトプットにまとめる） */
export function gunAndTargetSample(): ProjectSnapshot {
  const out = "out_range";
  const target = (n: number, x: number): EntityDef => ({
    id: `ent_target${n}`,
    name: `的${n}`,
    parent: null,
    output: out,
    order: n,
    states: {
      [BUILTIN.Transform]: { position: [x, 1.5, -5], rotation: [90, 0, 0], scale: [1, 1, 1] },
      [BUILTIN.Mesh]: {
        shape: "cylinder",
        size: [0.7, 0.08, 0.7],
        material: null,
        color: "#c0392b",
      },
      [BUILTIN.Collider]: { sensor: false },
      ks_target: { f_hp: 3, f_maxHp: 3, f_respawn: 2, f_downTime: 0 },
    },
  });
  const pole = (n: number, x: number): EntityDef => ({
    id: `ent_pole${n}`,
    name: `支柱${n}`,
    parent: null,
    output: out,
    order: 10 + n,
    states: {
      [BUILTIN.Transform]: { position: [x, 0.55, -5.1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      [BUILTIN.Mesh]: {
        shape: "box",
        size: [0.08, 1.1, 0.08],
        material: "mat_wood",
        color: "#d8d2c6",
      },
    },
  });

  return {
    version: 1,
    name: "銃と的",
    kokostates: [
      {
        id: "ks_gun",
        name: "Gun",
        fields: [
          { id: "f_ammo", name: "ammo", type: "number", default: 12 },
          { id: "f_maxAmmo", name: "maxAmmo", type: "number", default: 12 },
          { id: "f_interval", name: "interval", type: "number", default: 0.2 },
          { id: "f_cooldown", name: "cooldown", type: "number", default: 0 },
          { id: "f_damage", name: "damage", type: "number", default: 1 },
        ],
      },
      {
        id: "ks_target",
        name: "Target",
        fields: [
          { id: "f_hp", name: "hp", type: "number", default: 3 },
          { id: "f_maxHp", name: "maxHp", type: "number", default: 3 },
          { id: "f_respawn", name: "respawn", type: "number", default: 2 },
          { id: "f_downTime", name: "downTime", type: "number", default: 0 },
        ],
      },
    ],
    systems: [
      { id: "sys_shoot", name: "Shoot", code: SHOOT },
      { id: "sys_target", name: "TargetHit", code: TARGET },
    ],
    materials: [
      { id: "mat_gun", name: "Gunmetal", color: "#5e5c64", roughness: 0.45, metalness: 0.3 },
      { id: "mat_wood", name: "Wood", color: "#a47b55", roughness: 0.8, metalness: 0 },
    ],
    outputs: [
      {
        id: out,
        name: "射撃場",
        kind: "item",
        systems: [
          { id: "sys_shoot", enabled: true },
          { id: "sys_target", enabled: true },
        ],
        keep: [{ entity: "ent_gun", koko: "ks_gun", field: "f_ammo" }],
      },
    ],
    entities: [
      {
        id: "ent_gun",
        name: "銃",
        parent: null,
        output: out,
        order: 0,
        states: {
          // 再生を始めた位置（+Z 側 6m）の少し前に置く。E で拾うと右手に装備する（ADR 0053）
          [BUILTIN.Transform]: { position: [0, 1.1, 3.6], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [0.08, 0.12, 0.42],
            material: "mat_gun",
            color: "#3a3942",
          },
          // 拾うには当たり判定が要る（見ている物を E で調べるため）
          [BUILTIN.Collider]: { sensor: false },
          [BUILTIN.EquipmentTool]: { offset: [0.28, -0.26, -0.75] },
          ks_gun: { f_ammo: 12, f_maxAmmo: 12, f_interval: 0.2, f_cooldown: 0, f_damage: 1 },
        },
      },
      target(1, -1.6),
      target(2, 0),
      target(3, 1.6),
      pole(1, -1.6),
      pole(2, 0),
      pole(3, 1.6),
    ],
  };
}

/** 同梱サンプル：銃だけ（セッションで別のリポジトリの的と組み合わせる用） */
export function gunSample(): ProjectSnapshot {
  const all = gunAndTargetSample();
  return {
    ...all,
    name: "銃",
    kokostates: all.kokostates.filter((k) => k.id === "ks_gun"),
    systems: all.systems.filter((s) => s.id === "sys_shoot"),
    materials: all.materials.filter((m) => m.id === "mat_gun"),
    outputs: [
      {
        id: "out_gun",
        name: "銃",
        kind: "item",
        systems: [{ id: "sys_shoot", enabled: true }],
        keep: [{ entity: "ent_gun", koko: "ks_gun", field: "f_ammo" }],
      },
    ],
    entities: all.entities
      .filter((e) => e.id === "ent_gun")
      .map((e) => ({ ...e, output: "out_gun" })),
  };
}

/** 同梱サンプル：射撃場（的と支柱） */
export function targetRangeSample(): ProjectSnapshot {
  const all = gunAndTargetSample();
  return {
    ...all,
    name: "射撃場",
    kokostates: all.kokostates.filter((k) => k.id === "ks_target"),
    systems: all.systems.filter((s) => s.id === "sys_target"),
    materials: all.materials.filter((m) => m.id === "mat_wood"),
    outputs: [
      {
        id: "out_range",
        name: "射撃場",
        kind: "item",
        systems: [{ id: "sys_target", enabled: true }],
        keep: [],
      },
    ],
    entities: all.entities.filter((e) => e.id !== "ent_gun"),
  };
}
