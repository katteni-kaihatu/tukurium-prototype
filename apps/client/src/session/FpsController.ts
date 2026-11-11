import * as THREE from "three";

/** 足元の位置と移動希望から、ぶつかったあとの足元を返す。準備前は null（高さ 0 に留める） */
export interface MotionProbe {
  move(
    feet: [number, number, number],
    delta: [number, number, number],
    snap: boolean,
  ): { position: [number, number, number]; grounded: boolean } | null;
}

export interface FpsOptions {
  eyeHeight?: number;
  walkSpeed?: number;
  runSpeed?: number;
  jumpSpeed?: number;
  gravity?: number;
  /** マウス感度（ラジアン / px） */
  sensitivity?: number;
  /** 壁や床への当たり。無いあいだは、高さ 0 より下へ落ちない */
  probe?: MotionProbe | null;
}

/**
 * FPS 視点の移動。WASD で移動、マウスで見回す（ポインターロック中のみ）、Shift で走る、Space でジャンプ。
 * 当たり判定があるときは Collider と高さ 0 の地面に沿って動き、無いあいだは高さ 0 に留める。
 */
/** 足元から目までの高さ（m） */
export const EYE_HEIGHT = 1.6;
/** 視点のカメラの縦の画角（度）。他の人の 2D パネルを、その人の視界と同じ所に置くのにも使う */
export const CAMERA_FOV = 70;

export class FpsController {
  yaw = 0;
  pitch = 0;
  readonly position = new THREE.Vector3((Math.random() - 0.5) * 6, 0, 6 + Math.random() * 2);

  private readonly keys = new Set<string>();
  private velocityY = 0;
  /** 足元が何かに付いているか。付いているときだけジャンプできる */
  private grounded = true;
  private readonly opts: Required<Omit<FpsOptions, "probe">>;
  private readonly probe: MotionProbe | null;
  private readonly disposers: (() => void)[] = [];
  /** セットしている間、マウスは見回さず、この関数へ移動量（px）を渡す */
  private lookOverride: ((dx: number, dy: number) => void) | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    options: FpsOptions = {},
  ) {
    const { probe = null, ...rest } = options;
    this.probe = probe;
    this.opts = {
      eyeHeight: EYE_HEIGHT,
      walkSpeed: 3.5,
      runSpeed: 7,
      jumpSpeed: 4.5,
      // 剛体と同じ落下（solidShape の GRAVITY）
      gravity: 9.81,
      sensitivity: 0.0022,
      ...rest,
    };
    this.listen(window, "keydown", (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, "keyup", (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(window, "blur", () => {
      this.keys.clear();
      this.lookOverride = null;
    });
    this.listen(document, "mousemove", (e) => this.onMouseMove(e as MouseEvent));
    this.apply();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.element;
  }

  /** 見回す速さ（ラジアン / px） */
  get sensitivity(): number {
    return this.opts.sensitivity;
  }

  /**
   * マウスで見回すのを止める。fn には移動量（px）が渡る。
   * null で元に戻す。
   */
  setLookOverride(fn: ((dx: number, dy: number) => void) | null): void {
    this.lookOverride = fn;
  }

  lock(): void {
    if (!this.locked) void this.element.requestPointerLock();
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** メニューへ操作を渡すとき、押したままの移動キーを残さない。 */
  clearInput(): void {
    this.keys.clear();
  }

  update(dt: number): void {
    const forward = Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const strafe = Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    const speed =
      this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")
        ? this.opts.runSpeed
        : this.opts.walkSpeed;

    let wishX = 0;
    let wishZ = 0;
    if (forward !== 0 || strafe !== 0) {
      const len = Math.hypot(forward, strafe);
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // yaw = 0 で -Z 方向を向く
      const dx = (strafe * cos - forward * sin) / len;
      const dz = (-strafe * sin - forward * cos) / len;
      wishX = dx * speed * dt;
      wishZ = dz * speed * dt;
    }

    if (this.grounded && this.keys.has("Space")) this.velocityY = this.opts.jumpSpeed;
    this.velocityY -= this.opts.gravity * dt;
    const wishY = this.velocityY * dt;
    const beforeY = this.position.y;
    const solved = this.probe?.move(
      [this.position.x, this.position.y, this.position.z],
      [wishX, wishY, wishZ],
      this.velocityY <= 0,
    );
    if (solved) {
      this.position.set(solved.position[0], solved.position[1], solved.position[2]);
      this.grounded = solved.grounded;
      if (solved.grounded && this.velocityY < 0) this.velocityY = 0;
      else if (this.velocityY > 0 && solved.position[1] < beforeY + wishY - 1e-4)
        this.velocityY = 0;
    } else {
      this.position.x += wishX;
      this.position.y += wishY;
      this.position.z += wishZ;
      if (this.position.y < 0) {
        this.position.y = 0;
        this.velocityY = 0;
      }
      this.grounded = this.position.y <= 0;
    }
    this.apply();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.unlock();
  }

  private apply(): void {
    this.camera.position.set(
      this.position.x,
      this.position.y + this.opts.eyeHeight,
      this.position.z,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    // 入力欄にフォーカスがあるときは移動しない
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (down && e.code === "Space" && this.locked) e.preventDefault();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked) return;
    if (this.lookOverride) {
      if (e.movementX !== 0 || e.movementY !== 0) this.lookOverride(e.movementX, e.movementY);
      return;
    }
    this.yaw -= e.movementX * this.opts.sensitivity;
    this.pitch -= e.movementY * this.opts.sensitivity;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.disposers.push(() => target.removeEventListener(type, fn));
  }
}
