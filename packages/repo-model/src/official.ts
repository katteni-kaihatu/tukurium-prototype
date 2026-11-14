import { FIELD_TYPE, type KokoStateValues, type Vec3 } from "@tukurium/eks";
import { BUILTIN } from "./builtins";
import { OFFICIAL_THUMBNAILS } from "./officialThumbnails.generated";
import { packageResourceId } from "./packageDependency";
import { gunAndTargetSample } from "./samples";
import type { AssetDef, PackageDependency, ProjectSnapshot } from "./schema";

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

/** 公式ライブラリのサムネイル（同梱の画像。サーバーが起動時に素材置き場へ入れる。ADR 0046） */
function thumbnailAsset(key: keyof typeof OFFICIAL_THUMBNAILS): AssetDef {
  return {
    id: OFFICIAL_THUMBNAILS[key],
    name: `${key} のサムネイル`,
    kind: "image",
    contentType: "image/png",
  };
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
        description: "ダメージを受ける Entity の体力。",
        fields: [
          {
            id: "f_hp",
            name: "hp",
            description: "残りの体力。Damage で減り、0 より下にはならない。",
            type: FIELD_TYPE.number,
            default: 3,
          },
          {
            id: "f_maxHp",
            name: "maxHp",
            description: "体力の上限。復帰時などに使う。",
            type: FIELD_TYPE.number,
            default: 3,
          },
        ],
      },
    ],
    systems: [{ id: OFFICIAL_COMBAT.damageable, name: "Damageable", code: DAMAGEABLE }],
    materials: [],
    outputs: [
      {
        id: OFFICIAL_COMBAT.outputId,
        name: "combat",
        kind: "library",
        systems: [],
        keep: [],
        thumbnail: OFFICIAL_THUMBNAILS.combat,
        resources: [OFFICIAL_COMBAT.damageable, OFFICIAL_COMBAT.health].sort(),
      },
    ],
    assets: [thumbnailAsset("combat")],
    entities: [],
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
        description: "Interact を受けるたびに切り替わるスイッチ。",
        fields: [
          {
            id: "f_on",
            name: "on",
            description: "オンなら true、オフなら false。",
            type: FIELD_TYPE.boolean,
            default: false,
          },
        ],
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
        thumbnail: OFFICIAL_THUMBNAILS.interaction,
        resources: [OFFICIAL_INTERACTION.toggle, OFFICIAL_INTERACTION.toggleable].sort(),
      },
    ],
    assets: [thumbnailAsset("interaction")],
    entities: [],
  };
}

const KEY_PICKUP = `// 鍵を E で拾う：押した人のバッグに入れて、自分（落ちている鍵）を消す（ADR 0018）。
import Key from "./Key.koko";

export default system({
  query: { with: [Key] },

  contracts: {
    Interact(e, ev) {
      if (bag.add(Key, e.get(Key))) {
        log("鍵を拾った", "（" + ev.player + "）");
        world.destroy(e.id);
      } else {
        log("バッグがいっぱいです");
      }
    },
  },
});
`;

/** 公式「items」：持ち物の種類 Key と、E で拾ってバッグに入れる System */
export const OFFICIAL_ITEMS = {
  alias: "items",
  repoId: "r_official_items",
  workId: "w_official_items",
  outputId: "out_items",
  key: "ks_key",
  keyPickup: "sys_key_pickup",
} as const;

function itemsLibrary(): ProjectSnapshot {
  return {
    version: 1,
    name: "items",
    kokostates: [
      {
        id: OFFICIAL_ITEMS.key,
        name: "Key",
        description: "バッグに入れて持ち運べる鍵。",
        fields: [
          {
            id: "f_color",
            name: "color",
            description: "鍵の色。同じ色の錠を開けるために使う。",
            type: FIELD_TYPE.color,
            default: "#f1c40f",
          },
        ],
      },
    ],
    systems: [{ id: OFFICIAL_ITEMS.keyPickup, name: "KeyPickup", code: KEY_PICKUP }],
    materials: [],
    outputs: [
      {
        id: OFFICIAL_ITEMS.outputId,
        name: "items",
        kind: "library",
        systems: [],
        keep: [],
        thumbnail: OFFICIAL_THUMBNAILS.items,
        resources: [OFFICIAL_ITEMS.key, OFFICIAL_ITEMS.keyPickup].sort(),
      },
    ],
    assets: [thumbnailAsset("items")],
    entities: [],
  };
}

