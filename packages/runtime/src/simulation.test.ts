import {
  type FieldSchemas,
  parseValue,
  stringifyValue,
  type ValueSchema,
  type Vec3,
} from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  gunAndTargetSample,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";
import { inputWithTools } from "./testInput";
import { worldTransform } from "./transform";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const fire = (direction: Vec3, action = "fire") => ({
  action,
  phase: "down" as const,
  origin: [0, 1.5, 0] as Vec3,
  direction,
  player: "p1",
});

describe("Simulation：銃と的のサンプル", () => {
  it("撃つと弾が減り、当たった的の hp が減り、倒れてから復活する", async () => {
    const logs: LogEntry[] = [];
    sim = await Simulation.create(gunAndTargetSample(), "out_range", {
      realm: "repo1",
      onLog: (l) => logs.push(l),
    });
    expect(sim.systemStatus().every((s) => s.enabled && !s.error)).toBe(true);
    const target = () => sim?.world.get("ent_target2", "ks_target");
    const gun = () => sim?.world.get("ent_gun", "ks_gun");

    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(gun()?.f_ammo).toBe(11);
    expect(target()?.f_hp).toBe(2);
    expect(sim.world.get("ent_target2", BUILTIN.Mesh)?.color).toBe("#fdd046");

    // クールダウン中は撃てない
    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(gun()?.f_ammo).toBe(11);

    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 15; t++) sim.step(1 / 60);
      inputWithTools(sim, fire([0, 0, -1]));
      sim.step(1 / 60);
    }
    expect(target()?.f_hp).toBe(0);
    expect(sim.world.get("ent_target2", BUILTIN.Mesh)?.color).toBe("#8a8792");

    // 2 秒後に復活
    for (let t = 0; t < 130; t++) sim.step(1 / 60);
    expect(target()?.f_hp).toBe(3);
    // 他の的には当たっていない
    expect(sim.world.get("ent_target1", "ks_target")?.f_hp).toBe(3);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("外れた弾は何にも当たらない。リロードで弾が戻る", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "repo1" });
    inputWithTools(sim, fire([0, 1, 0]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
    expect(
      sim.world.query({ with: ["ks_target"] }).map((e) => sim?.world.get(e, "ks_target")?.f_hp),
    ).toEqual([3, 3, 3]);
    inputWithTools(sim, fire([0, 0, 0], "reload"));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(12);
  });
});

describe("Simulation：ホストの引き継ぎ", () => {
  it("別の Simulation に状態を移しても、続きから動く", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "a" });
    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    const snap = sim.world.snapshot();
    const names = Object.fromEntries(
      sim.world.entityIds().map((id) => [id, sim?.nameOf(id) ?? id]),
    );
    const time = sim.time;
    const ownership = sim.partEntitiesSnapshot();
    sim.dispose();

    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "b" });
    sim.restore(snap, names, time, ownership);
    expect(sim.world.get("ent_target2", "ks_target")?.f_hp).toBe(2);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
    expect(sim.time).toBeCloseTo(1 / 60);
    // 引き継いだあとも撃てて、当たる（物理ワールドは作り直される）
    for (let t = 0; t < 15; t++) sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_target2", "ks_target")?.f_hp).toBe(1);
    expect(sim.nameOf("ent_target2")).toBe("的2");
  });
});

function project(code: string, extra: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const p = emptyProject("t");
  p.kokostates = [
    { id: "ks_c", name: "Counter", fields: [{ id: "n", name: "n", type: "number", default: 0 }] },
  ];
  p.systems = [{ id: "sys_a", name: "A", code }];
  p.outputs = [
    { id: "out", name: "t", kind: "item", systems: [{ id: "sys_a", enabled: true }], keep: [] },
  ];
  p.entities = [
    { id: "e1", name: "e1", parent: null, output: "out", order: 0, states: { ks_c: { n: 0 } } },
  ];
  return { ...p, ...extra };
}

