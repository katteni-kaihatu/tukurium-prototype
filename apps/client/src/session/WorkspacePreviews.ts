import { KokoStateRegistry, World, type WorldSnapshot } from "@tukurium/eks";
import type { MaterialDef } from "@tukurium/repo-model";
import type { WorkspacePreview } from "@tukurium/shared";
import * as THREE from "three";
import { useApp } from "../app/store";
import { EntityView } from "../render/EntityView";
import { workspaceAnchor } from "../workspace/anchor";
import { useWorkspace } from "../workspace/store";
import { enterSpace } from "../workspace/WorkspaceController";
import { makeLabel } from "./Avatars";
import type { SessionEngine } from "./SessionEngine";

/** ポータルに入ったとみなす距離（水平） */
const PORTAL_RADIUS = 1.2;

interface Entry {
  name: string;
  restricted: boolean;
  preview: WorkspacePreview;
  view: EntityView | null;
  box: THREE.LineSegments;
  label: THREE.Sprite;
  portal: THREE.Group | null;
}

/**
 * 自分が開いていないワークスペースの、編集中の見た目（要件 §8）。
 * - 閲覧できる：中身をそのまま表示する（独立した空間なら、セッションの区画にポータルを置く）
 * - 閲覧できない：セッションの区画に「作業中」の境界だけを出す
 * 中身はワークスペースのホストが送り、サーバーが権限で見せ分ける。
 */
export class WorkspacePreviews {
  private readonly root = new THREE.Group();
  /** テストから参照する */
  readonly entries = new Map<string, Entry>();
  /** 自分が開いているワークスペースが独立した空間のとき、そこへ入るポータル */
  private ownPortal: { key: string; group: THREE.Group } | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly engine: SessionEngine) {
    engine.scene.add(this.root);
    const client = useApp.getState().client;
    this.disposers.push(
      client.on((msg) => {
        if (msg.t === "ws.preview")
          this.set(msg.workspaceId, msg.name, msg.restricted, msg.preview);
        if (msg.t === "session.closed") this.clear();
      }),
      client.onWelcome(() => this.clear()),
      engine.onFrame(() => this.update()),
    );
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.clear();
    this.root.removeFromParent();
  }

  private set(id: string, name: string, restricted: boolean, preview: WorkspacePreview): void {
    this.remove(id);
    const view = !restricted && preview.world ? new EntityView() : null;
    if (view) {
      const world = new World(new KokoStateRegistry());
      world.restore(preview.world as WorldSnapshot);
      view.root.position.set(...preview.anchor);
      view.sync(world, { materials: preview.materials as MaterialDef[], holdCamera: null });
      this.root.add(view.root);
    }
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({
        color: restricted ? 0x8a8a8a : 0xfdd046,
        transparent: true,
        opacity: 0.8,
      }),
    );
    box.userData.workspaceId = id;
    const label = makeLabel(restricted ? "作業中" : `作業中：${name}`, "#3b3540");
    // ほかの作業の枠と札はサムネイルに写さない（ADR 0046）
    box.userData.noShot = true;
    label.userData.noShot = true;
    this.root.add(box, label);
    this.entries.set(id, { name, restricted, preview, view, box, label, portal: null });
  }

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.view?.root.removeFromParent();
    e.view?.dispose();
    for (const o of [e.box, e.label, e.portal]) if (o) disposeObject(o);
    this.entries.delete(id);
  }

  private clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
    if (this.ownPortal) disposeObject(this.ownPortal.group);
    this.ownPortal = null;
  }

  private update(): void {
    const session = useApp.getState().session;
    const workspaces = session?.workspaces ?? [];
    const open = useWorkspace.getState().workspaceId;
    const me = this.engine.controller.position;

    for (const [id, e] of this.entries) {
      // 閉じられたワークスペース・自分が開いたワークスペースの見た目は消す
      if (!workspaces.some((w) => w.id === id) || id === open) {
        this.remove(id);
        continue;
      }
      const { slot, portal } = workspaceAnchor(workspaces, id, e.preview.outputKind);
      const b = e.preview.bounds;
      // 閲覧できない人には、独立した空間の中身の代わりに、区画に境界だけを出す
      const offset = e.restricted
        ? new THREE.Vector3(...slot).sub(new THREE.Vector3(...e.preview.anchor))
        : new THREE.Vector3();
      const center = b ? new THREE.Vector3(...b.center).add(offset) : new THREE.Vector3(...slot);
      const size = b ? new THREE.Vector3(...b.size).addScalar(0.3) : new THREE.Vector3(1, 1, 1);
      e.box.position.copy(center);
      e.box.scale.copy(size);
      e.label.position.set(center.x, center.y + size.y / 2 + 0.35, center.z);

      if (e.preview.isolated && !e.restricted) {
        e.portal ??= this.makePortal(`ポータル：${e.name}`);
        e.portal.position.set(...portal);
        if (near(me, portal)) enterSpace(this.engine, e.preview.anchor);
      } else if (e.portal) {
        disposeObject(e.portal);
        e.portal = null;
      }
    }

    // 自分が開いているワークスペースが独立した空間なら、区画にポータルを置く（戻ってこられるように）
    const anchor = useWorkspace.getState().anchor;
    const key = anchor?.isolated ? JSON.stringify(anchor) : "";
    if (key !== (this.ownPortal?.key ?? "")) {
      if (this.ownPortal) disposeObject(this.ownPortal.group);
      this.ownPortal = null;
      if (anchor?.isolated) {
        const name = workspaces.find((w) => w.id === open)?.name ?? "";
        const group = this.makePortal(`ポータル：${name}`);
        group.position.set(...anchor.portal);
        this.ownPortal = { key, group };
      }
    }
    if (anchor?.isolated && near(me, anchor.portal)) enterSpace(this.engine, anchor.position);
  }

  private makePortal(text: string): THREE.Group {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.08, 12, 48),
      new THREE.MeshStandardMaterial({ color: "#7a5fd0", emissive: "#4a2fa0", roughness: 0.4 }),
    );
    ring.position.y = 1.1;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.95, 48),
      new THREE.MeshBasicMaterial({
        color: "#b9a8f0",
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      }),
    );
    disc.position.y = 1.1;
    const label = makeLabel(text, "#4a2fa0");
    label.position.y = 2.45;
    group.add(ring, disc, label);
    this.root.add(group);
    return group;
  }
}

function near(p: THREE.Vector3, at: [number, number, number]): boolean {
  return Math.hypot(p.x - at[0], p.z - at[2]) < PORTAL_RADIUS;
}

function disposeObject(o: THREE.Object3D): void {
  o.removeFromParent();
  o.traverse((c) => {
    if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Sprite) {
      c.geometry.dispose();
      const m = c.material as THREE.Material & { map?: THREE.Texture | null };
      m.map?.dispose();
      m.dispose();
    }
  });
}
