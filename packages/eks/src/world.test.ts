import { describe, expect, it } from "vitest";
import { KokoStateRegistry } from "./registry";
import { Scheduler } from "./scheduler";
import type { KokoStateDef } from "./types";
import { World } from "./world";

const Gun: KokoStateDef = {
  id: "ks_gun",
  name: "Gun",
  fields: [
    { id: "f_ammo", name: "ammo", type: "number", default: 12 },
    { id: "f_muzzle", name: "muzzle", type: "vec3", default: [0, 0, 1] },
  ],
};
const Disabled: KokoStateDef = { id: "ks_disabled", name: "Disabled", fields: [] };

function setup() {
  const registry = new KokoStateRegistry();
  registry.register(Gun);
  registry.register(Disabled);
  return new World(registry);
}

describe("World", () => {
  it("初期値で KokoState を付け、値は定義の default と共有しない", () => {
    const w = setup();
    const e = w.spawn("e1");
    const v = w.add(e, Gun.id);
    expect(v).toEqual({ f_ammo: 12, f_muzzle: [0, 0, 1] });
    (v.f_muzzle as number[])[0] = 5;
    expect(Gun.fields[1]?.default).toEqual([0, 0, 1]);
  });

  it("With / Without で絞り込む", () => {
    const w = setup();
    w.add(w.spawn("a"), Gun.id);
    const b = w.spawn("b");
    w.add(b, Gun.id);
    w.add(b, Disabled.id);
    w.spawn("c");
    expect(w.query({ with: [Gun.id] }).sort()).toEqual(["a", "b"]);
    expect(w.query({ with: [Gun.id], without: [Disabled.id] })).toEqual(["a"]);
  });

  it("親を消すと子も消える", () => {
    const w = setup();
    w.spawn("p");
    w.spawn("c", "p");
    w.spawn("gc", "c");
    w.destroy("p");
    expect(w.entityIds()).toEqual([]);
  });

  it("スナップショットから復元でき、実行時 ID が重複しない", () => {
    const w = setup();
    const e = w.spawn();
    w.add(e, Gun.id, { f_ammo: 3 });
    const snap = w.snapshot();
    const w2 = setup();
    w2.restore(snap);
    expect(w2.get(e, Gun.id)?.f_ammo).toBe(3);
    expect(w2.spawn()).not.toBe(e);
  });

  it("同じ名前の別定義は登録できない", () => {
    const r = new KokoStateRegistry();
    r.register(Gun);
    expect(() => r.register({ ...Gun, id: "other" })).toThrow();
  });
});

describe("Scheduler", () => {
  it("登録順に実行し、例外を出した System だけ止める", () => {
    const w = setup();
    w.add(w.spawn("a"), Gun.id);
    const order: string[] = [];
    const s = new Scheduler();
    s.setSystems([
      {
        id: "bad",
        name: "Bad",
        query: { with: [Gun.id] },
        enabled: true,
        onUpdate: () => {
          order.push("bad");
          throw new Error("boom");
        },
      },
      {
        id: "shoot",
        name: "Shoot",
        query: { with: [Gun.id] },
        enabled: true,
        onUpdate: (world, e) => {
          order.push("shoot");
          const g = world.get(e, Gun.id);
          if (g) g.f_ammo = (g.f_ammo as number) - 1;
        },
      },
    ]);
    s.tick(w, 1 / 60);
    s.tick(w, 1 / 60);
    expect(order).toEqual(["bad", "shoot", "shoot"]);
    expect(w.get("a", Gun.id)?.f_ammo).toBe(10);
    expect(s.errors).toHaveLength(1);
  });
});

describe("KokoStateRegistry のスコープ", () => {
  it("スコープが違えば同じ名前を登録でき、名前はスコープ→全体の順に引く", () => {
    const r = new KokoStateRegistry();
    r.register({ id: "builtin.T", name: "Transform", fields: [] });
    r.register({ id: "a:gun", name: "Gun", fields: [] }, "a");
    r.register({ id: "b:gun", name: "Gun", fields: [] }, "b");
    expect(r.idOf("Gun", "a")).toBe("a:gun");
    expect(r.idOf("Gun", "b")).toBe("b:gun");
    expect(r.idOf("Gun")).toBeUndefined();
    expect(r.idOf("Transform", "a")).toBe("builtin.T");
    expect(() => r.register({ id: "a:gun2", name: "Gun", fields: [] }, "a")).toThrow();
    r.unregister("a:gun");
    expect(r.idOf("Gun", "a")).toBeUndefined();
    expect(r.scopeOf("b:gun")).toBe("b");
  });
});
