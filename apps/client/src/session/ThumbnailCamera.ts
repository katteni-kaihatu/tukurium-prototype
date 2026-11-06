import type { Vec3 } from "@tukurium/eks";
import { moveAlongView, placeFromView, poseInView } from "@tukurium/runtime";
import * as THREE from "three";
import { create } from "zustand";
import type { SessionEngine } from "./SessionEngine";

/** 撮る画像の大きさ（カードに合わせて横長） */
export const SHOT_WIDTH = 640;
export const SHOT_HEIGHT = 360;
const PREVIEW_WIDTH = 256;
const PREVIEW_HEIGHT = 144;
/** プレビューを描き直す間隔（秒） */
const PREVIEW_INTERVAL = 0.12;

/**
 * サムネイルを撮るカメラ（ADR 0046）。空間に置いた物として出し、右クリックで持って動かす。
 * 映る範囲は Inspector のプレビューに出し、「撮る」で PNG にする。
 * カメラ本体は手伝いの表示なので、自分の画面にだけ出し、撮った画像には写らない。
 */
export class ThumbnailCamera {
  private readonly lens = new THREE.PerspectiveCamera(50, SHOT_WIDTH / SHOT_HEIGHT, 0.05, 500);
  private readonly body = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly previewTarget = new THREE.WebGLRenderTarget(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  private preview: HTMLCanvasElement | null = null;
  private previewTimer = 0;
  private held: { offset: Vec3; rotation: Vec3 } | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly engine: SessionEngine) {
    this.previewTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.body.userData.noShot = true;
    this.body.visible = false;
    this.body.add(this.lens);
    this.buildModel();
    engine.scene.add(this.body);
    this.disposers.push(
      engine.onFrame((dt) => this.update(dt)),
      engine.claimPointer({
        down: (button) => button === 2 && this.tryHold(),
        up: () => {
          this.held = null;
        },
      }),
      engine.onHoldWheel((meters) => {
        if (this.held) this.held.offset = moveAlongView(this.held.offset, meters);
      }),
    );
    useThumbnailCamera.setState({ camera: this });
  }

  get shown(): boolean {
    return this.body.visible;
  }

  /** 目の前（いまの視点と同じ向き）に出す。すでに出ていれば、目の前へ呼び戻す */
  show(): void {
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    const forward = cam.getWorldDirection(new THREE.Vector3());
    this.body.position
      .copy(cam.getWorldPosition(new THREE.Vector3()))
      .addScaledVector(forward, 0.8);
    this.body.quaternion.copy(cam.getWorldQuaternion(new THREE.Quaternion()));
    this.body.visible = true;
    useThumbnailCamera.setState({ shown: true });
  }

  hide(): void {
    this.body.visible = false;
    this.held = null;
    useThumbnailCamera.setState({ shown: false });
  }

  /** Inspector のプレビューを描く先（null で描かない） */
  setPreview(canvas: HTMLCanvasElement | null): void {
    this.preview = canvas;
    if (canvas) {
      canvas.width = PREVIEW_WIDTH;
      canvas.height = PREVIEW_HEIGHT;
    }
  }

  /** いまカメラに映っているものを PNG にする */
  async capture(): Promise<Blob> {
    const target = new THREE.WebGLRenderTarget(SHOT_WIDTH, SHOT_HEIGHT, { samples: 4 });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    try {
      const canvas = document.createElement("canvas");
      this.draw(target, canvas);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした"))),
          "image/png",
        ),
      );
    } finally {
      target.dispose();
    }
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.body.removeFromParent();
    this.body.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.previewTarget.dispose();
    useThumbnailCamera.setState({ camera: null, shown: false });
  }

  private update(dt: number): void {
    if (!this.body.visible) return;
    if (this.held) {
      const { origin, direction } = this.viewRay();
      const placed = placeFromView(origin, direction, this.held.offset, this.held.rotation);
      this.body.position.set(...placed.position);
      this.body.rotation.set(
        THREE.MathUtils.degToRad(placed.rotation[0]),
        THREE.MathUtils.degToRad(placed.rotation[1]),
        THREE.MathUtils.degToRad(placed.rotation[2]),
        "XYZ",
      );
    }
    this.previewTimer -= dt;
    if (this.preview && this.previewTimer <= 0) {
      this.previewTimer = PREVIEW_INTERVAL;
      this.draw(this.previewTarget, this.preview);
    }
  }

  /** 照準の先がカメラなら、持ち始める */
  private tryHold(): boolean {
    if (!this.body.visible) return false;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.engine.camera);
    if (this.raycaster.intersectObject(this.body, true).length === 0) return false;
    const { origin, direction } = this.viewRay();
    const r = new THREE.Euler().setFromQuaternion(this.body.quaternion, "XYZ");
    this.held = poseInView(
      origin,
      direction,
      [this.body.position.x, this.body.position.y, this.body.position.z],
      [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
    );
    return true;
  }

  private viewRay(): { origin: Vec3; direction: Vec3 } {
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    const o = cam.getWorldPosition(new THREE.Vector3());
    const d = cam.getWorldDirection(new THREE.Vector3());
    return { origin: [o.x, o.y, o.z], direction: [d.x, d.y, d.z] };
  }

  /** カメラで描き、2D の canvas へ写す（WebGL の行は下から上なので、上下を返す） */
  private draw(target: THREE.WebGLRenderTarget, canvas: HTMLCanvasElement): void {
    this.body.updateMatrixWorld(true);
    this.engine.renderShot(this.lens, target);
    const { width, height } = target;
    const pixels = new Uint8Array(width * height * 4);
    this.engine.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    ctx.putImageData(image, 0, 0);
  }

  /** カメラの見た目：黒い箱とレンズ。レンズの向き（-Z）が映す向き */
  private buildModel(): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2730, roughness: 0.5 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x603d56, roughness: 0.4 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.1), dark);
    box.position.z = 0.08;
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 24), accent);
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.01;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.05), accent);
    top.position.set(-0.05, 0.085, 0.08);
    this.body.add(box, lens, top);
    // レンズの少し前から映す（自分の箱が写らないように）
    this.lens.position.z = -0.06;
  }
}

/** UI から使うための入口（セッションの空間を開いている間だけ camera がある） */
export const useThumbnailCamera = create<{ camera: ThumbnailCamera | null; shown: boolean }>(
  () => ({ camera: null, shown: false }),
);
