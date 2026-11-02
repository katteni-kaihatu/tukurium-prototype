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

export const NEW_SYSTEM_CODE = `export default system({
  // この System が処理する Entity の条件（KokoState の名前）
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
    if (hit) world.emit(hit.entity, "hit", { damage: gun.damage });
  },
});
`;

const TARGET = `// 的：hit を受けると hp が減り、0 になると倒れて、しばらくすると戻る
export default system({
  query: { with: ["Target", "Transform", "Mesh"] },

  onEvent(e, ev) {
    if (ev.name !== "hit" || e.Target.hp <= 0) return;
    e.Target.hp -= ev.data.damage;
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
      { id: "mat_gun", name: "Gunmetal", color: "#3a3942", roughness: 0.35, metalness: 0.8 },
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
          [BUILTIN.Transform]: { position: [0, 1.1, -1.5], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [0.08, 0.12, 0.42],
            material: "mat_gun",
            color: "#3a3942",
          },
          [BUILTIN.Held]: { offset: [0.22, -0.2, -0.45] },
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
