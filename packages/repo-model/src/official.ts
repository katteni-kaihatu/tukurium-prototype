import type { KokoStateValues, Vec3 } from "@tukurium/eks";
import { BUILTIN } from "./builtins";
import { packageResourceId } from "./packageDependency";
import { gunAndTargetSample } from "./samples";
import type { PackageDependency, ProjectSnapshot } from "./schema";

/**
 * 公式の Platform Library（ADR 0016・計画 U4）。
 *
 * - 「公式」かどうかは、名前ではなく発行者（作品の持ち主）が公式の発行者かで決める（ADR 0013 §1）。
 * - 公式ライブラリはサーバーに同梱し、起動のときに公式の発行者の作品として登録する。
 *   リポジトリ・作品の ID は決まった値なので、どのサーバーでも同じ Package ID になる。
 * - 中身を変えたら、起動のときに新しい版として出す（出した版は書き換えない）。
 * - 公式ライブラリはセキュリティの境界ではない（Runtime gateway を迂回できる特権は持たない）。
 */

export const OFFICIAL_PUBLISHER = { id: "u_official", name: "Tukurium 公式" } as const;

/** 公式の発行者の作品か（名前は見ない） */
export const isOfficial = (owner: string): boolean => owner === OFFICIAL_PUBLISHER.id;

export interface OfficialLibrary {
  /** 使う側の既定の別名 */
  alias: string;
  repoId: string;
  /** Package ID（作品の ID） */
  workId: string;
  outputId: string;
  name: string;
  description: string;
  snapshot: ProjectSnapshot;
}

const DAMAGEABLE = `// Damage を受けて Health の hp を減らす（0 より下にはしない）。
// 倒れる・戻るなどの見た目や動きは、使う側の System で hp を見て決める。
import Health from "./Health.koko";

export default system({
  query: { with: [Health] },

  // 外に公開する操作（ほかの作者の銃からも呼べる。Damage の形は Built-in の Damage v1）
  contracts: {
    Damage(e, damage) {
      const h = e.get(Health);
      if (h.hp <= 0) return;
      h.hp = Math.max(0, h.hp - damage.amount);
    },
  },
});
`;

/** 公式「combat」：Health と、Damage を受けて hp を減らす System */
export const OFFICIAL_COMBAT = {
  alias: "combat",
  repoId: "r_official_combat",
  workId: "w_official_combat",
  outputId: "out_combat",
  health: "ks_health",
  damageable: "sys_damageable",
} as const;

function combatLibrary(): ProjectSnapshot {
  return {
    version: 1,
    name: "combat",
    kokostates: [
      {
        id: OFFICIAL_COMBAT.health,
        name: "Health",
        fields: [
          { id: "f_hp", name: "hp", type: "number", default: 3 },
          { id: "f_maxHp", name: "maxHp", type: "number", default: 3 },
        ],
      },
    ],
    systems: [{ id: OFFICIAL_COMBAT.damageable, name: "Damageable", code: DAMAGEABLE }],
    materials: [],
    outputs: [
      { id: OFFICIAL_COMBAT.outputId, name: "combat", kind: "library", systems: [], keep: [] },
    ],
    entities: [],
    exports: [OFFICIAL_COMBAT.damageable, OFFICIAL_COMBAT.health].sort(),
  };
}

const TOGGLEABLE = `// Interact（プレイヤーが E で押す）を受けて、Toggle の on を切り替える。
// 切り替わったあとに何が起きるか（扉が開く・明かりが付く）は、使う側の System で on を見て決める。
import Toggle from "./Toggle.koko";

export default system({
  query: { with: [Toggle] },

  // 外に公開する操作（Interact は Built-in の Interact v1。送れるのはプレイヤーの操作だけ）
  contracts: {
    Interact(e, ev) {
      const t = e.get(Toggle);
      t.on = !t.on;
      log(e.id, t.on ? "オン" : "オフ", "（" + ev.player + "）");
    },
  },
});
`;

/** 公式「interaction」：Toggle と、Interact を受けて on を切り替える System */
export const OFFICIAL_INTERACTION = {
  alias: "interaction",
  repoId: "r_official_interaction",
  workId: "w_official_interaction",
  outputId: "out_interaction",
  toggle: "ks_toggle",
  toggleable: "sys_toggleable",
} as const;

