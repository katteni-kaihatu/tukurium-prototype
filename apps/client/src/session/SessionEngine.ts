import type { Participant } from "@tukurium/shared";
import * as THREE from "three";
import { CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import { PanelSpace } from "../panels/PanelSpace";
import { RemotePanels } from "../panels/RemotePanels";
import { AudioPlayer } from "../render/AudioPlayer";
import { Avatars } from "./Avatars";
import { FpsController } from "./FpsController";

export interface Pose {
  position: [number, number, number];
  yaw: number;
  pitch: number;
}

/**
 * セッションの 3D 空間。描画ループ・FPS 操作・参加者表示を持つ。
 * React からは mount / dispose だけを呼ぶ（シーンを React の状態で管理しない）。
 */
export class SessionEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
  readonly controller: FpsController;
  readonly avatars: Avatars;
  readonly panels: PanelSpace;
  readonly remotePanels: RemotePanels;
  readonly audio: AudioPlayer;
  private readonly cssRenderer = new CSS3DRenderer();

  private readonly clock = new THREE.Clock();
  private readonly frameListeners = new Set<(dt: number) => void>();
  private readonly pointerListeners = new Set<(button: number, phase: "down" | "up") => void>();
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
    // 空は CSS で描き、WebGL は透明にする（パネルの穴あけのため。PanelSpace を参照）
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    Object.assign(canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    const css = this.cssRenderer.domElement;
    Object.assign(css.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    container.style.background = "linear-gradient(#C9DDF6 0%, #DCE7F3 55%, #E9E4D6 100%)";
    container.append(css, canvas);
    this.panels = new PanelSpace(this.scene, this.cssRenderer);

    this.buildWorld();
    // カメラの子（Play 中に手に持つ物）も描画されるよう、カメラをシーンに入れる
    this.scene.add(this.camera);
    this.controller = new FpsController(this.camera, canvas);
    // 何もない所をクリックしたら空間に入る（パネルの上のクリックはパネルが受け取る）
    container.addEventListener("click", this.onContainerClick);
    document.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mouseup", this.onMouseUp);
    this.avatars = new Avatars(this.scene);
    this.remotePanels = new RemotePanels(this.scene, this.avatars);
    this.audio = new AudioPlayer(this.scene, this.camera);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  /** 毎フレーム呼ばれる処理を登録する。戻り値で解除。 */
  onFrame(fn: (dt: number) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /** 空間に入っている（ポインターロック中）ときのマウスボタンの押下・解放。戻り値で解除。 */
  onPointer(fn: (button: number, phase: "down" | "up") => void): () => void {
    this.pointerListeners.add(fn);
    return () => this.pointerListeners.delete(fn);
  }

  pose(): Pose {
    const p = this.controller.position;
    return { position: [p.x, p.y, p.z], yaw: this.controller.yaw, pitch: this.controller.pitch };
  }

  upsertParticipant(p: Participant): void {
    this.avatars.upsert(p);
  }

  setParticipantPose(id: string, position: Pose["position"], yaw: number, pitch: number): void {
    this.avatars.setPose(id, position, yaw, pitch);
  }

  removeParticipant(id: string): void {
    this.avatars.remove(id);
  }

  dispose(): void {
    this.disposed = true;
    this.container.removeEventListener("click", this.onContainerClick);
    document.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mouseup", this.onMouseUp);
    this.frameListeners.clear();
    this.pointerListeners.clear();
    this.panels.dispose();
    this.cssRenderer.domElement.remove();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controller.dispose();
    this.avatars.clear();
    this.remotePanels.dispose();
    this.audio.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.controller.update(dt);
    this.avatars.update(dt);
    this.remotePanels.update();
    for (const fn of this.frameListeners) fn(dt);
    this.renderer.render(this.scene, this.camera);
    this.cssRenderer.render(this.scene, this.camera);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.controller.locked) return;
    for (const fn of this.pointerListeners) fn(e.button, "down");
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (!this.controller.locked) return;
    for (const fn of this.pointerListeners) fn(e.button, "up");
  };

  private onContainerClick = (e: MouseEvent): void => {
    if (e.target === this.container) this.controller.lock();
  };

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.cssRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** M0 用の仮の空間。M1 以降はワールドのアウトプットから組み立てる。 */
  private buildWorld(): void {
    this.scene.fog = new THREE.Fog("#E3E6E4", 30, 120);

    this.scene.add(new THREE.HemisphereLight("#ffffff", "#B8C4A8", 1.1));
    const sun = new THREE.DirectionalLight("#fff6e8", 2.2);
    sun.position.set(12, 20, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 25;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 60 });
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: "#E9E4D6", roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(400, 400, "#CFC6B4", "#DCD5C8");
    grid.position.y = 0.002;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(grid);
  }
}