/** サーバーに同梱する公式ライブラリ */
export function officialLibraries(): OfficialLibrary[] {
  return [
    {
      alias: OFFICIAL_ITEMS.alias,
      repoId: OFFICIAL_ITEMS.repoId,
      workId: OFFICIAL_ITEMS.workId,
      outputId: OFFICIAL_ITEMS.outputId,
      name: "items",
      description: "持ち物の種類 Key と、E で拾ってプレイヤーのバッグに入れる System（公式）",
      snapshot: itemsLibrary(),
    },
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
      description: "倒れた的が復帰するまでの時間。",
      fields: [
        {
          id: "f_respawn",
          name: "respawn",
          description: "倒れてから戻るまでの秒数。",
          type: FIELD_TYPE.number,
          default: 2,
        },
        {
          id: "f_downTime",
          name: "downTime",
          description: "復帰するまでの残り秒数。",
          type: FIELD_TYPE.number,
          default: 0,
        },
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
        description: "スイッチに合わせて開閉する扉。",
        fields: [
          {
            id: "f_openAngle",
            name: "openAngle",
            description: "開いたときの角度（度）。",
            type: FIELD_TYPE.number,
            default: 90,
          },
          {
            id: "f_speed",
            name: "speed",
            description: "一秒で回転する角度（度）。",
            type: FIELD_TYPE.number,
            default: 120,
          },
          {
            id: "f_angle",
            name: "angle",
            description: "いまの角度（度）。",
            type: FIELD_TYPE.number,
            default: 0,
          },
          {
            id: "f_switch",
            name: "switch",
            description: "開閉を決める Toggle を持つ Entity。",
            type: FIELD_TYPE.entity,
            default: undefined,
          },
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
            material: undefined,
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

const LOCKED_DOOR = `// 鍵のかかった扉：E で押すと、押した人のバッグから同じ色の鍵（公式の Key）を取り出して開く。
// 開いた扉は上へ上がる。鍵は別の作者の作品で拾ったものでもよい（同じ公式 items の版なら同じ種類）。
import Key from "@items/Key.koko";
import Lock from "./Lock.koko";
import Transform from "@builtin/Transform.koko";

export default system({
  query: { with: [Lock, Transform] },

  contracts: {
    Interact(e, ev) {
      const l = e.get(Lock);
      if (l.open) return;
      if (bag.take(Key, { color: l.color })) {
        l.open = true;
        log(e.id, "鍵で開いた");
      } else {
        log(e.id, "鍵がかかっている（持っている鍵：" + bag.count(Key) + " 本）");
      }
    },
  },

  onUpdate(e, dt) {
    const l = e.get(Lock);
    if (!l.open || l.height >= l.lift) return;
    const step = Math.min(l.lift - l.height, l.speed * dt);
    l.height += step;
    const t = e.get(Transform);
    t.position = [t.position[0], t.position[1] + step, t.position[2]];
  },
});
`;

/**
 * reference UGC「鍵と扉」：落ちている鍵を E で拾うとバッグに入り、鍵のかかった扉を E で押すと、
 * 同じ色の鍵を取り出して開く（ADR 0018）。拾う仕組みと鍵の種類は公式「items」、扉は自分の System。
 * `items` は、そのサーバーの公式 items の lock。
 */
export function referenceKeyAndDoor(items: PackageDependency): ProjectSnapshot {
  const key = packageResourceId(items, OFFICIAL_ITEMS.key);
  const keyPickup = packageResourceId(items, OFFICIAL_ITEMS.keyPickup);
  const out = "out_key_door";
  const transform = (position: Vec3): KokoStateValues => ({
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  return {
    version: 1,
    name: "鍵と扉",
    dependencies: [items],
    kokostates: [
      {
        id: "ks_lock",
        name: "Lock",
        description: "同じ色の鍵を使うと開く錠。",
        fields: [
          {
            id: "f_color",
            name: "color",
            description: "この錠を開ける鍵の色。",
            type: FIELD_TYPE.color,
            default: "#f1c40f",
          },
          {
            id: "f_open",
            name: "open",
            description: "鍵で開いたら true。",
            type: FIELD_TYPE.boolean,
            default: false,
          },
          {
            id: "f_height",
            name: "height",
            description: "開き始めてから持ち上がった高さ。",
            type: FIELD_TYPE.number,
            default: 0,
          },
          {
            id: "f_lift",
            name: "lift",
            description: "開いたときに持ち上げる高さ。",
            type: FIELD_TYPE.number,
            default: 2.2,
          },
          {
            id: "f_speed",
            name: "speed",
            description: "一秒で持ち上げる距離。",
            type: FIELD_TYPE.number,
            default: 2,
          },
        ],
      },
    ],
    systems: [{ id: "sys_locked_door", name: "LockedDoor", code: LOCKED_DOOR }],
    materials: [{ id: "mat_wood", name: "Wood", color: "#a47b55", roughness: 0.8, metalness: 0 }],
    outputs: [
      {
        id: out,
        name: "鍵と扉",
        kind: "item",
        systems: [
          { id: keyPickup, enabled: true },
          { id: "sys_locked_door", enabled: true },
        ],
        keep: [],
      },
    ],
    entities: [
      {
        id: "ent_key",
        name: "鍵",
        parent: null,
        output: out,
        order: 0,
        states: {
          [BUILTIN.Transform]: transform([-1, 0.6, -2.5]),
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [0.3, 0.1, 0.1],
            material: undefined,
            color: "#f1c40f",
          },
          [BUILTIN.Collider]: { sensor: false },
          [key]: { f_color: "#f1c40f" },
        },
      },
      {
        id: "ent_locked_door",
        name: "鍵のかかった扉",
        parent: null,
        output: out,
        order: 1,
        states: {
          [BUILTIN.Transform]: transform([1, 1, -4]),
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [1, 2, 0.1],
            material: "mat_wood",
            color: "#d8d2c6",
          },
          [BUILTIN.Collider]: { sensor: false },
          ks_lock: { f_color: "#f1c40f", f_open: false, f_height: 0, f_lift: 2.2, f_speed: 2 },
        },
      },
    ],
  };
}