describe("Simulation：System の扱い", () => {
  it("Query に存在しない KokoState を書くと、その System だけ止まる", async () => {
    const p = project(
      `import Nope from "./Nope.koko"; export default system({ query: { with: [Nope] }, onUpdate() {} });`,
    );
    p.systems.push({
      id: "sys_b",
      name: "B",
      code: `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate(e) { e.get(C).n += 1; } });`,
    });
    p.outputs[0]?.systems.push({ id: "sys_b", enabled: true });
    sim = await Simulation.create(p, "out", { realm: "r" });
    sim.step(0.1);
    expect(sim.systemStatus().find((s) => s.id === "sys_a")?.error).toMatch(/Nope/);
    expect(sim.world.get("e1", "ks_c")?.n).toBe(1);
  });

  it("実行中に例外を出した System と、無限ループの System は止まり、ほかは動き続ける", async () => {
    const p = project(
      `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate() { throw new Error("boom"); } });`,
    );
    p.systems.push(
      {
        id: "sys_loop",
        name: "Loop",
        code: `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate() { for(;;){} } });`,
      },
      {
        id: "sys_ok",
        name: "Ok",
        code: `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate(e) { e.get(C).n += 1; } });`,
      },
    );
    p.outputs[0]?.systems.push({ id: "sys_loop", enabled: true }, { id: "sys_ok", enabled: true });
    sim = await Simulation.create(p, "out", { realm: "r", timeLimitMs: 20 });
    sim.step(0.1);
    sim.step(0.1);
    const status = Object.fromEntries(sim.systemStatus().map((s) => [s.id, s]));
    expect(status.sys_a?.enabled).toBe(false);
    expect(status.sys_a?.error).toMatch(/boom/);
    expect(status.sys_a?.line).toBe(1);
    expect(status.sys_loop?.error).toMatch(/時間制限/);
    expect(sim.world.get("e1", "ks_c")?.n).toBe(2);
  });

  it("TypeScript で書いた System を、型を消して動かす。誤りの行は TypeScript の行のまま（ADR 0058）", async () => {
    sim = await Simulation.create(
      project(
        [
          "interface Step { by: number }",
          "const step: Step = { by: 1 };",
          'import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate(e: any, dt: number) {',
          "  e.get(C).n += step.by as number;",
          '  if (e.get(C).n > 1) throw new Error("line 5");',
          "} });",
        ].join("\n"),
      ),
      "out",
      { realm: "r" },
    );
    sim.step(0.1);
    expect(sim.world.get("e1", "ks_c")?.n).toBe(1);
    sim.step(0.1);
    const status = sim.systemStatus().find((x) => x.id === "sys_a");
    expect(status?.error).toMatch(/line 5/);
    expect(status?.line).toBe(5);
  });

  it("型の合わない値の書き込みは無視する", async () => {
    sim = await Simulation.create(
      project(
        `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate(e) { e.get(C).n = "x"; } });`,
      ),
      "out",
      { realm: "r" },
    );
    sim.step(0.1);
    expect(sim.world.get("e1", "ks_c")?.n).toBe(0);
  });

  it("参照の「なし」は undefined。スクリプトから外せて、null は書けない（ADR 0065）", async () => {
    const p = project(`import C from "./Counter.koko";
      import L from "./Link.koko";
      export default system({
        query: { with: [C, L] },
        onUpdate(e) {
          const c = e.get(C);
          const l = e.get(L);
          if (c.n === 0 && l.to === undefined && "to" in l) l.to = e.id;
          else if (c.n === 1) l.to = null;
          else if (c.n === 2) world.set(e.id, "Link", { to: undefined });
          c.n += 1;
        },
      });`);
    p.kokostates.push({
      id: "ks_l",
      name: "Link",
      fields: [{ id: "to", name: "to", type: "EntityRef | undefined", default: "e1" }],
    });
    const e1 = p.entities[0];
    if (e1) e1.states.ks_l = { to: undefined };
    sim = await Simulation.create(p, "out", { realm: "r" });
    // 制作データの undefined は、初期値（"e1"）に戻らない
    expect(sim.world.get("e1", "ks_l")).toEqual({ to: undefined });
    sim.step(0.1);
    expect(sim.world.get("e1", "ks_l")?.to).toBe("e1");
    sim.step(0.1);
    expect(sim.world.get("e1", "ks_l")?.to).toBe("e1");
    sim.step(0.1);
    const link = sim.world.get("e1", "ks_l") ?? {};
    expect("to" in link).toBe(true);
    expect(link.to).toBeUndefined();
    // 状態を配っても、undefined の値は欠けない
    const restored = parseValue(stringifyValue(sim.world.snapshot())) as ReturnType<
      typeof sim.world.snapshot
    >;
    expect(restored).toEqual(sim.world.snapshot());
    expect("to" in (restored.entities.find((e) => e.id === "e1")?.states.ks_l ?? {})).toBe(true);
  });

  it("適用：維持を付けたフィールドが undefined でも、その値を引き継ぐ", async () => {
    const p = project(
      `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate() {} });`,
    );
    p.kokostates.push({
      id: "ks_l",
      name: "Link",
      fields: [{ id: "to", name: "to", type: "EntityRef | undefined", default: undefined }],
    });
    const e1 = p.entities[0];
    if (e1) e1.states.ks_l = { to: "e1" };
    const out = p.outputs[0];
    if (out) out.keep = [{ entity: "e1", koko: "ks_l", field: "to" }];
    sim = await Simulation.create(p, "out", { realm: "r" });
    const link = sim.world.get("e1", "ks_l");
    if (link) link.to = undefined;
    expect(sim.applyPart("r", "out", structuredClone(p))).toMatchObject({ kept: 1, dropped: 0 });
    const after = sim.world.get("e1", "ks_l") ?? {};
    expect("to" in after).toBe(true);
    expect(after.to).toBeUndefined();
  });

  describe("TypeScript で書いた型のフィールド（ADR 0065）", () => {
    const owner: ValueSchema = {
      kind: "union",
      options: [{ kind: "ref", target: "entity" }, { kind: "undefined" }],
    };
    const cardOf = (label: ValueSchema): ValueSchema => ({
      kind: "record",
      fields: [
        { name: "label", optional: false, schema: label },
        { name: "owner", optional: false, schema: owner },
      ],
    });
    const card = cardOf({ kind: "string" });
    const schemas: FieldSchemas = { ks_h: { cards: { kind: "list", item: card } } };
    const hand = () => {
      const p = project(`import C from "./Counter.koko";
        import H from "./Hand.koko";
        export default system({
          query: { with: [C, H] },
          onUpdate(e) {
            const c = e.get(C);
            const h = e.get(H);
            if (c.n === 0) h.cards.push({ label: "A", owner: e.id });
            else if (c.n === 1) h.cards.push({ label: 2, owner: undefined });
            else if (c.n === 2) h.drawn = new Date(5);
            else if (c.n === 3) c.n = NaN;
            if (c.n === c.n) c.n += 1;
          },
        });`);
      p.kokostates.push({
        id: "ks_h",
        name: "Hand",
        fields: [
          {
            id: "cards",
            name: "cards",
            type: "{ label: string; owner: EntityRef | undefined }[]",
            default: [],
          },
          { id: "drawn", name: "drawn", type: "Date | undefined", default: undefined },
        ],
      });
      const e1 = p.entities[0];
      if (e1) e1.states.ks_h = { cards: [{ label: "Z", owner: "e1" }], drawn: undefined };
      return p;
    };

    it("レコードのリストと日時を System から読み書きでき、型に合わない書き込みは無視する", async () => {
      sim = await Simulation.create(hand(), "out", { realm: "r", schemas });
      const values = () => sim?.world.get("e1", "ks_h") ?? {};
      sim.step(0.1);
      expect(values().cards).toEqual([
        { label: "Z", owner: "e1" },
        { label: "A", owner: "e1" },
      ]);
      // label が数のカードを足した書き込みは、フィールドごと受け入れない
      sim.step(0.1);
      expect(values().cards).toHaveLength(2);
      sim.step(0.1);
      expect(values().drawn).toEqual(new Date(5));
      // 自作の KokoState の数は、NaN も入る（Built-in の数は、有限の数だけ）
      sim.step(0.1);
      expect(sim.world.get("e1", "ks_c")?.n).toBeNaN();
      expect(sim.systemStatus().every((s) => s.error === null)).toBe(true);
    });

    it("型の定義を変えたあとの値は、型に合わせてから使う（足りないフィールドを埋め、ないものを捨てる）", async () => {
      // カードに joker が足され、owner が消えた型
      const next: ValueSchema = {
        kind: "list",
        item: {
          kind: "record",
          fields: [
            { name: "label", optional: false, schema: { kind: "string" } },
            { name: "joker", optional: false, schema: { kind: "boolean" } },
          ],
        },
      };
      sim = await Simulation.create(hand(), "out", {
        realm: "r",
        schemas: { ks_h: { cards: next } },
      });
      expect(sim.world.get("e1", "ks_h")?.cards).toEqual([{ label: "Z", joker: false }]);
    });

    it("適用：維持を付けた入れ子のフィールドは、まるごと引き継ぐ。型の定義が変わっていたら、新しい型に合わせる", async () => {
      const kept = () => {
        const p = hand();
        const out = p.outputs[0];
        if (out) out.keep = [{ entity: "e1", koko: "ks_h", field: "cards" }];
        return p;
      };
      sim = await Simulation.create(kept(), "out", { realm: "r", schemas });
      const cards = () => sim?.world.get("e1", "ks_h")?.cards;
      sim.step(0.1);
      const before = [
        { label: "Z", owner: "e1" },
        { label: "A", owner: "e1" },
      ];
      expect(cards()).toEqual(before);

      // 型が同じ：実行で足したカードも、中の参照も、そのまま残る
      expect(sim.applyPart("r", "out", kept(), undefined, schemas)).toMatchObject({
        kept: 1,
        dropped: 0,
      });
      expect(cards()).toEqual(before);

      // 型の文は同じで、型の定義にフィールドが足された：足りないフィールドを埋めて引き継ぐ
      const withJoker: ValueSchema = {
        kind: "record",
        fields: [
          { name: "label", optional: false, schema: { kind: "string" } },
          { name: "owner", optional: false, schema: owner },
          { name: "joker", optional: false, schema: { kind: "boolean" } },
        ],
      };
      expect(
        sim.applyPart("r", "out", kept(), undefined, {
          ks_h: { cards: { kind: "list", item: withJoker } },
        }),
      ).toMatchObject({ kept: 1, dropped: 0 });
      expect(cards()).toEqual(before.map((c) => ({ ...c, joker: false })));

      // 型の定義が変わって、合わせても合わない（label が数になった）：引き継がず、制作データの値にする
      const numbered = cardOf({ kind: "number" });
      expect(
        sim.applyPart("r", "out", kept(), undefined, {
          ks_h: { cards: { kind: "list", item: numbered } },
        }),
      ).toMatchObject({ kept: 0, dropped: 1 });
      expect(cards()).toEqual([{ label: "Z", owner: "e1" }]);
    });

    it("スキーマが分からないフィールドは、値の確かめをせずに通す", async () => {
      sim = await Simulation.create(hand(), "out", { realm: "r" });
      sim.step(0.1);
      sim.step(0.1);
      expect(sim.world.get("e1", "ks_h")?.cards).toEqual([
        { label: "Z", owner: "e1" },
        { label: "A", owner: "e1" },
        { label: 2, owner: undefined },
      ]);
    });

    it("セッションでは、入れ子の中の Entity の参照も、その配置の中の ID になる", async () => {
      sim = await Simulation.createSession();
      sim.addPart({
        id: "p1",
        realm: "r",
        outputId: "out",
        snapshot: hand(),
        schemas,
        position: [0, 0, 0],
        yaw: 0,
      });
      const koko = sim.stateIdOf("p1", "ks_h") ?? "";
      expect(sim.world.get("p1/e1", koko)?.cards).toEqual([{ label: "Z", owner: "p1/e1" }]);
      // 適用でスキーマが変わったら、新しいスキーマで確かめる（label は "Z" だけ）
      const onlyZ = cardOf({ kind: "literal", value: "Z" });
      sim.applyPart("r", "out", hand(), undefined, {
        ks_h: { cards: { kind: "list", item: onlyZ } },
      });
      sim.step(0.1);
      // label が "A" のカードを足す書き込みは、新しい型に合わないので入らない
      expect(sim.world.get("p1/e1", sim.stateIdOf("p1", "ks_h") ?? "")?.cards).toEqual([
        { label: "Z", owner: "p1/e1" },
      ]);
    });
  });

  describe("参照から読み書きする（ADR 0065）", () => {
    const gauge = () => {
      const p = project(`import G from "./Gauge.koko";
        export default system({
          query: { with: [G] },
          onUpdate(e) {
            const g = e.get(G);
            const hp = world.getField(g.hp);
            const state = world.getState(g.owner);
            if (hp === 0) {
              g.seen = [hp, state && state.n, world.getField(g.gone), world.getState(g.none)].join("/");
              g.ok = [
                world.setField(g.hp, hp + 1),
                world.setField(g.hp, "x"),
                world.setField(g.gone, 1),
              ].join();
            } else if (hp === 1) {
              world.setState(g.owner, { n: 100, nope: 1 });
            }
          },
        });`);
      p.kokostates.push({
        id: "ks_g",
        name: "Gauge",
        fields: [
          { id: "hp", name: "hp", type: "FieldRef<number>", default: undefined },
          { id: "owner", name: "owner", type: "KokoStateRef<Counter>", default: undefined },
          { id: "gone", name: "gone", type: "FieldRef", default: undefined },
          { id: "none", name: "none", type: "KokoStateRef", default: undefined },
          { id: "seen", name: "seen", type: "string", default: "" },
          { id: "ok", name: "ok", type: "string", default: "" },
        ],
      });
      p.entities.push({
        id: "e2",
        name: "ゲージ",
        parent: null,
        output: "out",
        order: 1,
        states: {
          ks_g: {
            hp: { entity: "e1", koko: "ks_c", field: "n" },
            owner: { entity: "e1", koko: "ks_c" },
            // フィールドがない・KokoState を持っていない
            gone: { entity: "e1", koko: "ks_c", field: "missing" },
            none: { entity: "e2", koko: "ks_c" },
          },
        },
      });
      return p;
    };
    const schemas: FieldSchemas = {
      ks_g: {
        hp: { kind: "fieldRef", value: { kind: "number" } },
        owner: { kind: "kokoRef", koko: "ks_c" },
        gone: { kind: "fieldRef" },
        none: { kind: "kokoRef" },
      },
    };

    it("フィールドの参照と KokoState の参照の先を読み書きする。指す先がなければ undefined・false", async () => {
      sim = await Simulation.create(gauge(), "out", { realm: "r", schemas });
      sim.step(0.1);
      expect(sim.world.get("e2", "ks_g")).toMatchObject({ seen: "0/0//", ok: "true,false,false" });
      expect(sim.world.get("e1", "ks_c")?.n).toBe(1);
      sim.step(0.1);
      expect(sim.world.get("e1", "ks_c")).toEqual({ n: 100 });
      expect(sim.systemStatus().every((s) => s.error === null)).toBe(true);
    });

    it("セッションでも、その配置の中の Entity を指す", async () => {
      sim = await Simulation.createSession();
      const part = { realm: "r", outputId: "out", snapshot: gauge(), schemas, yaw: 0 };
      sim.addPart({ ...part, id: "p1", position: [0, 0, 0] });
      sim.addPart({ ...part, id: "p2", position: [5, 0, 0] });
      const counter = sim.stateIdOf("p1", "ks_c") ?? "";
      expect(sim.world.get("p1/e2", sim.stateIdOf("p1", "ks_g") ?? "")?.hp).toEqual({
        entity: "p1/e1",
        koko: "ks_c",
        field: "n",
      });
      sim.step(0.1);
      sim.step(0.1);
      // それぞれの配置のゲージが、自分の配置のカウンターだけを書く
      expect(sim.world.get("p1/e1", counter)?.n).toBe(100);
      expect(sim.world.get("p2/e1", counter)?.n).toBe(100);
      expect(sim.systemStatus().every((s) => s.error === null)).toBe(true);
    });
  });

  it("spawn / destroy / find / get / set が使える", async () => {
    sim = await Simulation.create(
      project(`import C from "./Counter.koko";
      export default system({
        query: { with: [C] },
        onUpdate(e) {
          if (e.get(C).n === 0) {
            const id = world.spawn({ name: "child", states: { Counter: { n: 41 } } });
            world.set(id, "Counter", { n: world.get(id, "Counter").n + 1 });
          } else if (e.get(C).n === 1) {
            world.destroy(world.find("child"));
          }
          e.get(C).n += 1;
        },
      });`),
      "out",
      { realm: "r" },
    );
    sim.step(0.1);
    const child = sim.world.entityIds().find((id) => id.startsWith("rt:"));
    expect(child && sim.world.parentOf(child)).toBe("__root");
    expect(child && sim.world.get(child, "ks_c")?.n).toBe(42);
    sim.step(0.1);
    expect(sim.world.entityIds()).toEqual(["__root", "e1"]);
  });

  it("動く剛体は重力で落ち、床にぶつかると onCollision が呼ばれる", async () => {
    const p = project(
      `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onCollision(e, ev) { if (ev.started) e.get(C).n += 1; } });`,
    );
    p.entities = [
      {
        id: "ball",
        name: "ball",
        parent: null,
        output: "out",
        order: 0,
        states: {
          ks_c: { n: 0 },
          [BUILTIN.Transform]: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: "sphere",
            size: [0.5, 0.5, 0.5],
            material: undefined,
            color: "#ffffff",
          },
          [BUILTIN.Collider]: { sensor: false },
          [BUILTIN.RigidBody]: { type: "dynamic", linvel: [0, 0, 0] },
        },
      },
      {
        id: "floor",
        name: "floor",
        parent: null,
        output: "out",
        order: 1,
        states: {
          [BUILTIN.Transform]: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [10, 0.2, 10],
            material: undefined,
            color: "#ffffff",
          },
          [BUILTIN.Collider]: { sensor: false },
        },
      },
    ];
    sim = await Simulation.create(p, "out", { realm: "r" });
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    const pos = sim.world.get("ball", BUILTIN.Transform)?.position as Vec3 | undefined;
    const y = pos?.[1] ?? Number.NaN;
    expect(y).toBeLessThan(0.5);
    expect(y).toBeGreaterThan(0.2);
    expect(sim.world.get("ball", "ks_c")?.n).toBeGreaterThanOrEqual(1);
  });
});

