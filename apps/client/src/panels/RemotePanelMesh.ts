import * as THREE from "three";
import { PANEL_METERS_PER_PX } from "./PanelSpace";

/**
 * 他の参加者のパネルの見え方。サーバーから届く「公開用の要約」だけを Canvas 2D で描く。
 * 実際の内容（コードや値）はクライアントに届かないので、ここから漏れることはない。
 */
export interface PanelSummary {
  title: string;
  owner: string;
  /** 閲覧権限がある場合だけ中身の簡易表示が入る。権限がなければ空。 */
  lines: string[];
  /** 閲覧権限がない（「作業している」ことだけ見せる） */
  restricted: boolean;
}

const W = 420;
const H = 280;
const SCALE = 2; // テクスチャの解像度（px あたりの画素）

export class RemotePanelMesh extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;

  constructor(summary: PanelSummary) {
    const canvas = document.createElement("canvas");
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    super(
      new THREE.PlaneGeometry(W * PANEL_METERS_PER_PX, H * PANEL_METERS_PER_PX),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.canvas = canvas;
    this.texture = texture;
    this.update(summary);
  }

  update(summary: PanelSummary): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "rgba(255,253,249,0.94)";
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 14);
    ctx.fill();

    ctx.fillStyle = "#F3EAF0";
    ctx.beginPath();
    ctx.roundRect(0, 0, W, 40, [14, 14, 0, 0]);
    ctx.fill();
    ctx.fillStyle = "#603D56";
    ctx.font = '700 15px "Zen Kaku Gothic New", system-ui, sans-serif';
    ctx.textBaseline = "middle";
    ctx.fillText(summary.restricted ? "作業中" : summary.title, 14, 20);
    ctx.fillStyle = "#8A8792";
    ctx.font = '500 12px "Zen Kaku Gothic New", system-ui, sans-serif';
    const ownerW = ctx.measureText(summary.owner).width;
    ctx.fillText(summary.owner, W - 14 - ownerW, 20);

    if (summary.restricted) {
      ctx.fillStyle = "#8A8792";
      ctx.font = '500 13px "Zen Kaku Gothic New", system-ui, sans-serif';
      ctx.fillText("内容は表示できません", 14, 70);
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = "#E7E1D6";
        ctx.beginPath();
        ctx.roundRect(14, 100 + i * 32, W - 28 - (i % 2) * 90, 14, 7);
        ctx.fill();
      }
    } else {
      ctx.font = '13px ui-monospace, "SFMono-Regular", Menlo, monospace';
      summary.lines.slice(0, 9).forEach((line, i) => {
        ctx.fillStyle = "#3A3942";
        ctx.fillText(line, 14, 64 + i * 22, W - 28);
      });
    }
    this.texture.needsUpdate = true;
  }

  override dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
