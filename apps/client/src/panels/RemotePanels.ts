import type * as THREE from "three";
import type { RemotePanel } from "../app/store";
import type { Avatars } from "../session/Avatars";
import { PANEL_METERS_PER_PX } from "./PanelSpace";
import { RemotePanelMesh } from "./RemotePanelMesh";

/**
 * 他の参加者が開いているパネルを空間に並べる（要件 §6「その人の前にパネルが並んでいる様子が見える」）。
 * - 3D 表示のパネルは、その人が置いた位置に出す。
 * - 2D 表示（画面に固定）のパネルは、その人の前に横に並べて、その人の動きについていく。
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
        if (mesh) mesh.update(summary);
        else {
          const m = new RemotePanelMesh(summary);
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

  /** 毎フレーム：2D 表示のパネルを持ち主の前に並べ直す */
  update(): void {
    for (const [userId, panels] of this.panels) {
      const pose = this.avatars.poseOf(userId);
      const flat = panels.filter((p) => p.mode === "2d" || !p.transform);
      flat.forEach((p, i) => {
        const mesh = this.meshes.get(`${userId}/${p.id}`);
        if (!mesh) return;
        mesh.visible = Boolean(pose);
        if (!pose) return;
        // 持ち主の前 0.9m、目の高さに、横へ並べる（持ち主の方を向ける）
        const spread = (i - (flat.length - 1) / 2) * 440 * PANEL_METERS_PER_PX * 1.1;
        const sin = Math.sin(pose.yaw);
        const cos = Math.cos(pose.yaw);
        mesh.position.set(
          pose.position[0] - sin * 0.9 + cos * spread,
          pose.position[1] + 1.5,
          pose.position[2] - cos * 0.9 - sin * spread,
        );
        mesh.rotation.set(0, pose.yaw, 0);
      });
      for (const p of panels) {
        if (p.mode !== "3d" || !p.transform) continue;
        const mesh = this.meshes.get(`${userId}/${p.id}`);
        if (!mesh) continue;
        mesh.visible = true;
        mesh.position.set(...p.transform.position);
        mesh.rotation.set(0, p.transform.yaw, 0);
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
