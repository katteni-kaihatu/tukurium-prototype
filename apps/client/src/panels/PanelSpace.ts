import * as THREE from "three";
import { CSS3DObject, type CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";

/** 3D 表示のパネルの 1px あたりの大きさ（m）。400px のパネルが幅 1m になる。 */
export const PANEL_METERS_PER_PX = 0.0025;

export interface PanelTransform {
  position: [number, number, number];
  /** Y 軸回りの回転（ラジアン）。パネルの表は +Z を向く。 */
  yaw: number;
}

interface Placed {
  wrapper: HTMLDivElement;
  object: CSS3DObject;
  occluder: THREE.Mesh;
  observer: ResizeObserver;
}

/**
 * 空間に置いたパネル（3D 表示）。実 DOM を CSS3DRenderer で空間に置き、操作できるようにする。
 *
 * 前後関係：CSS のレイヤーは WebGL のキャンバスの「後ろ」に置き、パネルの位置に透明な板（occluder）を
 * WebGL で描いてキャンバスに穴を開ける。手前にある物体は穴の上に描かれるので、パネルが正しく隠れる。
 */
export class PanelSpace {
  private readonly placed = new Map<string, Placed>();
  private readonly occluderMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    opacity: 0,
    transparent: false,
    blending: THREE.NoBlending,
    side: THREE.DoubleSide,
  });

  constructor(
    private readonly scene: THREE.Scene,
    readonly renderer: CSS3DRenderer,
  ) {}

  /** パネルの要素を空間に置く。既に置いてあれば位置だけ変える。 */
  place(id: string, element: HTMLElement, transform: PanelTransform): void {
    let p = this.placed.get(id);
    if (!p) {
      const wrapper = document.createElement("div");
      wrapper.style.pointerEvents = "auto";
      const object = new CSS3DObject(wrapper);
      object.scale.setScalar(PANEL_METERS_PER_PX);
      const occluder = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.occluderMaterial);
      const observer = new ResizeObserver(() => this.fitOccluder(id));
      this.scene.add(object, occluder);
      p = { wrapper, object, occluder, observer };
      this.placed.set(id, p);
    }
    if (element.parentElement !== p.wrapper) {
      p.wrapper.replaceChildren(element);
      p.observer.disconnect();
      p.observer.observe(element);
    }
    p.object.position.set(...transform.position);
    p.object.rotation.set(0, transform.yaw, 0);
    p.occluder.position.copy(p.object.position);
    p.occluder.rotation.copy(p.object.rotation);
    this.fitOccluder(id);
  }

  /** 空間から取り除く（要素は呼び出し側が別の場所へ移す）。 */
  remove(id: string): void {
    const p = this.placed.get(id);
    if (!p) return;
    p.observer.disconnect();
    this.scene.remove(p.object, p.occluder);
    p.occluder.geometry.dispose();
    p.wrapper.remove();
    this.placed.delete(id);
  }

  transformOf(id: string): PanelTransform | undefined {
    const p = this.placed.get(id);
    if (!p) return undefined;
    const { x, y, z } = p.object.position;
    return { position: [x, y, z], yaw: p.object.rotation.y };
  }

  dispose(): void {
    for (const id of [...this.placed.keys()]) this.remove(id);
    this.occluderMaterial.dispose();
  }

  private fitOccluder(id: string): void {
    const p = this.placed.get(id);
    const el = p?.wrapper.firstElementChild as HTMLElement | null;
    if (!p || !el) return;
    // CSS の変形の影響を受けない大きさ（レイアウト上の px）
    p.occluder.scale.set(
      el.offsetWidth * PANEL_METERS_PER_PX,
      el.offsetHeight * PANEL_METERS_PER_PX,
      1,
    );
  }
}
