import type { Vec3 } from "@tukurium/eks";
import { moveAlongView, placeFromView, poseInView, straightenRotation } from "@tukurium/runtime";
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
  /** 穴の中心の、本体の中心からのずれ（パネルの向きでの m。付属パネルがあると右へずれる） */
  local: THREE.Vector3;
  /** いまの本体の大きさ（px）。変わったときに左上の角を止めておくために覚える */
  size?: { width: number; height: number };
}

/**
 * 空間に置いたパネル（3D 表示）。実 DOM を CSS3DRenderer で空間に置き、操作できるようにする。
 *
 * 前後関係：CSS のレイヤーは WebGL のキャンバスの「後ろ」に置き、パネルの位置に透明な板（occluder）を
 * WebGL で描いてキャンバスに穴を開ける。手前にある物体は穴の上に描かれるので、パネルが正しく隠れる。
 * 穴は表からだけ開ける。裏から見たときは、穴の代わりに不透明な裏板を描く（穴の奥の空が透けないように）。
 */
export class PanelSpace {
  private readonly placed = new Map<string, Placed>();
  /**
   * 右クリックを押している間、持っているパネル。
   * 物を持つときと同じく、持った瞬間の位置と角度を視点からの差で覚える。
   */
  private moving: {
    id: string;
    offset: Vec3;
    rotation: Vec3;
    pointer: () => THREE.Vector2;
  } | null = null;
  /**
   * 大きさを変えている間のパネル。照準（またはポインター）の先がパネルの面に当たる点を右下の角にする。
   * つかんだ点と角のずれ（px）を覚えておき、つかんだ瞬間に大きさが跳ねないようにする。
   */
  private resizing: {
    id: string;
    dx: number;
    dy: number;
    pointer: () => THREE.Vector2;
    camera: THREE.Camera;
  } | null = null;
  private readonly resizeListeners = new Set<(id: string, width: number, height: number) => void>();
  /** 大きさを変えている間、毎フレーム呼ぶ（PanelLayer が大きさを決める） */
  subscribeResized(listener: (id: string, width: number, height: number) => void): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }
  private readonly raycaster = new THREE.Raycaster();
  /** 動かし終えたときに呼ぶ（置き場所を保存する側へ知らせる） */
  private readonly moveListeners = new Set<(id: string, transform: PanelTransform) => void>();
  subscribeMoved(listener: (id: string, transform: PanelTransform) => void): () => void {
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
  }
  private readonly occluderMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    opacity: 0,
    transparent: false,
    blending: THREE.NoBlending,
    side: THREE.FrontSide,
  });
  /** パネルの裏側。紙の裏のような、少し暗い色 */
  private readonly backMaterial = new THREE.MeshBasicMaterial({
    color: 0xd9d3c9,
    side: THREE.BackSide,
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
      // 穴はサムネイルに写さない（写すと透明な穴になる。ADR 0046）
      occluder.userData.noShot = true;
      // 裏板は穴と同じ大きさ・向きで動く（子にしておく）
      const back = new THREE.Mesh(occluder.geometry, this.backMaterial);
      back.userData.noShot = true;
      occluder.add(back);
      const observer = new ResizeObserver(() => this.fitOccluder(id));
      this.scene.add(object, occluder);
      p = { wrapper, object, occluder, observer, local: new THREE.Vector3() };
      this.placed.set(id, p);
    }
    if (element.parentElement !== p.wrapper) {
      p.wrapper.replaceChildren(element);
    }
    // 付属パネルの開け閉めでも穴の大きさを合わせる
    p.observer.disconnect();
    p.observer.observe(element);
    const drawer = drawerOf(element);
    if (drawer) p.observer.observe(drawer);
    p.object.position.set(...transform.position);
    p.object.rotation.set(0, transform.yaw, 0);
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
   * 右クリックでパネルを持ち始める。位置も角度も、その場から動かさない。
   * pointer は画面上の位置（-1〜1 の正規化座標）を返す。照準なら画面の中央。
   */
  startMove(id: string, camera: THREE.Camera, pointer: () => THREE.Vector2): void {
    const p = this.placed.get(id);
    if (!p) return;
    const { origin, direction } = this.viewRay(camera, pointer());
    const yaw = (p.object.rotation.y * 180) / Math.PI;
    const pose = poseInView(
      origin,
      direction,
      [p.object.position.x, p.object.position.y, p.object.position.z],
      [0, yaw, 0],
    );
    this.moving = { id, offset: pose.offset, rotation: pose.rotation, pointer };
  }

  endMove(): void {
    const m = this.moving;
    this.moving = null;
    if (!m) return;
    const t = this.transformOf(m.id);
    if (t) for (const listener of this.moveListeners) listener(m.id, t);
  }

  /** 右下のつまみで大きさを変え始める。パネルの面に当たらなければ何もしない */
  startResize(id: string, camera: THREE.Camera, pointer: () => THREE.Vector2): boolean {
    const p = this.placed.get(id);
    const el = p?.wrapper.firstElementChild as HTMLElement | null;
    const at = this.pointOnPanel(id, camera, pointer());
    if (!p || !el || !at) return false;
    this.resizing = {
      id,
      dx: el.offsetWidth - at.x,
      dy: el.offsetHeight - at.y,
      pointer,
      camera,
    };
    return true;
  }

  endResize(): void {
    this.resizing = null;
  }

  get isResizing(): boolean {
    return this.resizing !== null;
  }

  /**
   * ポインターの先がパネルの面に当たる点を、パネルの左上からの px（レイアウト上の大きさ）で返す。
   * 面の裏側や、面と平行なときは null。
   */
  pointOnPanel(
    id: string,
    camera: THREE.Camera,
    pointer: THREE.Vector2,
  ): { x: number; y: number } | null {
    const p = this.placed.get(id);
    const el = p?.wrapper.firstElementChild as HTMLElement | null;
    if (!p || !el) return null;
    camera.updateMatrixWorld();
    p.object.updateMatrixWorld();
    this.raycaster.setFromCamera(pointer, camera);
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(p.object.rotation);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, p.object.position);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    // object は 1px = PANEL_METERS_PER_PX に縮めてあるので、ローカルの座標は px（上向きが正、中心が原点）
    const local = p.object.worldToLocal(hit);
    return { x: local.x + el.offsetWidth / 2, y: el.offsetHeight / 2 - local.y };
  }

  get isMoving(): boolean {
    return this.moving !== null;
  }

  /** 持っているパネルを、同じ方向のまま前後に動かす（正で奥へ、メートル） */
  moveDepth(meters: number): void {
    if (!this.moving || meters === 0) return;
    this.moving.offset = moveAlongView(this.moving.offset, meters);
  }

  /** 空間から取り除く（要素は呼び出し側が別の場所へ移す）。 */
  remove(id: string): void {
    if (this.moving?.id === id) this.moving = null;
    if (this.resizing?.id === id) this.resizing = null;
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
    const sizing = this.resizing;
    if (sizing) {
      const at = this.pointOnPanel(sizing.id, camera, sizing.pointer());
      if (at) {
        for (const fn of this.resizeListeners) fn(sizing.id, at.x + sizing.dx, at.y + sizing.dy);
      }
    }
    const held = this.moving;
    const m = held ? this.placed.get(held.id) : undefined;
    if (held && m) {
      const { origin, direction } = this.viewRay(camera, held.pointer());
      const placed = placeFromView(origin, direction, held.offset, held.rotation);
      m.object.position.set(placed.position[0], placed.position[1], placed.position[2]);
      // パネルが覚える角度は上下の軸まわりだけ。傾きは付けない
      const upright = straightenRotation(placed.rotation);
      m.object.rotation.set(0, ((upright[1] ?? 0) * Math.PI) / 180, 0);
      m.occluder.rotation.copy(m.object.rotation);
      placeOccluder(m);
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
    this.backMaterial.dispose();
  }

  /** ポインターの先（照準なら視線）を、物を持つときと同じ視点の向きとして使う */
  private viewRay(camera: THREE.Camera, pointer: THREE.Vector2): { origin: Vec3; direction: Vec3 } {
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(pointer, camera);
    const { origin, direction } = this.raycaster.ray;
    return {
      origin: [origin.x, origin.y, origin.z],
      direction: [direction.x, direction.y, direction.z],
    };
  }

  /**
   * WebGL に開ける穴を、パネルの大きさに合わせる。付属パネル（ADR 0044）があれば、
   * それも含めた範囲にし、その中心へ穴をずらす（本体の位置は動かさない）。
   */
  private fitOccluder(id: string): void {
    const p = this.placed.get(id);
    const el = p?.wrapper.firstElementChild as HTMLElement | null;
    if (!p || !el) return;
    // CSS の変形の影響を受けない大きさ（レイアウト上の px）
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 大きさが変わったら、左上の角が動かないよう中心をずらす（右下へ広がる・縮む）
    // 隠している間（大きさ 0）は覚えない。出し直したときに大きくずれないように
    const before = p.size;
    if (w > 0 && h > 0) p.size = { width: w, height: h };
    if (before && w > 0 && h > 0 && (before.width !== w || before.height !== h)) {
      const shift = new THREE.Vector3(
        ((w - before.width) / 2) * PANEL_METERS_PER_PX,
        (-(h - before.height) / 2) * PANEL_METERS_PER_PX,
        0,
      ).applyEuler(p.object.rotation);
      p.object.position.add(shift);
      const t = this.transformOf(id);
      if (t) for (const listener of this.moveListeners) listener(id, t);
    }
    let [minX, maxX, minY, maxY] = [0, w, 0, h];
    const drawer = drawerOf(el);
    if (drawer) {
      minX = Math.min(minX, drawer.offsetLeft);
      maxX = Math.max(maxX, drawer.offsetLeft + drawer.offsetWidth);
      minY = Math.min(minY, drawer.offsetTop);
      maxY = Math.max(maxY, drawer.offsetTop + drawer.offsetHeight);
    }
    p.occluder.scale.set(
      (maxX - minX) * PANEL_METERS_PER_PX,
      (maxY - minY) * PANEL_METERS_PER_PX,
      1,
    );
    // 本体の中心からのずれ（画面の下向きの px を、空間の上向きへ直す）
    p.local.set(
      ((minX + maxX) / 2 - w / 2) * PANEL_METERS_PER_PX,
      -((minY + maxY) / 2 - h / 2) * PANEL_METERS_PER_PX,
      0,
    );
    placeOccluder(p);
  }
}

function placeOccluder(p: Placed): void {
  p.occluder.position.copy(p.local).applyEuler(p.object.rotation).add(p.object.position);
}

/** パネルの入れ物の直下にある付属パネル（開いていれば中身、たたんでいればつまみ） */
function drawerOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(":scope > [data-panel-drawer]");
}
