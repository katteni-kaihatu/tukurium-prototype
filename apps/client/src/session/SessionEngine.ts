import type { Participant } from "@tukurium/shared";
import * as THREE from "three";
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

  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = "block";
    container.appendChild(this.renderer.domElement);

    this.buildWorld();
    this.controller = new FpsController(this.camera, this.renderer.domElement);
    this.avatars = new Avatars(this.scene);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  pose(): Pose {
    const p = this.controller.position;
    return { position: [p.x, p.y, p.z], yaw: this.controller.yaw, pitch: this.controller.pitch };
  }

  upsertParticipant(p: Participant): void {
    this.avatars.upsert(p);
  }

  removeParticipant(id: string): void {
    this.avatars.remove(id);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controller.dispose();
    this.avatars.clear();
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
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** M0 用の仮の空間。M1 以降はワールドのアウトプットから組み立てる。 */
  private buildWorld(): void {
    const sky = new THREE.Color("#C9DDF6");
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 30, 120);

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

    // 目印のプロシージャル形状
    const shapes: [THREE.BufferGeometry, string, [number, number, number]][] = [
      [new THREE.BoxGeometry(1, 1, 1), "#603D56", [-3, 0.5, -4]],
      [new THREE.SphereGeometry(0.6, 32, 16), "#FDD046", [0, 0.6, -6]],
      [new THREE.CylinderGeometry(0.5, 0.5, 1.4, 32), "#1F6B47", [3, 0.7, -4]],
    ];
    for (const [geo, color, pos] of shapes) {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
      m.position.set(...pos);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }
}
