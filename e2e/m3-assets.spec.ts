import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { createSessionAndWorkspace, test } from "./helpers";

// シナリオ 3：基本図形のパラメータ・マテリアルを編集し、GLB・画像・音声を利用できる

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

test("画像・音声・GLB を取り込み、マテリアル・AudioSource・Mesh で使う", async ({ page }) => {
  await createSessionAndWorkspace(page, "れにうむ", "sample");
  const res = panel(page, "Resources");

  // GLB はページの中で three.js の書き出し機能を使って作る
  const glb = await page.evaluate(async () => {
    const THREE = await import("/node_modules/.vite/deps/three.js");
    const { GLTFExporter } = await import(
      "/node_modules/three/examples/jsm/exporters/GLTFExporter.js"
    );
    const scene = new THREE.Scene();
    scene.add(
      new THREE.Mesh(
        new THREE.TorusGeometry(0.3, 0.1),
        new THREE.MeshStandardMaterial({ color: "#2f4a9c" }),
      ),
    );
    const out = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    return Array.from(new Uint8Array(out));
  });
  await res.getByLabel("素材ファイルを選ぶ").setInputFiles([
    {
      name: "checker.png",
      mimeType: "image/png",
      buffer: readFileSync("e2e/fixtures/checker.png"),
    },
    { name: "beep.wav", mimeType: "audio/wav", buffer: readFileSync("e2e/fixtures/beep.wav") },
    { name: "ring.glb", mimeType: "model/gltf-binary", buffer: Buffer.from(glb) },
  ]);
  await expect(res.getByRole("button", { name: "checker（Texture）" })).toBeVisible();
  await expect(res.getByRole("button", { name: "beep（Audio）" })).toBeVisible();
  await expect(res.getByRole("button", { name: "ring（Model）" })).toBeVisible();

  // 画像をマテリアルに
  await res.getByRole("button", { name: "Wood（Material）" }).click();
  const insp = panel(page, "Inspector");
  await insp.getByLabel("画像").selectOption({ label: "checker" });

  // GLB を銃の見た目に、音声を AudioSource に
  await insp.getByRole("button", { name: "銃", exact: true }).click();
  await insp.getByLabel("model", { exact: true }).selectOption({ label: "ring" });
  await insp.getByRole("button", { name: "＋ Add KokoState" }).click();
  await insp.getByLabel("KokoState を検索").fill("AudioSource");
  await insp.getByRole("button", { name: /^AudioSource/ }).click();
  await insp.getByLabel("clip", { exact: true }).selectOption({ label: "beep" });

  // 制作データに入り、素材はサーバーから取り出せる
  const snap = await page.evaluate(() => {
    const p = (window as unknown as { __workspace: any }).__workspace.getState().project.snapshot();
    const gun = p.entities.find((e: { id: string }) => e.id === "ent_gun");
    return {
      assets: p.assets.map((a: { kind: string }) => a.kind).sort(),
      model: gun.states["builtin.Mesh"].model,
      clip: gun.states["builtin.AudioSource"].clip,
      map: p.materials.find((m: { id: string }) => m.id === "mat_wood").map,
    };
  });
  expect(snap.assets).toEqual(["audio", "image", "model"]);
  // 素材にも権限がある：本人確認のトークンがなければ取り出せない
  const token = await page.evaluate(() => localStorage.getItem("tukurium.token") ?? "");
  for (const id of [snap.model, snap.clip, snap.map]) {
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect((await page.request.get(`/api/assets/${id}?t=${token}`)).status()).toBe(200);
    expect((await page.request.get(`/api/assets/${id}`)).status()).toBe(404);
  }

  // 画面に GLB のモデルが出ている（銃の Entity の下に読み込まれる）
  await expect
    .poll(() =>
      page.evaluate(() => {
        const e = (window as unknown as { __tukurium: any }).__tukurium;
        let found = false;
        e.scene.traverse((o: any) => {
          if (
            o.userData?.entityId === "ent_gun" &&
            o.children.some((c: any) => c.type === "Group" || c.type === "Object3D")
          )
            found = true;
        });
        return found;
      }),
    )
    .toBe(true);
});
