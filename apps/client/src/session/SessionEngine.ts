import type { Participant } from "@tukurium/shared";
import * as THREE from "three";
import { CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import { PanelSpace } from "../panels/PanelSpace";
import { RemotePanels } from "../panels/RemotePanels";
import { AudioPlayer } from "../render/AudioPlayer";
import { EffectPlayer } from "../render/EffectPlayer";
import { Avatars } from "./Avatars";
import { FpsController } from "./FpsController";
import { createGridGround } from "./GridGround";

export interface Pose {
  position: [number, number, number];
  yaw: number;
  pitch: number;
}

/**
 * セッションの 3D 空間。描画ループ・FPS 操作・参加者表示を持つ。
 * React からは mount / dispose だけを呼ぶ（シーンを React の状態で管理しない）。
 */
/** 先にボタンを引き受ける相手（claimPointer） */
export interface PointerClaimer {
  down(button: number): boolean;
  up(button: number): void;
}

/** 撮影の背景（空の色。空間の背景の真ん中あたり） */
const SHOT_SKY = new THREE.Color("#DCE7F3");

export class SessionEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
  readonly controller: FpsController;
  readonly avatars: Avatars;
  readonly panels: PanelSpace;
  readonly remotePanels: RemotePanels;
  readonly audio: AudioPlayer;
  readonly effects: EffectPlayer;
  private readonly cssRenderer = new CSS3DRenderer();

  private readonly clock = new THREE.Clock();
  private readonly frameListeners = new Set<(dt: number) => void>();
  private readonly pointerListeners = new Set<(button: number, phase: "down" | "up") => void>();
  /** 右クリックを押したままホイールしたとき（前後の移動、メートル。正で奥へ） */
  private readonly holdWheelListeners = new Set<(meters: number) => void>();
  /** 右クリックを押しているか。離すか、空間から出たら手を放す */
  private rightButton = false;
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
    // パネルの中身にフォーカスが移ると、ブラウザが空間の入れ物を勝手にスクロールして、
    // パネルがずれて見える（付属パネルの開け閉めで起きた）。入れ物は常に動かさない
    const keepStill = (el: HTMLElement) => {
      el.addEventListener("scroll", () => {
        if (el.scrollLeft !== 0 || el.scrollTop !== 0) el.scrollTo(0, 0);
      });
    };
    keepStill(css);
    for (const child of Array.from(css.children)) keepStill(child as HTMLElement);
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
    document.addEventListener("pointerlockchange", this.onLockChange);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("contextmenu", this.onContextMenu);
    document.addEventListener("wheel", this.onWheel, { passive: false });
    this.avatars = new Avatars(this.scene);
    this.remotePanels = new RemotePanels(this.scene, this.avatars);
    this.audio = new AudioPlayer(this.scene, this.camera);
    this.effects = new EffectPlayer(this.scene);

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

  /**
   * ほかより先にボタンを引き受ける相手（サムネイルのカメラを持つ、など。ADR 0046）。
   * down で true を返すと、その押下はほかの相手（onPointer）へ渡さず、離したときもその相手にだけ渡す。
   */
  claimPointer(claimer: PointerClaimer): () => void {
    this.claimers.add(claimer);
    return () => {
      this.claimers.delete(claimer);
      for (const [b, c] of this.claimed) if (c === claimer) this.claimed.delete(b);
    };
  }
  private readonly claimers = new Set<PointerClaimer>();
  /** 引き受けられた押下（ボタン → 相手） */
  private readonly claimed = new Map<number, PointerClaimer>();

  /**
   * 撮影用のカメラで描く（サムネイル。ADR 0046）。手伝いの表示（選択の枠・パネルの穴・人の姿など、
   * userData.noShot を付けたもの）は写さない。背景は空の色で塗る。
   */
  renderShot(camera: THREE.Camera, target: THREE.WebGLRenderTarget): void {
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.userData.noShot && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    });
    const clear = this.renderer.getClearColor(new THREE.Color());
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(SHOT_SKY, 1);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(clear, alpha);
    for (const o of hidden) o.visible = true;
  }

  /** 右クリックを押したままホイールしたとき。戻り値で解除。 */
  onHoldWheel(fn: (meters: number) => void): () => void {
    this.holdWheelListeners.add(fn);
    return () => this.holdWheelListeners.delete(fn);
  }

  pose(): Pose {
    const p = this.controller.position;
    return { position: [p.x, p.y, p.z], yaw: this.controller.yaw, pitch: this.controller.pitch };
  }

  /** 自分を別の場所へ移す（独立した空間やポータル） */
  teleport(position: [number, number, number], yaw = 0): void {
    this.controller.position.set(...position);
    this.controller.yaw = yaw;
  }

  upsertParticipant(p: Participant): void {
    this.avatars.upsert(p);
  }

  setParticipantPose(id: string, position: Pose["position"], yaw: number, pitch: number): void {
    this.avatars.setPose(id, position, yaw, pitch);
  }

  /** 道具を装備している参加者（ワークスペースの再生とセッションの世界から、それぞれ届く。ADR 0053） */
  private readonly equipped = new Map<string, Set<string>>();
  setEquippedPlayers(source: "workspace" | "session", players: Set<string>): void {
    this.equipped.set(source, players);
    const all = new Set<string>();
    for (const set of this.equipped.values()) for (const p of set) all.add(p);
    this.avatars.setEquipped(all);
  }

  removeParticipant(id: string): void {
    this.avatars.remove(id);
  }

  dispose(): void {
    this.disposed = true;
    this.container.removeEventListener("click", this.onContainerClick);
    document.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("contextmenu", this.onContextMenu);
    document.removeEventListener("wheel", this.onWheel);
    this.frameListeners.clear();
    this.pointerListeners.clear();
    this.holdWheelListeners.clear();
    this.panels.dispose();
    this.cssRenderer.domElement.remove();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controller.dispose();
    this.avatars.clear();
    this.remotePanels.dispose();
    this.audio.dispose();
    this.effects.dispose();
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
    // 照準が 3D のパネルに乗っていたら、照準の見た目を変える（クリックがパネルに届く合図）
    const aim = this.controller.locked && this.aimedPanelElement() ? "panel" : "";
    if ((this.container.dataset.aim ?? "") !== aim) this.container.dataset.aim = aim;
    this.avatars.update(dt);
    this.effects.update(dt);
    this.remotePanels.update();
    this.panels.update(this.camera);
    for (const fn of this.frameListeners) fn(dt);
    this.renderer.render(this.scene, this.camera);
    this.cssRenderer.render(this.scene, this.camera);
  };

  // ---------------------------------------------------------------------------
  // マウス：空間に入っている（ポインターロック中）ときは照準（画面の中央）で操作する。
  // - 照準の先が 3D のパネルなら、左クリックはパネルへ渡し、右クリックを押している間パネルを持つ
  // - それ以外は、左右のボタンを空間の入力として渡す（左：撃つ・選ぶ、右：押している間持つ）
  // 空間に入っていないときは、パネルを直接クリックでき、右クリックを押している間動かせる。

  /** ポインターの位置（ロック中は画面の中央） */
  private mouse = { x: 0, y: 0 };
  /** 照準でクリックを渡している要素（mousedown の相手） */
  private pressed: Element | null = null;
  /** 照準のクリックが、何回目の連続クリックか（1 回・2 回・3 回） */
  private aimedDetail = 1;
  /** 連続クリックの 1 回目。あいだに別のパネルが被さっても、同じ相手へ dblclick を渡す */
  private clickAnchor: Element | null = null;
  private clickAnchorAt = 0;
  private clickAnchorYaw = 0;
  private clickAnchorPitch = 0;

  private ndc = (): THREE.Vector2 => {
    if (this.controller.locked) return new THREE.Vector2(0, 0);
    const r = this.container.getBoundingClientRect();
    return new THREE.Vector2(
      ((this.mouse.x - r.left) / r.width) * 2 - 1,
      -(((this.mouse.y - r.top) / r.height) * 2 - 1),
    );
  };

  private center(): { x: number; y: number } {
    const r = this.container.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** 照準の先にある、3D のパネルの中の要素 */
  aimedPanelElement(): Element | null {
    const c = this.center();
    const el = document.elementFromPoint(c.x, c.y);
    return this.panels.idOf(el) ? el : null;
  }

  private onMouseDown = (e: MouseEvent): void => {
    // パネルへ渡すために自分で出したイベントは扱わない（自分に返ってきて繰り返さないように）
    if (!e.isTrusted) return;
    if (e.button === 2) this.rightButton = true;
    if (!this.controller.locked) {
      // 3D のパネルの右下のつまみ：押している間、ポインターの先まで大きさを変える
      if (e.button === 0 && this.startPanelResize(e.target as Element)) {
        this.mouse = { x: e.clientX, y: e.clientY };
        e.preventDefault();
        return;
      }
      // 3D のパネルを、右クリックを押している間持つ
      if (e.button === 2) {
        const id = this.panels.idOf(e.target as Element);
        if (id) {
          this.mouse = { x: e.clientX, y: e.clientY };
          this.panels.startMove(id, this.camera, this.ndc);
          e.preventDefault();
        }
      }
      return;
    }
    const el = this.aimedPanelElement();
    if (el) {
      if (e.button === 2) {
        const id = this.panels.idOf(el);
        if (id) this.panels.startMove(id, this.camera, this.ndc);
      } else if (e.button === 0 && this.startPanelResize(el)) {
        // 照準でつまみを押したら、押している間、照準の先まで大きさを変える
      } else if (e.button === 0) {
        const target = this.aimedClickTarget(el);
        this.pressed = target;
        this.forwardAimed(target, "down", this.aimedDetail);
        const focusable = target.closest<HTMLElement>(
          "input, textarea, select, button, a[href], [contenteditable='true'], [tabindex]",
        );
        focusable?.focus();
      }
      return;
    }
    for (const c of this.claimers) {
      if (c.down(e.button)) {
        this.claimed.set(e.button, c);
        return;
      }
    }
    for (const fn of this.pointerListeners) fn(e.button, "down");
  };

  /**
   * 右クリックを離した。パネルか、持っている物を、見えている位置に置く。
   * 空間から出た直後は locked がすでに false なので、leaving のときも放す。
   */
  private releaseRight(leaving = false): void {
    if (!this.rightButton) return;
    this.rightButton = false;
    const claimer = this.claimed.get(2);
    if (claimer) {
      this.claimed.delete(2);
      claimer.up(2);
      return;
    }
    if (this.panels.isMoving) {
      this.panels.endMove();
      return;
    }
    if (!leaving && !this.controller.locked) return;
    for (const fn of this.pointerListeners) fn(2, "up");
  }

  /** 空間から出たとき、押しっぱなしの右クリックを離したことにする */
  private onLockChange = (): void => {
    if (!this.controller.locked) this.releaseRight(true);
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (!e.isTrusted) return;
    if (e.button === 0 && this.panels.isResizing) {
      this.panels.endResize();
      return;
    }
    if (e.button === 2) {
      this.releaseRight();
      return;
    }
    if (!this.controller.locked) return;
    const claimer = this.claimed.get(e.button);
    if (claimer) {
      this.claimed.delete(e.button);
      claimer.up(e.button);
      return;
    }
    if (e.button === 0 && this.pressed) {
      // 押した相手へ離す。離す瞬間の照準は、あいだに開いたパネルで別の要素になる
      this.forwardAimed(this.pressed, "up", this.aimedDetail);
      this.pressed = null;
      return;
    }
    for (const fn of this.pointerListeners) fn(e.button, "up");
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.controller.locked) this.mouse = { x: e.clientX, y: e.clientY };
  };

  /** 要素が 3D のパネルの大きさを変えるつまみなら、大きさを変え始める */
  private startPanelResize(el: Element | null): boolean {
    if (!el?.closest("[data-panel-resize]")) return false;
    const id = this.panels.idOf(el);
    return id !== null && this.panels.startResize(id, this.camera, this.ndc);
  }

  /** 空間の中の右クリック（持つ・パネルを動かす）でメニューを出さない */
  private onContextMenu = (e: MouseEvent): void => {
    if (this.controller.locked || this.container.contains(e.target as Node)) e.preventDefault();
  };

  /**
   * 連続クリックの相手。
   * 1 回目で別のパネル（詳細など）が開くと、2 回目の照準はそのパネルに乗ってしまう。
   * 視点が動いておらず、照準が別のパネルに移ったときだけ、最初のパネルへ届ける。
   * 同じパネルの中（コードの別の文字など）は、いま照準がある要素へ届ける。
   */
  private aimedClickTarget(el: Element): Element {
    const now = performance.now();
    const yaw = this.controller.yaw;
    const pitch = this.controller.pitch;
    const anchor = this.clickAnchor;
    const still =
      !!anchor?.isConnected &&
      now - this.clickAnchorAt < 500 &&
      Math.abs(yaw - this.clickAnchorYaw) < 0.03 &&
      Math.abs(pitch - this.clickAnchorPitch) < 0.03;
    const anchorPanel = anchor ? this.panels.idOf(anchor) : null;
    const covered = still && anchorPanel !== null && anchorPanel !== this.panels.idOf(el);
    if (covered && anchor) {
      this.aimedDetail = Math.min(3, this.aimedDetail + 1);
      return anchor;
    }
    this.aimedDetail = still ? Math.min(3, this.aimedDetail + 1) : 1;
    if (!still) {
      this.clickAnchorAt = now;
      this.clickAnchorYaw = yaw;
      this.clickAnchorPitch = pitch;
    }
    this.clickAnchor = el;
    return el;
  }

  /**
   * 照準のクリックをパネルへ渡す。
   * detail が 0 だとコードエディタは行全体の選択になる。
   * 2 回目のクリックでは dblclick も渡す（リソースのスクリプトを開くため）。
   */
  private forwardAimed(el: Element, phase: "down" | "up", detail: number): void {
    const c = this.center();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: c.x,
      clientY: c.y,
      button: 0,
      buttons: phase === "down" ? 1 : 0,
      detail,
    };
    if (phase === "down") {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", init));
      return;
    }
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
    if (detail === 2) el.dispatchEvent(new MouseEvent("dblclick", init));
  }

  /** ホイールの量をメートルにする。上へ回す（deltaY が負）と奥へ動かす */
  private wheelMeters(e: WheelEvent): number {
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= 400;
    return (-dy / 100) * 0.3;
  }

  /** 照準の先の 3D パネルをホイールでスクロールする。持っているときは前後に動かす */
  private onWheel = (e: WheelEvent): void => {
    const meters = this.wheelMeters(e);
    if (this.panels.isMoving) {
      e.preventDefault();
      this.panels.moveDepth(meters);
      return;
    }
    if (this.rightButton && this.controller.locked) {
      e.preventDefault();
      if (meters !== 0) for (const fn of this.holdWheelListeners) fn(meters);
      return;
    }
    if (!this.controller.locked) return;
    for (let el = this.aimedPanelElement(); el; el = el.parentElement) {
      const h = el as HTMLElement;
      const style = getComputedStyle(h);
      if (/(auto|scroll)/.test(style.overflowY) && h.scrollHeight > h.clientHeight) {
        h.scrollTop += e.deltaY;
        e.preventDefault();
        return;
      }
    }
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

    this.scene.add(createGridGround());
  }
}