function interactionLibrary(): ProjectSnapshot {
  return {
    version: 1,
    name: "interaction",
    kokostates: [
      {
        id: OFFICIAL_INTERACTION.toggle,
        name: "Toggle",
        fields: [{ id: "f_on", name: "on", type: "boolean", default: false }],
      },
    ],
    systems: [{ id: OFFICIAL_INTERACTION.toggleable, name: "Toggleable", code: TOGGLEABLE }],
    materials: [],
    outputs: [
      {
        id: OFFICIAL_INTERACTION.outputId,
        name: "interaction",
        kind: "library",
        systems: [],
        keep: [],
      },
    ],
    entities: [],
    exports: [OFFICIAL_INTERACTION.toggle, OFFICIAL_INTERACTION.toggleable].sort(),
  };
}

/** サーバーに同梱する公式ライブラリ */
export function officialLibraries(): OfficialLibrary[] {
  return [
    {
      alias: OFFICIAL_INTERACTION.alias,
      repoId: OFFICIAL_INTERACTION.repoId,
      workId: OFFICIAL_INTERACTION.workId,
      outputId: OFFICIAL_INTERACTION.outputId,
      name: "interaction",
      description: "Toggle と、Interact（E で押す）を受けて on を切り替える System（公式）",
      snapshot: interactionLibrary(),
    },
    {
      alias: OFFICIAL_COMBAT.alias,
      repoId: OFFICIAL_COMBAT.repoId,
      workId: OFFICIAL_COMBAT.workId,
      outputId: OFFICIAL_COMBAT.outputId,
      name: "combat",
      description: "Health と、Damage を受けて hp を減らす System（公式）",
      snapshot: combatLibrary(),
    },
  ];
}

const TARGET_FALL = `// 的：hp が 0 になったら倒れ、しばらくすると戻る。
// hp を減らすのは公式ライブラリの Damageable（@combat）。ここは見た目と戻り方だけを決める。
import Health from "@combat/Health.koko";
import Respawn from "./Respawn.koko";
import Transform from "@builtin/Transform.koko";
import Mesh from "@builtin/Mesh.koko";

export default system({
  query: { with: [Health, Respawn, Transform, Mesh] },

  onUpdate(e, dt) {
    const h = e.get(Health);
    const r = e.get(Respawn);
    if (h.hp > 0) {
      // 当たって減っていたら色で知らせる
      e.get(Mesh).color = h.hp < h.maxHp ? "#fdd046" : "#c0392b";
      return;
    }
    if (r.downTime <= 0) {
      r.downTime = r.respawn;
      e.get(Transform).rotation = [0, 0, 0];
      e.get(Mesh).color = "#8a8792";
      log(e.id, "倒れた");
      return;
    }
    r.downTime -= dt;
    if (r.downTime <= 0) {
      h.hp = h.maxHp;
      e.get(Transform).rotation = [90, 0, 0];
      e.get(Mesh).color = "#c0392b";
    }
  },
});
`;

/**
 * reference UGC「銃と的（公式ライブラリ）」：今の銃と的のサンプルと同じ遊び方で、的の hp と
 * Damage の受け取りを公式「combat」に任せる。銃の弾・連射・リロード、的が倒れて戻る動きは自分で持つ。
 * `combat` は、そのサーバーの公式 combat の lock（別名・Package ID・版・hash）。
 */
export function referenceGunAndTarget(combat: PackageDependency): ProjectSnapshot {
  const s = gunAndTargetSample();
  const health = packageResourceId(combat, OFFICIAL_COMBAT.health);
  const damageable = packageResourceId(combat, OFFICIAL_COMBAT.damageable);
  s.name = "銃と的（公式ライブラリ）";
  s.dependencies = [combat];
  s.kokostates = [
    ...s.kokostates.filter((k) => k.id !== "ks_target"),
    {
      id: "ks_respawn",
      name: "Respawn",
      fields: [
        { id: "f_respawn", name: "respawn", type: "number", default: 2 },
        { id: "f_downTime", name: "downTime", type: "number", default: 0 },
      ],
    },
  ];
  s.systems = [
    ...s.systems.filter((x) => x.id !== "sys_target"),
    { id: "sys_target_fall", name: "TargetFall", code: TARGET_FALL },
  ];
  for (const o of s.outputs)
    o.systems = [
      { id: "sys_shoot", enabled: true },
      { id: damageable, enabled: true },
      { id: "sys_target_fall", enabled: true },
    ];
  for (const e of s.entities) {
    const t = e.states.ks_target;
    if (!t) continue;
    delete e.states.ks_target;
    e.states[health] = { f_hp: t.f_hp ?? 3, f_maxHp: t.f_maxHp ?? 3 };
    e.states.ks_respawn = { f_respawn: t.f_respawn ?? 2, f_downTime: t.f_downTime ?? 0 };
  }
  return s;
}

