import { describe, expect, it } from "vitest";
import { collectSelection, extractInto } from "./extract";
import { diffFiles, fromFiles, toFiles } from "./files";
import { ProjectDoc } from "./projectDoc";
import { gunAndTargetSample, gunSample, targetRangeSample } from "./samples";

const norm = (s: ReturnType<typeof gunAndTargetSample>) => ({
  ...s,
  assets: s.assets ?? [],
  provenance: s.provenance ?? undefined,
  kokostates: [...s.kokostates].sort((a, b) => a.id.localeCompare(b.id)),
  systems: [...s.systems].sort((a, b) => a.id.localeCompare(b.id)),
  materials: [...s.materials].sort((a, b) => a.id.localeCompare(b.id)),
  outputs: [...s.outputs].sort((a, b) => a.id.localeCompare(b.id)),
  entities: [...s.entities].sort((a, b) => a.id.localeCompare(b.id)),
});

describe("ファイル形式", () => {
  it("制作データ → ファイル → 制作データ で元に戻る", () => {
    const snap = gunAndTargetSample();
    const files = toFiles(snap);
    expect(files["systems/sys_shoot.ts"]).toContain("export default system");
    expect(files["outputs/out_range/entities/ent_gun.json"]).toBeDefined();
    expect(norm(fromFiles(files))).toEqual(norm(snap));
  });

  it("差分：変えたファイルだけが出る", () => {
    const a = toFiles(gunAndTargetSample());
    const s = gunAndTargetSample();
    const gun = s.entities.find((e) => e.id === "ent_gun");
    if (gun?.states.ks_gun) gun.states.ks_gun.f_damage = 5;
    s.systems = s.systems.filter((x) => x.id !== "sys_target");
    const d = diffFiles(a, toFiles(s));
    expect(d.map((c) => [c.path, c.change])).toEqual([
      ["outputs/out_range/entities/ent_gun.json", "modified"],
      ["systems/sys_target.json", "removed"],
      ["systems/sys_target.ts", "removed"],
    ]);
    expect(d[0]).toMatchObject({ add: 1, del: 1 });
  });

  it("ProjectDoc を通しても由来（provenance）が残る", () => {
    const s = gunSample();
    s.provenance = [{ kind: "fork", repoId: "r", repoName: "x", commit: "c", items: [], at: "t" }];
    const d = new ProjectDoc();
    d.load(s);
    expect(d.snapshot().provenance).toEqual(s.provenance);
  });
});

describe("抽出", () => {
  it("アウトプットを選ぶと、依存する System・KokoState・マテリアルも一緒に集める", () => {
    const sel = collectSelection(gunAndTargetSample(), {
      outputs: ["out_range"],
      kokostates: [],
      systems: [],
      materials: [],
      assets: [],
    });
    expect(sel.systems.sort()).toEqual(["sys_shoot", "sys_target"]);
    expect(sel.kokostates.sort()).toEqual(["ks_gun", "ks_target"]);
    expect(sel.materials.sort()).toEqual(["mat_gun", "mat_wood"]);
  });

  it("System を選ぶと、import した KokoState も一緒に集める", () => {
    const src = gunAndTargetSample();
    src.kokostates.push({ id: "ks_ammo", name: "Ammo", fields: [] });
    src.systems.push({
      id: "sys_reload",
      name: "Reload",
      code: 'import Ammo from "/Ammo.koko";\nexport default system({ query: { with: [Ammo] } });',
    });
    const sel = collectSelection(src, {
      outputs: [],
      kokostates: [],
      systems: ["sys_reload"],
      materials: [],
      assets: [],
    });
    expect(sel.kokostates).toEqual(["ks_ammo"]);
  });

  it("新しいリポジトリへ：選んだものと由来が入る", () => {
    const out = extractInto(
      gunAndTargetSample(),
      { outputs: [], kokostates: ["ks_gun"], systems: ["sys_shoot"], materials: [], assets: [] },
      { repoId: "r1", repoName: "銃と的", commit: "abc" },
      null,
      "銃の部品",
    );
    expect(out.name).toBe("銃の部品");
    expect(out.kokostates.map((k) => k.name)).toEqual(["Gun"]);
    expect(out.systems.map((s) => s.name)).toEqual(["Shoot"]);
    expect(out.provenance?.[0]).toMatchObject({
      kind: "extract",
      repoId: "r1",
      commit: "abc",
      items: ["Gun", "Shoot"],
    });
  });

  it("既存のリポジトリへ：同じ名前の別の KokoState は名前を付け替え、コードも書き換える", () => {
    const target = targetRangeSample();
    target.kokostates.push({ id: "ks_other", name: "Gun", fields: [] });
    const out = extractInto(
      gunSample(),
      { outputs: ["out_gun"], kokostates: [], systems: [], materials: [], assets: [] },
      { repoId: "r2", repoName: "銃", commit: "def" },
      target,
    );
    const gun = out.kokostates.find((k) => k.id === "ks_gun");
    expect(gun?.name).toBe("Gun_2");
    expect(out.systems.find((s) => s.id === "sys_shoot")?.code).toContain('"./Gun_2.koko"');
    expect(out.outputs.map((o) => o.id).sort()).toEqual(["out_gun", "out_range"]);
    expect(out.entities.filter((e) => e.output === "out_gun").map((e) => e.id)).toEqual([
      "ent_gun",
    ]);
    // もとの射撃場の中身はそのまま
    expect(out.entities.filter((e) => e.output === "out_range")).toHaveLength(6);
  });

  it("同じ中身はそのまま使い、違う中身は ID を振り直す", () => {
    const target = gunSample();
    const out = extractInto(
      gunSample(),
      { outputs: ["out_gun"], kokostates: [], systems: [], materials: [], assets: [] },
      { repoId: "r", repoName: "銃", commit: "c" },
      target,
    );
    expect(out.kokostates).toHaveLength(1); // 同じ定義は重複しない
    expect(out.outputs).toHaveLength(2); // アウトプットは新しい ID で増える
    expect(new Set(out.entities.map((e) => e.id)).size).toBe(2);
  });

  it("フォルダと割り当ても、ファイルとの行き来で保たれる", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const f = p.addFolder("しくみ", null);
    const sys = p.systems()[0];
    if (!sys) throw new Error("System がありません");
    p.moveResource(sys.id, f);
    const back = fromFiles(toFiles(p.snapshot()));
    expect(back.folders).toEqual(p.snapshot().folders);
    expect(back.placement).toEqual({ [sys.id]: f });
  });
});
