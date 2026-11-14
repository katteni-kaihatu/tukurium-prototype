import { equippableAt, playersWithEquipment } from "@tukurium/runtime";
import * as THREE from "three";
import { useApp } from "../app/store";
import { EntityView } from "../render/EntityView";
import { useWorkspace } from "../workspace/store";
import { EQUIP_REACH, equipsSomething, holdsSomething } from "../workspace/WorkspaceController";
import { openRing, provideRingItems } from "./ringMenuModel";
import type { SessionEngine } from "./SessionEngine";
import {
  queueSessionEffects,
  queueSessionSounds,
  sendSessionFrame,
  useSessionWorld,
} from "./sessionWorld";

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const FRAME_SEC = 1 / 15;
const KEY_ACTIONS: Record<string, string> = { KeyR: "reload", KeyE: "use", KeyF: "alt" };

/**
 * セッションの世界（配置された実体）を表示し、ホストなら実行する。
 * 入力は、ワークスペースを再生していないときだけセッションの世界へ送る。
 * ワークスペースを開いて編集しているときのクリックは「選ぶ」なので、
 * パネルを隠す（Tab）か、ワークスペースを閉じているときに撃てる。
 */
export class SessionWorldController {
  private readonly view = new EntityView();
  private accumulator = 0;
  private frameTimer = 0;
  private uiTimer = 0;
  private holdTimer = 0;
  private turning = false;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly engine: SessionEngine) {
    engine.scene.add(this.view.root);
    this.disposers.push(
      engine.solids.bind("session", () => {
        const world = useSessionWorld.getState().view()?.world;
        return world ? { world, origin: [0, 0, 0] } : null;
      }),
      engine.onFrame((dt) => this.update(dt)),
      engine.onHoldWheel((meters) => {
        if (useWorkspace.getState().mode === "edit") this.input("reach", "down", [meters, 0]);
      }),
      engine.onPointer((button, phase) => {
        // 持っているときの左クリックは、撃たずに傾きを直す
        if (button === 0 && phase === "down" && this.holding()) {
          this.input("align", "down");
          return;
        }
        // 置いてある道具への左クリックは、撃たずにリングメニューで「装備する」を選べるようにする（ADR 0053）
        if (button === 0 && phase === "down" && this.routesHere() && this.offerEquip()) {
          this.skipFireUp = true;
          return;
        }
        if (button === 0 && phase === "up" && this.skipFireUp) {
          this.skipFireUp = false;
          return;
        }
        if (button === 0 && this.routesHere()) this.input("fire", phase);
        // 右クリック：押している間 Grabbable を持つ（ワークスペースを再生していなければ、編集中でも持てる）
        if (button === 2 && useWorkspace.getState().mode === "edit") this.input("grab", phase);
      }),
    );
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // 持っている間の E は use ではなく、マウスで物を回す
      if (e.code === "KeyE" && this.holding()) {
        if (e.type === "keydown") this.beginTurn();
        else this.endTurn();
        return;
      }
      const action = KEY_ACTIONS[e.code];
      if (!action || e.repeat || !this.routesHere()) return;
      this.input(action, e.type === "keydown" ? "down" : "up");
    };
    // リングメニュー（T）の「装備を外す」：セッションの世界で、自分が装備しているとき（ADR 0053）
    this.disposers.push(
      provideRingItems(() => {
        if (useWorkspace.getState().mode !== "edit") return [];
        const world = useSessionWorld.getState().view()?.world;
        const me = useApp.getState().me?.id;
        return [
          {
            id: "unequip",
            label: "装備を外す",
            hint: "装備していません",
            enabled: !!world && !!me && equipsSomething(world, me),
            run: () => this.input("unequip", "down"),
          },
        ];
      }),
    );
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    this.disposers.push(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    });
  }

  dispose(): void {
    this.endTurn();
    for (const d of this.disposers) d();
    this.view.dispose();
  }

  private routesHere(): boolean {
    const ws = useWorkspace.getState();
    if (ws.mode !== "edit") return false; // ワークスペースの再生が優先
    return !ws.project || ws.panelsHidden;
  }

  private input(action: string, phase: "down" | "up", pointer?: [number, number]): void {
    const cam = this.engine.camera;
    const origin = cam.getWorldPosition(new THREE.Vector3()).toArray() as [number, number, number];
    const direction = cam.getWorldDirection(new THREE.Vector3()).toArray() as [
      number,
      number,
      number,
    ];
    useSessionWorld.getState().input({
      action,
      phase,
      origin,
      direction,
      player: useApp.getState().me?.id ?? "me",
      ...(pointer ? { pointer } : {}),
    });
  }

  /** 道具を左クリックしてリングメニューを開いたとき、その押下を離す fire を送らない */
  private skipFireUp = false;
  private readonly raycaster = new THREE.Raycaster();

  /** 照準の先（3m 以内）に、いま装備できる道具があれば、リングメニューで「装備する」を選べるようにする */
  private offerEquip(): boolean {
    const world = useSessionWorld.getState().view()?.world;
    const me = useApp.getState().me?.id;
    if (!world || !me) return false;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.engine.camera);
    this.raycaster.far = EQUIP_REACH;
    if (!equippableAt(world, this.view.pick(this.raycaster))) return false;
    openRing([
      {
        id: "equip",
        label: equipsSomething(world, me) ? "持ち替える" : "装備する",
        enabled: true,
        run: () => this.input("equip", "down"),
      },
    ]);
    return true;
  }

  /** セッションの世界で、自分が物を持っているか（ワークスペースの再生中はそちらが優先） */
  private holding(): boolean {
    if (useWorkspace.getState().mode !== "edit") return false;
    const world = useSessionWorld.getState().view()?.world;
    const me = useApp.getState().me?.id;
    return !!world && !!me && holdsSomething(world, me);
  }

  /** E を押している間、見回すのを止めて、マウスで持っている物を回す */
  private beginTurn(): void {
    this.turning = true;
    this.engine.controller.setLookOverride((dx, dy) => {
      const s = this.engine.controller.sensitivity;
      this.input("twist", "down", [-dx * s, -dy * s]);
    });
  }

  private endTurn(): void {
    if (!this.turning) return;
    this.turning = false;
    this.engine.controller.setLookOverride(null);
  }

  private update(dt: number): void {
    const s = useSessionWorld.getState();
    if (s.isHost && s.sim) {
      this.accumulator = Math.min(this.accumulator + dt, STEP * MAX_STEPS_PER_FRAME);
      while (this.accumulator >= STEP) {
        s.sim.step(STEP);
        this.accumulator -= STEP;
      }
      const sounds = s.sim.drainSounds();
      for (const snd of sounds) this.engine.audio.play(snd.asset, snd.position, snd.volume);
      if (sounds.length > 0) queueSessionSounds(sounds);
      const effects = s.sim.drainEffects();
      for (const fx of effects) this.engine.effects.spawn(fx);
      if (effects.length > 0) queueSessionEffects(effects);
      this.frameTimer += dt;
      if (this.frameTimer > FRAME_SEC) {
        this.frameTimer = 0;
        sendSessionFrame();
      }
      this.uiTimer += dt;
      if (this.uiTimer > 0.5) {
        this.uiTimer = 0;
        useSessionWorld.setState({ status: s.sim.systemStatus() });
      }
    }
    if (!s.isHost && s.incomingSounds.length > 0) {
      for (const snd of s.incomingSounds)
        this.engine.audio.play(snd.asset, snd.position, snd.volume);
      useSessionWorld.setState({ incomingSounds: [] });
    }
    if (!s.isHost && s.incomingEffects.length > 0) {
      for (const fx of s.incomingEffects) this.engine.effects.spawn(fx);
      useSessionWorld.setState({ incomingEffects: [] });
    }
    if (this.turning && !this.holding()) this.endTurn();
    const view = s.view();
    // 装備している人のアバターは、腕を前に出して構える（ADR 0053）
    this.engine.setEquippedPlayers("session", view ? playersWithEquipment(view.world) : new Set());
    if (!view) {
      this.view.root.visible = false;
      return;
    }
    this.view.root.visible = true;
    // ワークスペースを再生中は、手に持つ物はワークスペースの方を優先する
    const holdCamera = useWorkspace.getState().mode === "edit" ? this.engine.camera : null;
    this.view.sync(view.world, {
      materials: view.materials,
      holdCamera,
      player: useApp.getState().me?.id,
    });
    // 持っている物があれば、視点を間隔をあけて送る
    this.holdTimer += dt;
    if (this.holdTimer > 0.1) {
      this.holdTimer = 0;
      const me = useApp.getState().me?.id;
      if (me && (holdsSomething(view.world, me) || equipsSomething(view.world, me)))
        this.input("hold", "down");
    }
  }
}
