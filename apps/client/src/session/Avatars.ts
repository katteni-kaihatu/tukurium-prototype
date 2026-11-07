import type { Participant } from "@tukurium/shared";
import * as THREE from "three";

const PALETTE = [
  { bg: "#F3EAF0", fg: "#603D56" },
  { bg: "#E5F3EC", fg: "#1F6B47" },
  { bg: "#E6ECF8", fg: "#2F4A9C" },
  { bg: "#FFF1BF", fg: "#6B5310" },
];

function colorFor(id: string): { bg: string; fg: string } {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? { bg: "#F3EAF0", fg: "#603D56" };
}

interface Avatar {
  root: THREE.Group;
  head: THREE.Group;
  /** 右腕（肩を軸に回す）。道具を装備している間は前に出して構える */
  arm: THREE.Group;
  target: THREE.Vector3;
  targetYaw: number;
  targetPitch: number;
}

/**
 * 他の参加者の位置と向きを示す簡易表示（アバター制作とは別物）。
 * カプセルの体、向きの分かる頭、名前札だけ。
 */
export class Avatars {
  private readonly avatars = new Map<string, Avatar>();
  /** 道具を装備している参加者（ADR 0053） */
  private equipped = new Set<string>();

  /** 道具を装備している参加者を入れ替える。腕は update で少しずつ動かす */
  setEquipped(ids: Set<string>): void {
    this.equipped = ids;
  }

  constructor(private readonly scene: THREE.Scene) {}

  upsert(p: Participant): void {
    let a = this.avatars.get(p.id);
    if (!a) {
      a = this.create(p);
      this.avatars.set(p.id, a);
      a.root.position.set(...p.position);
    }
    a.target.set(...p.position);
    a.targetYaw = p.yaw;
    a.targetPitch = p.pitch;
  }

  /** 既に表示している参加者の位置・向きを更新する。知らない参加者は無視する。 */
  setPose(id: string, position: [number, number, number], yaw: number, pitch: number): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.target.set(...position);
    a.targetYaw = yaw;
    a.targetPitch = pitch;
  }

  remove(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    this.scene.remove(a.root);
    a.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        const m = o.material as THREE.Material & { map?: THREE.Texture | null };
        m.map?.dispose();
        m.dispose();
      }
    });
    this.avatars.delete(id);
  }

  /** 参加者の（表示上の）位置と向き。いなければ undefined */
  poseOf(id: string): { position: [number, number, number]; yaw: number } | undefined {
    const a = this.avatars.get(id);
    if (!a) return undefined;
    const p = a.root.position;
    return { position: [p.x, p.y, p.z], yaw: a.root.rotation.y };
  }

  /** 表示中の参加者の位置（テスト・デバッグ用） */
  positions(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {};
    for (const [id, a] of this.avatars) out[id] = [a.target.x, a.target.y, a.target.z];
    return out;
  }

  clear(): void {
    for (const id of [...this.avatars.keys()]) this.remove(id);
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 12);
    for (const a of this.avatars.values()) {
      a.root.position.lerp(a.target, k);
      a.root.rotation.y += shortestAngle(a.root.rotation.y, a.targetYaw) * k;
      a.head.rotation.x += (a.targetPitch - a.head.rotation.x) * k;
    }
    // 腕：装備している間は視線の高さに合わせて前へ、そうでなければ下ろす
    for (const [id, a] of this.avatars) {
      const target = this.equipped.has(id) ? Math.PI / 2 + a.targetPitch * 0.8 : 0;
      a.arm.rotation.x += (target - a.arm.rotation.x) * k;
    }
  }

  private create(p: Participant): Avatar {
    const c = colorFor(p.id);
    const root = new THREE.Group();
    // 人の姿はサムネイルに写さない（ADR 0046）
    root.userData.noShot = true;
    const bodyMat = new THREE.MeshStandardMaterial({ color: c.bg, roughness: 0.7 });
    const accentMat = new THREE.MeshStandardMaterial({ color: c.fg, roughness: 0.5 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.8, 6, 16), bodyMat);
    body.position.y = 0.75;
    root.add(body);

    const head = new THREE.Group();
    head.position.y = 1.55;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), bodyMat.clone());
    head.add(skull);
    // 視線の向き（-Z）を示すバイザー
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.06), accentMat);
    visor.position.set(0, 0.02, -0.2);
    head.add(visor);
    root.add(head);

    // 右腕（体の右、肩の高さ。下ろした向き（-Y）から、前（-Z）へ回して構える）
    const arm = new THREE.Group();
    arm.position.set(0.32, 1.28, 0);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.42, 4, 10), bodyMat.clone());
    limb.position.y = -0.27;
    arm.add(limb);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), accentMat.clone());
    hand.position.y = -0.52;
    arm.add(hand);
    root.add(arm);

    const label = makeLabel(p.name, c.fg);
    label.position.y = 2.05;
    root.add(label);

    this.scene.add(root);
    return {
      root,
      head,
      arm,
      target: new THREE.Vector3(),
      targetYaw: p.yaw,
      targetPitch: p.pitch,
    };
  }
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = '700 40px "Zen Kaku Gothic New", system-ui, sans-serif';
  canvas.height = 64;
  if (ctx) {
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 40;
    ctx.font = font;
    ctx.fillStyle = "rgba(255,253,249,0.92)";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 32);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 20, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set((canvas.width / canvas.height) * 0.28, 0.28, 1);
  return sprite;
}
