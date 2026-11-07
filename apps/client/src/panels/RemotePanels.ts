import * as THREE from "three";
import type { RemotePanel } from "../app/store";
import type { Avatars } from "../session/Avatars";
import { CAMERA_FOV, EYE_HEIGHT } from "../session/FpsController";
import { PANEL_METERS_PER_PX } from "./PanelSpace";
import { RemotePanelMesh } from "./RemotePanelMesh";

/**
 * 他の参加者が開いているパネルを空間に並べる（要件 §6「その人の前にパネルが並んでいる様子が見える」）。
 * - 3D 表示のパネルは、その人が置いた位置に出す。
 * - 2D 表示（画面に固定）のパネルは、その人の視界の中で、画面上と同じ所・同じ見かけの大きさに出し、
 *   その人の動き（向き・見上げ）についていく。
 * - 大きさは、その人の画面での px を 1px = PANEL_METERS_PER_PX で空間の大きさにする。
 * 内容はサーバーが権限で伏せたあとのものしか届かない。
 */
export class RemotePanels {
  private readonly meshes = new Map<string, RemotePanelMesh>();
  private panels = new Map<string, RemotePanel[]>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly avatars: Avatars,
  ) {}

  set(all: Record<string, RemotePanel[]>): void {
    this.panels = new Map(Object.entries(all));
    const wanted = new Set<string>();
    for (const [userId, panels] of this.panels) {
      for (const p of panels) {
        const key = `${userId}/${p.id}`;
        wanted.add(key);
        const summary = { title: p.title, owner: "", restricted: p.restricted, lines: p.lines };
        const mesh = this.meshes.get(key);
        if (mesh) {
          mesh.update(summary);
          mesh.resize(p.size.width, p.size.height);
        } else {
          const m = new RemotePanelMesh(summary, p.size.width, p.size.height);
          m.userData.remotePanel = key;
          this.meshes.set(key, m);
          this.scene.add(m);
        }
      }
    }
    for (const [key, mesh] of this.meshes) {
      if (wanted.has(key)) continue;
      mesh.removeFromParent();
      mesh.dispose();
      this.meshes.delete(key);
    }
  }

  /** 毎フレーム：2D 表示のパネルを持ち主の視界に合わせて置き直す */
  update(): void {
    for (const [userId, panels] of this.panels) {
      const pose = this.avatars.poseOf(userId);
      const flat = panels.filter((p) => p.mode === "2d" || !p.transform);
      flat.forEach((p, i) => {
        const mesh = this.meshes.get(`${userId}/${p.id}`);
        if (!mesh) return;
        mesh.visible = Boolean(pose);
        if (!pose) return;
        placeOnView(mesh, pose, p, i, flat.length);
      });
      for (const p of panels) {
        if (p.mode !== "3d" || !p.transform) continue;
        const mesh = this.meshes.get(`${userId}/${p.id}`);
        if (!mesh) continue;
        mesh.visible = true;
        mesh.position.set(...p.transform.position);
        mesh.rotation.set(0, p.transform.yaw, 0);
        mesh.scale.setScalar(1);
      }
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.meshes.clear();
  }
}

const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2);
const euler = new THREE.Euler();
const offset = new THREE.Vector3();

/**
 * 持ち主の目の位置から見て、持ち主の画面の上と同じ所に、同じ見かけの大きさで見えるように置く。
 * 奥行きは、自分のパネルを空間に置くとき（PanelLayer の placeInFront）と同じ決め方にし、
 * 奥行きを丸めた分だけ大きさを縮める（画面の上での見かけの大きさを保つ）。
 * 画面の位置が届いていない（古い相手など）ときは、持ち主の正面に横に並べる。
 */
export function placeOnView(
  mesh: THREE.Object3D,
  pose: { position: [number, number, number]; yaw: number; pitch: number },
  panel: Pick<RemotePanel, "screen" | "size">,
  index: number,
  count: number,
): void {
  const screen = panel.screen;
  const viewHeight = screen?.viewHeight ?? 720;
  // 画面の高さ 1px が、奥行き depth の所で何 m になるか
  const natural = (viewHeight * PANEL_METERS_PER_PX) / (2 * TAN_HALF_FOV);
  const depth = THREE.MathUtils.clamp(natural, 1.2, 2.5) - index * 0.01;
  const metersPerPx = (2 * depth * TAN_HALF_FOV) / viewHeight;
  if (screen) {
    const aspect = screen.viewWidth / screen.viewHeight;
    const ndcX = (screen.x / screen.viewWidth) * 2 - 1;
    const ndcY = -((screen.y / screen.viewHeight) * 2 - 1);
    offset.set(ndcX * depth * TAN_HALF_FOV * aspect, ndcY * depth * TAN_HALF_FOV, -depth);
  } else {
    const spread = (index - (count - 1) / 2) * (panel.size.width + 20) * metersPerPx;
    offset.set(spread, 0, -depth);
  }
  euler.set(pose.pitch, pose.yaw, 0, "YXZ");
  offset.applyEuler(euler);
  mesh.position.set(
    pose.position[0] + offset.x,
    pose.position[1] + EYE_HEIGHT + offset.y,
    pose.position[2] + offset.z,
  );
  mesh.rotation.copy(euler);
  mesh.scale.setScalar(metersPerPx / PANEL_METERS_PER_PX);
}