describe("Simulation：右クリックで持つ（Grabbable）", () => {
  const box = (rotation: Vec3 = [0, 0, 0], rigid = true) => {
    const p = project(
      `import C from "./Counter.koko"; export default system({ query: { with: [C] }, onUpdate() {} });`,
    );
    p.entities.push({
      id: "box",
      name: "箱",
      parent: null,
      output: "out",
      order: 1,
      states: {
        [BUILTIN.Transform]: { position: [0, 1.5, -3], rotation, scale: [1, 1, 1] },
        [BUILTIN.Mesh]: { shape: "box", size: [0.5, 0.5, 0.5] },
        [BUILTIN.Collider]: {},
        ...(rigid ? { [BUILTIN.RigidBody]: { type: "dynamic" } } : {}),
        [BUILTIN.Grabbable]: { distance: 1 },
      },
    });
    return p;
  };

  it("持った瞬間は位置も角度も変えず、すぐ離せば同じ場所にある", async () => {
    sim = await Simulation.create(box([10, 20, 30], false), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    const held = sim.world.get("box", BUILTIN.Grabbable);
    expect(held?.player).toBe("p1");
    const pos = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    const rot = sim.world.get("box", BUILTIN.Transform)?.rotation as Vec3;
    expect(pos[0]).toBeCloseTo(0, 5);
    expect(pos[1]).toBeCloseTo(1.5, 5);
    expect(pos[2]).toBeCloseTo(-3, 5);
    expect(rot[0]).toBeCloseTo(10, 4);
    expect(rot[1]).toBeCloseTo(20, 4);
    expect(rot[2]).toBeCloseTo(30, 4);
    // 同じ視点のまま追従しても、場所は変わらない
    inputWithTools(sim, fire([0, 0, -1], "hold"));
    sim.step(1 / 60);
    const still = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(still[2]).toBeCloseTo(-3, 4);
    // 押したままもう一度 down が来ても、離すまでは持ったまま
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).not.toBe("");
    inputWithTools(sim, { ...fire([0, 0, -1], "grab"), phase: "up" });
    sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("");
    const after = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(after[0]).toBeCloseTo(0, 4);
    expect(after[1]).toBeCloseTo(1.5, 4);
    expect(after[2]).toBeCloseTo(-3, 4);
    // 向きを変えてから離すと、見えていた位置に残る（追従の送信を待たない）
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    inputWithTools(sim, { ...fire([1, 0, 0], "grab"), phase: "up" });
    sim.step(1 / 60);
    const left = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("");
    expect(left[0]).toBeCloseTo(3, 1);
    expect(left[1]).toBeCloseTo(1.5, 1);
    expect(left[2]).toBeCloseTo(0, 1);
  });

  it("持っている間は視点との位置関係を保ち、落ちない。ほかの人は取れない", async () => {
    sim = await Simulation.create(box(), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    // 右を向くと、持ったときの「3m 手前」が右へ移る
    inputWithTools(sim, fire([1, 0, 0], "hold"));
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
    const pos = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(pos[0]).toBeCloseTo(3, 1);
    expect(pos[1]).toBeCloseTo(1.5, 1);
    expect(pos[2]).toBeCloseTo(0, 1);
    inputWithTools(sim, { ...fire([1, 0, 0], "grab"), player: "p2" });
    sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("p1");
    inputWithTools(sim, { ...fire([1, 0, 0], "grab"), phase: "up" });
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("");
    const dropped = sim.world.get("box", BUILTIN.Transform)?.position as Vec3 | undefined;
    expect(dropped?.[1]).toBeLessThan(1.4);
  });

  it("ホイールで前後に動かし、画面上の位置は保つ", async () => {
    sim = await Simulation.create(box([0, 0, 0], false), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    inputWithTools(sim, { ...fire([0, 0, -1], "reach"), pointer: [1, 0] });
    sim.step(1 / 60);
    const far = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(far[0]).toBeCloseTo(0, 2);
    expect(far[1]).toBeCloseTo(1.5, 2);
    expect(far[2]).toBeCloseTo(-4, 2);
    inputWithTools(sim, { ...fire([0, 0, -1], "reach"), pointer: [-1, 0] });
    sim.step(1 / 60);
    const back = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(back[2]).toBeCloseTo(-3, 2);
  });

  it("左クリックで傾きを直し、E の動きで角度が変わる", async () => {
    sim = await Simulation.create(box([30, 40, 25], false), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "align"));
    sim.step(1 / 60);
    const upright = sim.world.get("box", BUILTIN.Transform)?.rotation as Vec3;
    expect(upright[0]).toBeCloseTo(0, 4);
    expect(upright[2]).toBeCloseTo(0, 4);
    expect(Math.abs(upright[1])).toBeGreaterThan(1);
    const y = upright[1];
    inputWithTools(sim, { ...fire([0, 0, -1], "twist"), pointer: [Math.PI / 2, 0] });
    sim.step(1 / 60);
    const turned = sim.world.get("box", BUILTIN.Transform)?.rotation as Vec3;
    expect(turned[1]).not.toBeCloseTo(y, 0);
    const pos = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(pos[2]).toBeCloseTo(-3, 4);
  });
});

describe("Simulation：import で書いた System（ADR 0010）", () => {
  /** Gun を States フォルダに、Shoot を Systems フォルダに入れ、Shoot を import で書き直す */
  function importSample(code: string): ProjectSnapshot {
    const snap = gunAndTargetSample();
    snap.folders = [
      { id: "f_states", name: "States", parent: null },
      { id: "f_sys", name: "Systems", parent: null },
    ];
    const gun = snap.kokostates.find((k) => k.name === "Gun");
    if (!gun) throw new Error("Gun がありません");
    snap.placement = { [gun.id]: "f_states", sys_shoot: "f_sys" };
    snap.systems = snap.systems.map((s) => (s.id === "sys_shoot" ? { ...s, code } : s));
    return snap;
  }

  it("import した KokoState で Query を書き、entity.get で値を読み書きできる", async () => {
    sim = await Simulation.create(
      importSample(`import Gun from "../States/Gun.koko";
import Transform from "@builtin/Transform.koko";
export default system({
  query: { with: [Gun, Transform] },
  onInput(e, ev) {
    if (ev.action !== "fire" || ev.phase !== "down") return;
    const gun = e.get(Gun);
    gun.ammo -= 1;
    const t = world.get(e.id, Transform);
    log("pos", t.position.length);
  },
});`),
      "out_range",
      { realm: "repo1" },
    );
    expect(sim.systemStatus().find((s) => s.id === "sys_shoot")).toMatchObject({ error: null });
    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
  });

  it("見つからない import は、その行の読み込みエラーにする", async () => {
    sim = await Simulation.create(
      importSample(`export default system({});\nimport Gun from "./Gun.koko";`),
      "out_range",
      { realm: "repo1" },
    );
    expect(sim.systemStatus().find((s) => s.id === "sys_shoot")).toMatchObject({
      error: "KokoState「./Gun.koko」が見つかりません",
      line: 2,
    });
  });
});

describe("Simulation：同じ名前の KokoState を別名で使う（ADR 0010 Phase 5）", () => {
  it("別のフォルダの同じ名前の KokoState を、import の別名で区別して読み書きできる", async () => {
    const snap = emptyProject("p");
    snap.kokostates = [
      {
        id: "ks_pg",
        name: "Gun",
        fields: [{ id: "f_a", name: "ammo", type: "number", default: 5 }],
      },
      {
        id: "ks_eg",
        name: "Gun",
        fields: [{ id: "f_a", name: "ammo", type: "number", default: 9 }],
      },
    ];
    snap.folders = [
      { id: "f_player", name: "Player", parent: null },
      { id: "f_enemy", name: "Enemy", parent: null },
    ];
    snap.placement = { ks_pg: "f_player", ks_eg: "f_enemy" };
    snap.entities = [
      {
        id: "e",
        name: "e",
        parent: null,
        output: "out_main",
        order: 0,
        states: { ks_pg: { f_a: 5 }, ks_eg: { f_a: 9 } },
      },
    ];
    snap.systems = [
      {
        id: "sys",
        name: "Both",
        code: `import PlayerGun from "/Player/Gun.koko";
import EnemyGun from "/Enemy/Gun.koko";
export default system({
  query: { with: [PlayerGun, EnemyGun] },
  onUpdate(e) {
    e.get(PlayerGun).ammo -= 1;
    e.get(EnemyGun).ammo += 1;
    log("legacy", typeof e.Gun);
  },
});`,
      },
    ];
    snap.outputs = snap.outputs.map((o) => ({ ...o, systems: [{ id: "sys", enabled: true }] }));
    const logs: LogEntry[] = [];
    sim = await Simulation.create(snap, "out_main", { realm: "r", onLog: (l) => logs.push(l) });
    expect(sim.systemStatus()[0]).toMatchObject({ error: null });
    sim.step(1 / 60);
    expect(sim.world.get("e", "ks_pg")?.f_a).toBe(4);
    expect(sim.world.get("e", "ks_eg")?.f_a).toBe(10);
    // 名前が一つに決まらないので、名前での入口（e.Gun）はない
    expect(logs.map((l) => l.message)).toContain("legacy undefined");
  });
});

describe("Simulation：Transform は初期値からのずれ", () => {
  const bare = () => {
    const snap = emptyProject("bare");
    snap.entities = [
      {
        id: "root",
        name: "根",
        parent: null,
        output: "out_main",
        order: 0,
        states: { [BUILTIN.Mesh]: { shape: "box" } },
      },
      {
        id: "child",
        name: "子",
        parent: "root",
        output: "out_main",
        order: 1,
        states: { [BUILTIN.Mesh]: { shape: "sphere" } },
      },
    ];
    return snap;
  };

  it("再生の位置が初期値なら、中の Transform は付かない", async () => {
    sim = await Simulation.create(bare(), "out_main", { realm: "r" });
    expect(sim.world.parentOf("root")).toBe("__root");
    expect(sim.world.parentOf("child")).toBe("root");
    expect(sim.world.hasState("root", BUILTIN.Transform)).toBe(false);
    expect(sim.world.hasState("child", BUILTIN.Transform)).toBe(false);
    // 動作上の親は、ずれが無くても姿勢を持つ（あとからワークスペースを動かすため）
    expect(sim.world.get("__root", BUILTIN.Transform)?.position).toEqual([0, 0, 0]);
    expect(sim.world.get("__root", BUILTIN.Transform)?.rotation).toEqual([0, 0, 0]);
  });

  it("配置の位置は動作上の親に残り、中のローカル座標は変わらない", async () => {
    const withDefault = bare();
    const root = withDefault.entities[0];
    if (!root) throw new Error("root がない");
    root.states = {
      ...root.states,
      [BUILTIN.Transform]: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    sim = await Simulation.createSession();
    sim.addPart({
      id: "a",
      realm: "r",
      outputId: "out_main",
      snapshot: bare(),
      position: [3, 1, -2],
      yaw: 0,
    });
    sim.addPart({
      id: "b",
      realm: "r",
      outputId: "out_main",
      snapshot: withDefault,
      position: [3, 1, -2],
      yaw: Math.PI / 2,
    });
    expect(sim.world.parentOf("a/root")).toBe("a/__root");
    expect(sim.world.get("a/__root", BUILTIN.Transform)?.position).toEqual([3, 1, -2]);
    expect(sim.world.hasState("a/root", BUILTIN.Transform)).toBe(false);
    expect(sim.world.hasState("a/child", BUILTIN.Transform)).toBe(false);
    // 中に位置があっても、配置の位置は足さず、親からのずれのまま
    expect(sim.world.get("b/root", BUILTIN.Transform)?.position).toEqual([1, 0, 0]);
    expect(sim.world.get("b/__root", BUILTIN.Transform)?.rotation).toEqual([0, 90, 0]);
    const seen = worldTransform(sim.world, "b/root").position.toArray();
    expect(seen[0]).toBeCloseTo(3);
    expect(seen[1]).toBeCloseTo(1);
    expect(seen[2]).toBeCloseTo(-3);
  });
});

describe("Simulation：装備（EquipmentTool。ADR 0053）", () => {
  /** 再生を始めた位置（+Z 側 6m、目の高さ）から、置いてある銃を見る */
  const lookAtGun = (player: string, action = "equip") => {
    const origin: Vec3 = [0, 1.6, 6];
    const to: Vec3 = [0, 1.1, 3.6];
    const d = to.map((v, i) => v - (origin[i] ?? 0));
    const len = Math.hypot(...d);
    return {
      action,
      phase: "down" as const,
      origin,
      direction: d.map((v) => v / len) as Vec3,
      player,
    };
  };

  it("見ている道具を右手に装備し（リングメニューの「装備する」）、装備した人の入力だけが道具に届く", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "r" });
    const ammo = () => sim?.world.get("ent_gun", "ks_gun")?.f_ammo;
    // 装備する前は、誰が撃っても銃は動かない
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(ammo()).toBe(12);

    sim.input(lookAtGun("p1"));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", BUILTIN.EquipmentTool)?.player).toBe("p1");
    // 右手（視点からの位置）へ動く
    const at = sim.world.get("ent_gun", BUILTIN.Transform)?.position as Vec3;
    expect(at[2]).toBeGreaterThan(5);

    // ほかの人の fire は届かず、装備した人の fire は届く
    sim.input({ ...fire([0, 0, -1]), player: "p2" });
    sim.step(1 / 60);
    expect(ammo()).toBe(12);
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(ammo()).toBe(11);

    // ほかの人は、装備されている道具を拾えない
    sim.input(lookAtGun("p2"));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", BUILTIN.EquipmentTool)?.player).toBe("p1");
  });

  it("外すとその場に落とす（置いた位置のまま、誰も装備していない）", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "r" });
    sim.input(lookAtGun("p1"));
    sim.step(1 / 60);
    const inHand = [...((sim.world.get("ent_gun", BUILTIN.Transform)?.position as Vec3) ?? [])];
    sim.input({ ...lookAtGun("p1"), action: "unequip" });
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", BUILTIN.EquipmentTool)?.player).toBe("");
    expect(sim.world.get("ent_gun", BUILTIN.Transform)?.position).toEqual(inHand);
    // 落とした後は、ほかの人が拾える
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(12);
  });

  it("配置してある道具を装備しても、見た目の位置は視点のそばに残る", async () => {
    sim = await Simulation.createSession();
    sim.addPart({
      id: "g",
      realm: "range",
      outputId: "out_range",
      snapshot: gunAndTargetSample(),
      position: [4, 0, 0],
      yaw: 0,
    });
    const origin: Vec3 = [4, 1.6, 6];
    const to: Vec3 = [4, 1.1, 3.6];
    const d = to.map((v, i) => v - (origin[i] ?? 0));
    const len = Math.hypot(...d);
    sim.input({
      action: "equip",
      phase: "down",
      origin,
      direction: d.map((v) => v / len) as Vec3,
      player: "p1",
    });
    sim.step(1 / 60);
    expect(sim.world.get("g/ent_gun", BUILTIN.EquipmentTool)?.player).toBe("p1");
    const seen = worldTransform(sim.world, "g/ent_gun").position.toArray();
    expect(seen[0]).toBeCloseTo(4, 0);
    expect(seen[2]).toBeGreaterThan(5);
    const local = sim.world.get("g/ent_gun", BUILTIN.Transform)?.position as Vec3;
    expect(local[0]).toBeCloseTo(seen[0] - 4, 4);
  });
});

