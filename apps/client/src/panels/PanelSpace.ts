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
  /** 右ドラッグで動かしているパネル */
  private moving: { id: string; distance: number; pointer: () => THREE.Vector2 } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  /** 動かし終えたときに呼ぶ（置き場所を保存する側へ知らせる） */
  onMoved: ((id: string, transform: PanelTransform) => void) | null = null;
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
      // 裏から見たときは表示もクリックもしない（鏡文字のパネルがクリックを奪わないように）
      wrapper.style.backfaceVisibility = "hidden";
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

  /** 要素が入っている 3D パネルの ID（3D に置いたパネルの中でなければ null） */
  idOf(el: Element | null): string | null {
    if (!el) return null;
    for (const [id, p] of this.placed) if (p.wrapper.contains(el)) return id;
    return null;
  }

  /**
   * 右ドラッグでパネルを動かし始める。距離は今のまま、ポインターの先（照準なら画面の中央）へ動かす。
   * pointer は画面上の位置（-1〜1 の正規化座標）を返す。
   */
  startMove(id: string, camera: THREE.Camera, pointer: () => THREE.Vector2): void {
    const p = this.placed.get(id);
    if (!p) return;
    const eye = camera.getWorldPosition(new THREE.Vector3());
    this.moving = { id, distance: eye.distanceTo(p.object.position), pointer };
  }

  endMove(): void {
    const m = this.moving;
    this.moving = null;
    if (!m) return;
    const t = this.transformOf(m.id);
    if (t) this.onMoved?.(m.id, t);
  }

  get isMoving(): boolean {
    return this.moving !== null;
  }

  /** 空間から取り除く（要素は呼び出し側が別の場所へ移す）。 */
  remove(id: string): void {
    if (this.moving?.id === id) this.moving = null;
    const p = this.placed.get(id);
    if (!p) return;
    p.observer.disconnect();
    this.scene.remove(p.object, p.occluder);
    p.occluder.geometry.dispose();
    p.wrapper.remove();
    this.placed.delete(id);
  }

  /**
   * 毎フレーム：カメラの後ろ・すぐ近くのパネルを隠す。
   * CSS の透視投影では、カメラの後ろの要素が画面いっぱいに広がってクリックを奪うことがある。
   */
  update(camera: THREE.Camera): void {
    if (this.placed.size === 0) return;
    const m = this.moving ? this.placed.get(this.moving.id) : undefined;
    if (this.moving && m) {
      this.raycaster.setFromCamera(this.moving.pointer(), camera);
      const pos = this.raycaster.ray.at(this.moving.distance, new THREE.Vector3());
      const forward = camera.getWorldDirection(new THREE.Vector3());
      m.object.position.copy(pos);
      // こちらを向ける（カメラの向きの水平成分）
      m.object.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
      m.occluder.position.copy(m.object.position);
      m.occluder.rotation.copy(m.object.rotation);
    }
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const to = new THREE.Vector3();
    for (const p of this.placed.values()) {
      to.copy(p.object.position).sub(eye);
      const visible = to.dot(forward) > 0.3;
      const v = visible ? "" : "hidden";
      if (p.wrapper.style.visibility !== v) p.wrapper.style.visibility = v;
    }
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
