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

/** 大きさが届くまでの仮の大きさ（px） */
const DEFAULT_W = 420;
const DEFAULT_H = 280;
/** テクスチャの解像度（px あたりの画素）。大きなパネルでも辺が MAX_TEXTURE を超えないよう下げる */
const SCALE = 2;
const MAX_TEXTURE = 2048;

export class RemotePanelMesh extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  private readonly canvas: HTMLCanvasElement;
  private texture: THREE.CanvasTexture;
  private summary: PanelSummary;
  private width = DEFAULT_W;
  private height = DEFAULT_H;

  constructor(summary: PanelSummary, width = DEFAULT_W, height = DEFAULT_H) {
    const canvas = document.createElement("canvas");
    const texture = new THREE.CanvasTexture(canvas);
    super(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.canvas = canvas;
    this.texture = texture;
    this.summary = summary;
    this.resize(width, height, true);
  }

  /** 持ち主の画面での大きさ（px）に合わせる。空間では 1px = PANEL_METERS_PER_PX */
  resize(width: number, height: number, force = false): void {
    if (!force && width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.geometry.dispose();
    this.geometry = new THREE.PlaneGeometry(
      width * PANEL_METERS_PER_PX,
      height * PANEL_METERS_PER_PX,
    );
    const scale = this.textureScale();
    this.canvas.width = Math.max(1, Math.round(width * scale));
    this.canvas.height = Math.max(1, Math.round(height * scale));
    // 大きさの変わったキャンバスは、テクスチャを作り直さないと GPU 側に反映されない
    this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material.map = this.texture;
    this.material.needsUpdate = true;
    this.draw();
  }

  update(summary: PanelSummary): void {
    this.summary = summary;
    this.draw();
  }

  private textureScale(): number {
    return Math.min(SCALE, MAX_TEXTURE / Math.max(this.width, this.height));
  }

  private draw(): void {
    const summary = this.summary;
    const W = this.width;
    const H = this.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const scale = this.textureScale();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
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
      for (let i = 0; i < Math.min(4, Math.floor((H - 100) / 32)); i++) {
        ctx.fillStyle = "#E7E1D6";
        ctx.beginPath();
        ctx.roundRect(14, 100 + i * 32, W - 28 - (i % 2) * 90, 14, 7);
        ctx.fill();
      }
    } else {
      ctx.font = '13px ui-monospace, "SFMono-Regular", Menlo, monospace';
      const rows = Math.max(0, Math.floor((H - 50) / 22));
      summary.lines.slice(0, rows).forEach((line, i) => {
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
