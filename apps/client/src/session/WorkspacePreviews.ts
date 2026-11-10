import { KokoStateRegistry, World, type WorldSnapshot } from "@tukurium/eks";
import type { MaterialDef } from "@tukurium/repo-model";
import type { WorkspacePreview } from "@tukurium/shared";
import * as THREE from "three";
import { useApp } from "../app/store";
import { EntityView } from "../render/EntityView";
import { exitPortalAt, PORTAL_RADIUS, workspaceAnchor } from "../workspace/anchor";
import { useWorkspace } from "../workspace/store";
import { enterSpace } from "../workspace/WorkspaceController";
import { makeLabel } from "./Avatars";
import type { SessionEngine } from "./SessionEngine";

interface Entry {
  name: string;
  restricted: boolean;
  preview: WorkspacePreview;
  view: EntityView | null;
  box: THREE.LineSegments;
  label: THREE.Sprite;
  /** セッションの区画から、独立した空間へ入る */
  portal: THREE.Group | null;
  /** 独立した空間から、セッションへ戻る */
  exit: THREE.Group | null;
}

/**
 * 自分が開いていないワークスペースの、編集中の見た目（要件 §8）。
 * - 閲覧できる：中身をそのまま表示する（独立した空間なら、セッションの区画に入り口を、中に出口を置く）
 * - 閲覧できない：セッションの区画に「作業中」の境界だけを出す
 * 中身はワークスペースのホストが送り、サーバーが権限で見せ分ける。
 */
export class WorkspacePreviews {
  private readonly root = new THREE.Group();
  /** テストから参照する */
  readonly entries = new Map<string, Entry>();
  /** 自分が開いているワークスペースが独立した空間のとき、入り口と出口 */
  private ownGate: { key: string; entrance: THREE.Group; exit: THREE.Group } | null = null;
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
    this.entries.set(id, { name, restricted, preview, view, box, label, portal: null, exit: null });
  }

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.view?.root.removeFromParent();
    e.view?.dispose();
    for (const o of [e.box, e.label, e.portal, e.exit]) if (o) disposeObject(o);
    this.entries.delete(id);
  }

  private clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.disposeOwnGate();
  }

  private disposeOwnGate(): void {
    if (!this.ownGate) return;
    disposeObject(this.ownGate.entrance);
    disposeObject(this.ownGate.exit);
    this.ownGate = null;
  }

  private update(): void {
    const session = useApp.getState().session;
    const workspaces = session?.workspaces ?? [];
    const open = useWorkspace.getState().workspaceId;
    // フレーム開始時の位置で、一つのポータルだけ使う
    const here = this.engine.controller.position.clone();
    let used = false;
    const stepThrough = (at: [number, number, number], dest: [number, number, number]) => {
      if (used || !near(here, at)) return;
      used = true;
      enterSpace(this.engine, dest);
    };

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
        const exitAt = exitPortalAt(e.preview.anchor);
        e.portal ??= this.makePortal(`ポータル：${e.name}`, ENTRANCE);
        e.portal.position.set(...portal);
        e.exit ??= this.makePortal("出口：セッション", EXIT);
        e.exit.position.set(...exitAt);
        stepThrough(portal, e.preview.anchor);
        stepThrough(exitAt, slot);
      } else {
        if (e.portal) disposeObject(e.portal);
        if (e.exit) disposeObject(e.exit);
        e.portal = null;
        e.exit = null;
      }
    }

    // 自分が開いているワークスペースが独立した空間なら、区画に入り口を、中に出口を置く。
    // 名前はワークスペースの一覧が遅れて届くことがあるので、札のキーに含める。
    const anchor = useWorkspace.getState().anchor;
    const name = workspaces.find((w) => w.id === open)?.name ?? "";
    const key = anchor?.isolated ? `${name}:${JSON.stringify(anchor)}` : "";
    if (key !== (this.ownGate?.key ?? "")) {
      this.disposeOwnGate();
      if (anchor?.isolated) {
        const entrance = this.makePortal(`ポータル：${name}`, ENTRANCE);
        entrance.position.set(...anchor.portal);
        const exit = this.makePortal("出口：セッション", EXIT);
        exit.position.set(...exitPortalAt(anchor.position));
        this.ownGate = { key, entrance, exit };
      }
    }
    if (anchor?.isolated) {
      stepThrough(anchor.portal, anchor.position);
      stepThrough(exitPortalAt(anchor.position), anchor.slot);
    }
  }

  private makePortal(text: string, tone: PortalTone): THREE.Group {
    const group = new THREE.Group();
    group.name = tone === EXIT ? "exit-portal" : "entrance-portal";
    // ポータルは編集の手伝いなので、サムネイルに写さない（ADR 0046）
    group.userData.noShot = true;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.08, 12, 48),
      new THREE.MeshStandardMaterial({
        color: tone.ring,
        emissive: tone.emissive,
        roughness: 0.4,
      }),
    );
    ring.position.y = 1.1;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.95, 48),
      new THREE.MeshBasicMaterial({
        color: tone.disc,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      }),
    );
    disc.position.y = 1.1;
    const label = makeLabel(text, tone.label);
    label.position.y = 2.45;
    group.add(ring, disc, label);
    this.root.add(group);
    return group;
  }
}

interface PortalTone {
  ring: string;
  emissive: string;
  disc: string;
  label: string;
}

/** 独立した空間へ入る（紫） */
const ENTRANCE: PortalTone = {
  ring: "#7a5fd0",
  emissive: "#4a2fa0",
  disc: "#b9a8f0",
  label: "#4a2fa0",
};

/** セッションへ戻る（緑） */
const EXIT: PortalTone = {
  ring: "#1f6b47",
  emissive: "#145c38",
  disc: "#b7e0c8",
  label: "#145c38",
};

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
