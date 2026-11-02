import type { World } from "@tukurium/eks";
import type { MaterialDef } from "@tukurium/repo-model";
import { buildWorld } from "@tukurium/runtime";
import * as THREE from "three";
import { EntityView } from "../render/EntityView";
import type { SessionEngine } from "../session/SessionEngine";
import { useWorkspace } from "./store";

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const UI_REFRESH_SEC = 0.2;

/** キー → 入力の動作名（スクリプトの onInput で受け取る） */
const KEY_ACTIONS: Record<string, string> = { KeyR: "reload", KeyE: "use", KeyF: "alt" };

/**
 * ワークスペースを 3D 空間に映す。
 * - Edit：制作データから組み立てた World を表示。クロスヘアのクリックで Entity を選ぶ。
 * - Play：Simulation を固定ステップで進め、その World を表示。クリックやキーを入力として渡す。
 * 編集空間はアウトプットの物体全体を囲む境界で示す（要件 §6「編集対象の表示」）。
 */
export class WorkspaceController {
  private readonly view = new EntityView();
  private readonly bounds: THREE.LineSegments;
  private readonly selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x603d56);
  private readonly raycaster = new THREE.Raycaster();
  private editWorld: World | null = null;
  private editKey = "";
  private materials: MaterialDef[] = [];
  private materialsRev = -1;
  private accumulator = 0;
  private uiTimer = 0;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly engine: SessionEngine) {
    engine.scene.add(this.view.root);
    this.bounds = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xfdd046, transparent: true, opacity: 0.9 }),
    );
    this.bounds.visible = false;
    this.selectionBox.visible = false;
    engine.scene.add(this.bounds, this.selectionBox);

    this.disposers.push(
      engine.onFrame((dt) => this.update(dt)),
      engine.onPointer((button, phase) => this.onPointer(button, phase)),
    );
    useWorkspace.setState({ viewPoint: () => this.pointInFront(2) });
    this.disposers.push(() => useWorkspace.setState({ viewPoint: null }));
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    this.disposers.push(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.view.dispose();
    this.bounds.removeFromParent();
    this.bounds.geometry.dispose();
    this.selectionBox.removeFromParent();
  }

  private update(dt: number): void {
    const ws = useWorkspace.getState();
    const playing = ws.mode !== "edit" && ws.sim;
    // マテリアルの一覧は制作データが変わったときだけ取り直す
    if (this.materialsRev !== ws.rev) {
      this.materials = ws.project.materials();
      this.materialsRev = ws.rev;
    }
    const materials = this.materials;

    if (playing && ws.sim) {
      if (ws.mode === "play") {
        this.accumulator = Math.min(this.accumulator + dt, STEP * MAX_STEPS_PER_FRAME);
        while (this.accumulator >= STEP) {
          ws.sim.step(STEP);
          this.accumulator -= STEP;
        }
      }
      this.view.sync(ws.sim.world, { materials, holdCamera: this.engine.camera });
      this.uiTimer += dt;
      if (this.uiTimer > UI_REFRESH_SEC) {
        this.uiTimer = 0;
        useWorkspace.setState((s) => ({
          simRev: s.simRev + 1,
          systemStatus: ws.sim?.systemStatus() ?? [],
        }));
      }
    } else {
      const key = `${ws.rev}:${ws.outputId}`;
      if (key !== this.editKey || !this.editWorld) {
        this.editKey = key;
        this.editWorld = buildWorld(ws.project.snapshot(), ws.outputId).world;
      }
      this.view.sync(this.editWorld, { materials, holdCamera: null });
    }

    // 編集空間の境界（Edit のときだけ）
    const box = ws.mode === "edit" ? this.view.bounds() : null;
    this.bounds.visible = box !== null;
    if (box) {
      const size = box.getSize(new THREE.Vector3()).addScalar(0.3);
      this.bounds.position.copy(box.getCenter(new THREE.Vector3()));
      this.bounds.scale.copy(size);
    }

    // 選択中の Entity の枠
    const sel = ws.selection?.kind === "entity" ? this.view.objectOf(ws.selection.id) : undefined;
    this.selectionBox.visible = Boolean(sel) && ws.mode === "edit";
    if (sel && ws.mode === "edit") {
      this.selectionBox.setFromObject(sel);
    }
  }

  /** 視線の先 distance m の位置（編集空間の座標系、高さは 0.5m 以上） */
  private pointInFront(distance: number): [number, number, number] {
    const { origin, direction } = this.viewRay();
    const p = new THREE.Vector3(...origin).addScaledVector(
      new THREE.Vector3(...direction),
      distance,
    );
    const r = (n: number) => Math.round(n * 100) / 100;
    return [r(p.x), r(Math.max(p.y, 0.5)), r(p.z)];
  }

  private viewRay(): { origin: [number, number, number]; direction: [number, number, number] } {
    const cam = this.engine.camera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    // 編集空間の座標系へ（初版は原点に置いているが、移動しても正しく動くように）
    const local = this.view.root.worldToLocal(origin.clone());
    const localDir = this.view.root.worldToLocal(origin.clone().add(dir)).sub(local).normalize();
    return { origin: local.toArray(), direction: localDir.toArray() };
  }

  private onPointer(button: number, phase: "down" | "up"): void {
    const ws = useWorkspace.getState();
    if (ws.mode === "play" && ws.sim && button === 0) {
      ws.sim.input({ action: "fire", phase, player: "me", ...this.viewRay() });
      return;
    }
    if (ws.mode === "edit" && button === 0 && phase === "down") {
      this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.engine.camera);
      const id = this.view.pick(this.raycaster);
      ws.select(id ? { kind: "entity", id } : null);
    }
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const ws = useWorkspace.getState();
    if (e.code === "Tab" && e.type === "keydown") {
      e.preventDefault();
      ws.togglePanels();
      return;
    }
    const action = KEY_ACTIONS[e.code];
    if (!action || e.repeat || ws.mode !== "play" || !ws.sim) return;
    ws.sim.input({
      action,
      phase: e.type === "keydown" ? "down" : "up",
      player: "me",
      ...this.viewRay(),
    });
  }
}
