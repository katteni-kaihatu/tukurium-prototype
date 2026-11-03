import * as THREE from "three";

export interface EffectSpec {
  kind: "spark";
  position: [number, number, number];
  color: string;
  size: number;
  life: number;
}

interface Live {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  size: number;
}

/**
 * 一時的な effect（ADR 0012。保存も物理もしない）。spark：当たった点で光る小さな玉が、
 * 大きくなりながら消える。
 */
export class EffectPlayer {
  private readonly live = new Set<Live>();
  private readonly geometry = new THREE.SphereGeometry(0.5, 12, 8);

  constructor(private readonly scene: THREE.Scene) {}

  spawn(e: EffectSpec): void {
    if (this.live.size >= 64) return;
    const material = new THREE.MeshBasicMaterial({
      color: e.color,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.set(...e.position);
    mesh.scale.setScalar(e.size);
    mesh.renderOrder = 10;
    this.scene.add(mesh);
    this.live.add({ mesh, age: 0, life: e.life, size: e.size });
  }

  update(dt: number): void {
    for (const fx of this.live) {
      fx.age += dt;
      const t = fx.age / fx.life;
      if (t >= 1) {
        this.scene.remove(fx.mesh);
        (fx.mesh.material as THREE.Material).dispose();
        this.live.delete(fx);
        continue;
      }
      fx.mesh.scale.setScalar(fx.size * (1 + t * 1.5));
      (fx.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    }
  }

  dispose(): void {
    for (const fx of this.live) {
      this.scene.remove(fx.mesh);
      (fx.mesh.material as THREE.Material).dispose();
    }
    this.live.clear();
    this.geometry.dispose();
  }
}
