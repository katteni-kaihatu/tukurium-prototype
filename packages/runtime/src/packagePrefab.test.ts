import {
  emptyProject,
  type PackageDependency,
  type PackageResolution,
  type ProjectSnapshot,
  packageEntityId,
  packageManifest,
  packageResourceId,
  withPackagePrefabs,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { Simulation } from "./simulation";

const dep: PackageDependency = {
  alias: "parts",
  packageId: "w_parts",
  version: 1,
  contentHash: "h1",
};
const library: ProjectSnapshot = {
  ...emptyProject("部品"),
  kokostates: [
    {
      id: "ks_counter",
      name: "Counter",
      fields: [
        { id: "n", name: "n", type: "number", default: 0 },
        { id: "links", name: "links", type: "EntityRef[]", default: [] },
      ],
    },
  ],
  systems: [
    {
      id: "sys_step",
      name: "Step",
      code: 'import Counter from "./Counter.koko";\nexport default system({ query: { with: [Counter] }, onUpdate(e) { e.get(Counter).n += 1; } });',
    },
  ],
  prefabs: [
    {
      id: "pf_target",
      name: "的",
      root: "ent_root",
      systems: [{ id: "sys_step", enabled: true }],
      keep: [],
    },
  ],
  prefabEntities: [
    {
      id: "ent_root",
      prefab: "pf_target",
      name: "的",
      parent: null,
      order: 0,
      states: { ks_counter: { n: 2, links: ["ent_root"] } },
    },
  ],
  outputs: [
    {
      id: "out_lib",
      name: "部品",
      kind: "library",
      resources: ["pf_target"],
      systems: [],
      keep: [],
    },
  ],
};
const ready = (dependency = dep): PackageResolution => ({
  status: "ready",
  dependency,
  manifest: packageManifest(library, "out_lib", {
    ks_counter: { links: { kind: "list", item: { kind: "ref", target: "entity" } } },
  }),
});
const scene = (): ProjectSnapshot => ({
  ...emptyProject("作品"),
  dependencies: [dep],
  entities: [0, 1, 2].map((i) => ({
    id: `ent_${i}`,
    name: "的",
    output: "out_main",
    parent: null,
    order: i,
    states: {},
    instanceOf: { prefab: packageResourceId(dep, "pf_target") },
  })),
});
let sim: Simulation | undefined;
afterEach(() => sim?.dispose());

describe("ライブラリのプレハブを再生する", () => {
  it("3 個のインスタンスを、同じ版の System で動かす", async () => {
    sim = await Simulation.create(scene(), "out_main", { realm: "workspace", packages: [ready()] });
    expect(sim.systemStatus()).toHaveLength(1);
    expect(sim.systemStatus()[0]?.error).toBeNull();
    sim.step(1 / 60);
    for (const i of [0, 1, 2])
      expect(sim.world.get(`ent_${i}`, packageResourceId(dep, "ks_counter"))?.n).toBe(3);
  });

  it("依存先のプレハブにある System も、その依存先の版で動く", async () => {
    const wrapper: PackageDependency = {
      alias: "wrapper",
      packageId: "w_wrapper",
      version: 4,
      contentHash: "h4",
    };
    const source: ProjectSnapshot = {
      ...emptyProject("外側"),
      dependencies: [dep],
      outputs: [
        {
          id: "out_lib",
          name: "外側",
          kind: "library",
          resources: ["pf_outer"],
          systems: [],
          keep: [],
        },
      ],
      prefabs: [{ id: "pf_outer", name: "外側", root: "ent_outer", systems: [], keep: [] }],
      prefabEntities: [
        { id: "ent_outer", prefab: "pf_outer", name: "外側", parent: null, order: 0, states: {} },
        {
          id: "ent_inner",
          prefab: "pf_outer",
          name: "内側",
          parent: "ent_outer",
          order: 0,
          states: {},
          instanceOf: { prefab: packageResourceId(dep, "pf_target") },
        },
      ],
    };
    const snapshot = scene();
    snapshot.dependencies = [wrapper];
    snapshot.entities = [
      {
        ...(snapshot.entities[0] as ProjectSnapshot["entities"][number]),
        instanceOf: { prefab: packageResourceId(wrapper, "pf_outer") },
      },
    ];
    sim = await Simulation.create(snapshot, "out_main", {
      realm: "workspace",
      packages: [
        ready(),
        { status: "ready", dependency: wrapper, manifest: packageManifest(source, "out_lib") },
      ],
    });
    expect(sim.systemStatus()[0]?.error).toBeNull();
    sim.step(1 / 60);
    expect(
      sim.world.get(
        `ent_0/${packageEntityId(wrapper, "ent_inner")}`,
        packageResourceId(dep, "ks_counter"),
      )?.n,
    ).toBe(3);
  });

  it("セッションへ出しても、保存した依存の版で動く", async () => {
    sim = await Simulation.createSession();
    sim.addPart({
      id: "placement",
      realm: "release",
      outputId: "out_main",
      snapshot: scene(),
      packages: [ready()],
      position: [0, 0, 0],
      yaw: 0,
    });
    sim.step(1 / 60);
    expect(sim.world.get("placement/ent_0", packageResourceId(dep, "ks_counter"))?.n).toBe(3);
    expect(sim.world.get("placement/ent_0", packageResourceId(dep, "ks_counter"))?.links).toEqual([
      "placement/ent_0",
    ]);
    expect(
      withPackagePrefabs(scene(), [ready({ ...dep, version: 2, contentHash: "h2" })]).prefabs,
    ).toBeUndefined();
  });
});