const DOOR_SWING = `// 扉：つないだスイッチ（公式の Toggle）がオンなら開き、オフなら閉じる。
// 扉は「軸」の Entity を回す（扉の板は軸の子なので、軸のまわりに回る）。
import Door from "./Door.koko";
import Toggle from "@interaction/Toggle.koko";
import Transform from "@builtin/Transform.koko";

export default system({
  query: { with: [Door, Transform] },

  onUpdate(e, dt) {
    const d = e.get(Door);
    const sw = d.switch ? world.get(d.switch, Toggle) : null;
    const target = sw && sw.on ? d.openAngle : 0;
    const step = d.speed * dt;
    d.angle = d.angle < target ? Math.min(target, d.angle + step) : Math.max(target, d.angle - step);
    e.get(Transform).rotation = [0, d.angle, 0];
  },
});
`;

const SWITCH_LIGHT = `// スイッチの色：オンなら緑、オフなら赤
import Toggle from "@interaction/Toggle.koko";
import Mesh from "@builtin/Mesh.koko";

export default system({
  query: { with: [Toggle, Mesh] },

  onUpdate(e) {
    e.get(Mesh).color = e.get(Toggle).on ? "#2ecc71" : "#c0392b";
  },
});
`;

/**
 * reference UGC「扉とスイッチ」：スイッチを E で押すと扉が開き、もう一度押すと閉じる。
 * 押されて切り替わる仕組みは公式「interaction」（Toggle・Toggleable）に任せ、扉の開き方（角度・速さ）と
 * スイッチの色は自分で持つ。`interaction` は、そのサーバーの公式 interaction の lock。
 */
export function referenceDoorAndSwitch(interaction: PackageDependency): ProjectSnapshot {
  const toggle = packageResourceId(interaction, OFFICIAL_INTERACTION.toggle);
  const toggleable = packageResourceId(interaction, OFFICIAL_INTERACTION.toggleable);
  const out = "out_door";
  const transform = (position: Vec3): KokoStateValues => ({
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  return {
    version: 1,
    name: "扉とスイッチ",
    dependencies: [interaction],
    kokostates: [
      {
        id: "ks_door",
        name: "Door",
        fields: [
          { id: "f_openAngle", name: "openAngle", type: "number", default: 90 },
          { id: "f_speed", name: "speed", type: "number", default: 120 },
          { id: "f_angle", name: "angle", type: "number", default: 0 },
          { id: "f_switch", name: "switch", type: "entity", default: null },
        ],
      },
    ],
    systems: [
      { id: "sys_door_swing", name: "DoorSwing", code: DOOR_SWING },
      { id: "sys_switch_light", name: "SwitchLight", code: SWITCH_LIGHT },
    ],
    materials: [{ id: "mat_wood", name: "Wood", color: "#a47b55", roughness: 0.8, metalness: 0 }],
    outputs: [
      {
        id: out,
        name: "扉",
        kind: "item",
        systems: [
          { id: toggleable, enabled: true },
          { id: "sys_door_swing", enabled: true },
          { id: "sys_switch_light", enabled: true },
        ],
        keep: [],
      },
    ],
    entities: [
      {
        id: "ent_switch",
        name: "スイッチ",
        parent: null,
        output: out,
        order: 0,
        states: {
          [BUILTIN.Transform]: transform([1.2, 1.2, -3]),
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [0.2, 0.3, 0.12],
            material: null,
            color: "#c0392b",
          },
          [BUILTIN.Collider]: { sensor: false },
          [toggle]: { f_on: false },
        },
      },
      {
        id: "ent_hinge",
        name: "扉の軸",
        parent: null,
        output: out,
        order: 1,
        states: {
          [BUILTIN.Transform]: transform([-0.5, 0, -4]),
          ks_door: { f_openAngle: 90, f_speed: 120, f_angle: 0, f_switch: "ent_switch" },
        },
      },
      {
        id: "ent_door",
        name: "扉",
        parent: "ent_hinge",
        output: out,
        order: 2,
        states: {
          [BUILTIN.Transform]: transform([0.5, 1, 0]),
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [1, 2, 0.08],
            material: "mat_wood",
            color: "#d8d2c6",
          },
          [BUILTIN.Collider]: { sensor: false },
        },
      },
    ],
  };
}