describe("Simulation：E（use）では装備しない（ADR 0053）", () => {
  it("E で見ても道具は拾わない（装備は左クリックのリングメニューから）", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "r" });
    sim.input({
      action: "use",
      phase: "down",
      origin: [0, 1.6, 6],
      direction: [0, -0.2, -0.98],
      player: "p1",
    });
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", BUILTIN.EquipmentTool)?.player).toBe("");
  });
});

describe("Simulation：親のある動く剛体", () => {
  // 親（剛体なし）の下に、床と、その上に落ちる箱。配置の位置・向きをずらしてセッションに出す
  const crate = () => {
    const snap = emptyProject("crate");
    snap.entities = [
      { id: "root", name: "根", parent: null, output: "out_main", order: 0, states: {} },
      {
        id: "floor",
        name: "床",
        parent: "root",
        output: "out_main",
        order: 1,
        states: {
          [BUILTIN.Mesh]: { shape: "box", size: [6, 0.2, 6] },
          [BUILTIN.Collider]: {},
        },
      },
      {
        id: "box",
        name: "箱",
        parent: "root",
        output: "out_main",
        order: 2,
        states: {
          [BUILTIN.Transform]: { position: [1, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: { shape: "box", size: [0.5, 0.5, 0.5] },
          [BUILTIN.Collider]: {},
          [BUILTIN.RigidBody]: { type: "dynamic", linvel: [0, 0, 0] },
        },
      },
    ];
    return snap;
  };

  it("配置の位置・向きをずらしても、親から見た位置のまま床に落ちる", async () => {
    sim = await Simulation.createSession();
    sim.addPart({
      id: "a",
      realm: "r",
      outputId: "out_main",
      snapshot: crate(),
      position: [10, 0, -5],
      yaw: Math.PI / 2,
    });
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    expect(sim.world.parentOf("a/box")).toBe("a/root");
    // 親から見た位置：横はそのまま、高さは床（厚さ 0.2）の上に箱（0.5）が乗る所
    const local = sim.world.get("a/box", BUILTIN.Transform)?.position as Vec3;
    expect(local[0]).toBeCloseTo(1, 2);
    expect(local[1]).toBeCloseTo(0.35, 1);
    expect(local[2]).toBeCloseTo(0, 2);
    // ワールドでは、配置の位置に、向きを足した位置（+X が -Z に回る）
    const w = worldTransform(sim.world, "a/box").position;
    expect(w.x).toBeCloseTo(10, 2);
    expect(w.z).toBeCloseTo(-6, 2);
  });
});

describe("Simulation：物理の地面と Collider（ADR 0068）", () => {
  const ball = (
    rigid: Record<string, unknown> = {},
    collider: Record<string, unknown> = {},
    mesh: { shape?: string; size?: Vec3 } = {},
    y = 4,
  ) => {
    const p = emptyProject("phys");
    p.entities = [
      {
        id: "ball",
        name: "球",
        parent: null,
        output: "out_main",
        order: 0,
        states: {
          [BUILTIN.Transform]: { position: [0, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: mesh.shape ?? "sphere",
            size: mesh.size ?? [0.5, 0.5, 0.5],
            material: undefined,
            color: "#ffffff",
          },
          [BUILTIN.Collider]: { sensor: false, ...collider },
          [BUILTIN.RigidBody]: { type: "dynamic", linvel: [0, 0, 0], ...rigid },
        },
      },
    ];
    return p;
  };

  async function yAfter(p: ProjectSnapshot, frames = 240): Promise<number> {
    sim = await Simulation.create(p, "out_main", { realm: "r" });
    for (let i = 0; i < frames; i++) sim.step(1 / 60);
    return ((sim.world.get("ball", BUILTIN.Transform)?.position as Vec3 | undefined)?.[1] ??
      Number.NaN) as number;
  }

  it("床の Entity が無くても、高さ 0 の地面で落ち止まる", async () => {
    const y = await yAfter(ball());
    expect(y).toBeGreaterThan(0.15);
    expect(y).toBeLessThan(0.45);
    if (!sim) throw new Error("準備ができていません");
    const height = (): number =>
      ((sim?.world.get("ball", BUILTIN.Transform)?.position as Vec3 | undefined)?.[1] ??
        Number.NaN) as number;
    const again = height();
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(Math.abs(height() - again)).toBeLessThan(0.05);
  });

  it("高い所から落としても地面を抜けない", async () => {
    const y = await yAfter(ball({}, {}, {}, 25), 300);
    expect(y).toBeGreaterThan(0.15);
    expect(y).toBeLessThan(0.5);
  });

  it("平面の床の上で止まり、sensor の床は支えにならない", async () => {
    const deck = ball();
    deck.entities.push({
      id: "deck",
      name: "床",
      parent: null,
      output: "out_main",
      order: 1,
      states: {
        [BUILTIN.Transform]: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        [BUILTIN.Mesh]: { shape: "plane", size: [6, 1, 6], material: undefined, color: "#ffffff" },
        [BUILTIN.Collider]: { sensor: false },
      },
    });
    const onDeck = await yAfter(deck);
    expect(onDeck).toBeGreaterThan(1.1);
    expect(onDeck).toBeLessThan(1.45);

    const sensor = ball({}, {}, {}, 3);
    sensor.entities.push({
      id: "ghost",
      name: "感応",
      parent: null,
      output: "out_main",
      order: 1,
      states: {
        [BUILTIN.Transform]: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        [BUILTIN.Mesh]: { shape: "box", size: [4, 0.2, 4], material: undefined, color: "#ffffff" },
        [BUILTIN.Collider]: { sensor: true },
      },
    });
    const through = await yAfter(sensor);
    expect(through).toBeGreaterThan(0.15);
    expect(through).toBeLessThan(0.45);
  });

  it("Collider の形と大きさは Mesh と別にできる。重力 0 では落ちない", async () => {
    const y = await yAfter(
      ball({}, { shape: "box", size: [1, 2, 1] }, { shape: "sphere", size: [0.2, 0.2, 0.2] }),
    );
    expect(y).toBeGreaterThan(0.85);
    expect(y).toBeLessThan(1.2);

    const hover = await yAfter(ball({ gravityScale: 0 }, {}, {}, 3), 120);
    expect(hover).toBeCloseTo(3, 1);
  });

  it("スクリプトが書いた速度が、次の計算で剛体に効く", async () => {
    const p = project(
      `import RigidBody from "@builtin/RigidBody.koko";
      export default system({
        query: { with: [RigidBody] },
        onUpdate(e) {
          const rb = e.get(RigidBody);
          if (rb.linvel[0] < 1) rb.linvel = [3, rb.linvel[1], rb.linvel[2]];
        },
      });`,
    );
    p.entities.push({
      id: "ball",
      name: "球",
      parent: null,
      output: "out",
      order: 1,
      states: {
        [BUILTIN.Transform]: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        [BUILTIN.Mesh]: {
          shape: "sphere",
          size: [0.4, 0.4, 0.4],
          material: undefined,
          color: "#fff",
        },
        [BUILTIN.Collider]: {},
        [BUILTIN.RigidBody]: { type: "dynamic", linvel: [0, 0, 0] },
      },
    });
    sim = await Simulation.create(p, "out", { realm: "r" });
    for (let i = 0; i < 90; i++) sim.step(1 / 60);
    const pos = sim.world.get("ball", BUILTIN.Transform)?.position as Vec3;
    expect(pos[0]).toBeGreaterThan(1);
    expect(pos[1]).toBeGreaterThan(0);
  });

  describe("軸の固定（ADR 0078）", () => {
    /** 球の下に、Z の向きへ下る坂を置く。固定しなければ、球は Z へ転がる */
    const onSlope = (rigid: Record<string, unknown>) => {
      const p = ball(rigid, {}, {}, 3);
      p.entities.push({
        id: "slope",
        name: "坂",
        parent: null,
        output: "out_main",
        order: 1,
        states: {
          [BUILTIN.Transform]: { position: [0, 1, 0], rotation: [30, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: { shape: "box", size: [6, 0.2, 6], material: undefined, color: "#fff" },
          [BUILTIN.Collider]: { sensor: false },
        },
      });
      return p;
    };

    interface Result {
      pos: Vec3;
      rot: Vec3;
      linvel: Vec3;
      angvel: Vec3;
    }

    /** いまの球の位置・角度・速度 */
    function read(s: Simulation, id = "ball"): Result {
      const t = s.world.get(id, BUILTIN.Transform);
      const rb = s.world.get(id, BUILTIN.RigidBody);
      if (!t || !rb) throw new Error(`${id} がありません`);
      return {
        pos: t.position as Vec3,
        rot: t.rotation as Vec3,
        linvel: rb.linvel as Vec3,
        angvel: rb.angvel as Vec3,
      };
    }

    async function run(p: ProjectSnapshot, frames = 240, output = "out_main"): Promise<Result> {
      const s = await Simulation.create(p, output, { realm: "r" });
      sim = s;
      for (let i = 0; i < frames; i++) s.step(1 / 60);
      return read(s);
    }

    it("固定しなければ坂を Z へ転がり、lockMoveZ なら押されても Z は動かない", async () => {
      const free = await run(onSlope({}));
      expect(Math.abs(free.pos[2])).toBeGreaterThan(0.5);

      const locked = await run(onSlope({ lockMoveZ: true }));
      expect(locked.pos[2]).toBe(0);
      expect(locked.pos[0]).toBeCloseTo(0, 3);
      // 坂に押され続けても暴れず、坂の上で止まる
      expect(locked.pos[1]).toBeGreaterThan(1);
      expect(locked.pos[1]).toBeLessThan(1.8);
      expect(locked.linvel[2]).toBe(0);
      expect(Math.hypot(...locked.linvel)).toBeLessThan(0.05);
    });

    it("lockMoveY なら重力でも落ちず、ほかの軸へは動く", async () => {
      const { pos } = await run(ball({ lockMoveY: true, linvel: [1, 0, 0], linearDamping: 0 }), 60);
      expect(pos[1]).toBe(4);
      expect(pos[0]).toBeCloseTo(1, 1);
    });

    it("固定した軸へは、スクリプトが書いた速度でも動かない", async () => {
      const p = project(
        `import RigidBody from "@builtin/RigidBody.koko";
        export default system({
          query: { with: [RigidBody] },
          onUpdate(e) {
            e.get(RigidBody).linvel = [2, 0, 5];
          },
        });`,
      );
      const [source] = ball({ lockMoveZ: true, gravityScale: 0 }, {}, {}, 3).entities;
      if (!source) throw new Error("球がありません");
      p.entities.push({ ...source, output: "out", order: 1 });
      // 物理のあとに System が動くので、読める速度は書いた値のまま。位置だけを見る
      const { pos } = await run(p, 60, "out");
      expect(pos[2]).toBe(0);
      expect(pos[0]).toBeGreaterThan(1);
    });

    it("lockRotate を 3 つとも付けると、転がっても向きが変わらない", async () => {
      const rolling = { linvel: [3, 0, 0] as Vec3 };
      const sphere = { shape: "sphere", size: [0.5, 0.5, 0.5] as Vec3 };
      const free = await run(ball(rolling, { friction: 1 }, sphere, 0.25), 60);
      expect(Math.hypot(...free.rot)).toBeGreaterThan(5);

      const locked = await run(
        ball(
          { ...rolling, lockRotateX: true, lockRotateY: true, lockRotateZ: true },
          { friction: 1 },
          sphere,
          0.25,
        ),
        60,
      );
      expect(Math.hypot(...locked.rot)).toBeCloseTo(0, 6);
      expect(locked.angvel).toEqual([0, 0, 0]);
    });

    it("回転は軸ごとに止められる（Z まわりだけ回る）", async () => {
      const { rot } = await run(
        ball(
          {
            gravityScale: 0,
            angularDamping: 0,
            angvel: [2, 2, 2],
            lockRotateX: true,
            lockRotateY: true,
          },
          {},
          {},
          3,
        ),
        30,
      );
      expect(rot[0]).toBeCloseTo(0, 4);
      expect(rot[1]).toBeCloseTo(0, 4);
      expect(Math.abs(rot[2])).toBeGreaterThan(30);
    });

    it("dynamic でなければ効かない：kinematic は Transform に付いて動く", async () => {
      const p = ball();
      p.entities.push({
        id: "deck",
        name: "台",
        parent: null,
        output: "out_main",
        order: 1,
        states: {
          [BUILTIN.Transform]: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: { shape: "box", size: [4, 0.2, 4], material: undefined, color: "#fff" },
          [BUILTIN.Collider]: { sensor: false },
          [BUILTIN.RigidBody]: {
            type: "kinematic",
            lockMoveX: true,
            lockMoveY: true,
            lockMoveZ: true,
          },
        },
      });
      const s = await Simulation.create(p, "out_main", { realm: "r" });
      sim = s;
      s.step(1 / 60);
      const deck = s.world.get("deck", BUILTIN.Transform);
      if (!deck) throw new Error("台がありません");
      deck.position = [0, 2, 0];
      for (let i = 0; i < 240; i++) s.step(1 / 60);
      const y = read(s).pos[1];
      expect(y).toBeGreaterThan(2.2);
      expect(y).toBeLessThan(2.5);
    });
  });
});
