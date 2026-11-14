import { KokoStateRegistry, World } from "@tukurium/eks";
import type { MaterialDef, PrefabDef, ProjectDoc } from "@tukurium/repo-model";
import {
  buildWorld,
  type EffectEvent,
  equippableAt,
  equippedBy,
  grabbedBy,
  playersWithEquipment,
  type Simulation,
} from "@tukurium/runtime";
import { PREVIEW_SHOT_HEIGHT, PREVIEW_SHOT_WIDTH } from "@tukurium/shared";
import * as THREE from "three";
import { useApp } from "../app/store";
import { EntityView } from "../render/EntityView";
import { CAMERA_FOV } from "../session/FpsController";
import { readShotPng } from "../session/readShotPng";
import { openRing, provideRingItems } from "../session/ringMenuModel";
import type { SessionEngine } from "../session/SessionEngine";
import { useSessionWorld } from "../session/sessionWorld";
import { waitUntilIdle } from "../session/waitUntilIdle";
import { ARRIVAL_OFFSET, prefabAnchor, type WorkspaceAnchor, workspaceAnchor } from "./anchor";
import { expandedSnapshot, prefabEditSnapshot } from "./hooks";
import { type Box, prefabEditOrigin, type Vec3 } from "./prefabPlace";
import { queueOutgoingEffects, queueOutgoingSounds, sendFrame, useWorkspace } from "./store";

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const UI_REFRESH_SEC = 0.2;
/** ホストが実行状態を配る間隔 */
const FRAME_SEC = 1 / 15;
const EMPTY_WORLD = new World(new KokoStateRegistry());
/** 左クリックで装備できる道具までの距離（m。Host の E の届く距離と同じ） */
export const EQUIP_REACH = 3;
/** 持っている物の位置（視点）を送る間隔 */
const HOLD_SEC = 0.1;

/** この人が右クリックで持っている物があるか */
export function holdsSomething(world: World, player: string): boolean {
  return grabbedBy(world, player).length > 0;
}

/** この人が道具を装備しているか（ADR 0053） */
export function equipsSomething(world: World, player: string): boolean {
  return equippedBy(world, player).length > 0;
}

/** 編集中の見た目をほかの人へ送る間隔の下限 */
const PREVIEW_SEC = 0.4;
/** 開いたプレハブの置き場所を決めるのに、素材の読み込みを待つ長さの上限（秒） */
const PREFAB_PLACE_WAIT_SEC = 1.5;

/** Three.js の箱を、origin から見た箱にする（空なら null） */
const toBox = (box: THREE.Box3 | null, origin: readonly number[]): Box | null =>
  box && !box.isEmpty()
    ? {
        min: [
          box.min.x - (origin[0] ?? 0),
          box.min.y - (origin[1] ?? 0),
          box.min.z - (origin[2] ?? 0),
        ],
        max: [
          box.max.x - (origin[0] ?? 0),
          box.max.y - (origin[1] ?? 0),
          box.max.z - (origin[2] ?? 0),
        ],
      }
    : null;

/** その場所の手前（+Z 側）に、そこを向いて立つ */
export function enterSpace(engine: SessionEngine, at: [number, number, number]): void {
  engine.teleport([at[0], 0, at[2] + ARRIVAL_OFFSET], 0);
}

/** キー → 入力の動作名（スクリプトの onInput で受け取る） */
const KEY_ACTIONS: Record<string, string> = { KeyR: "reload", KeyE: "use", KeyF: "alt" };

/**
 * ワークスペースを 3D 空間に映す。
 * - Edit：制作データから組み立てた World を表示。クロスヘアのクリックで Entity を選ぶ。
 *   プレハブを開いている間は、その中身も出す（ADR 0076 の 9）。「その場」ではアウトプットの横か手前に、
 *   「離れた空間」では独立した空間に出し、選ぶのも境界も、プレハブの中身が相手になる。
 * - Play：ホストは Simulation を固定ステップで進めて状態を配り、ほかの人は届いた状態を表示する。
 *   クリックやキーは入力としてホストへ渡す。
 * 編集空間はアウトプットの物体全体を囲む境界で示す（要件 §6「編集対象の表示」）。
 */
export class WorkspaceController {
  private readonly view = new EntityView();
  private readonly bounds: THREE.LineSegments;
  private readonly selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x603d56);
  private readonly raycaster = new THREE.Raycaster();
  private editWorld: World | null = null;
  private editKey = "";
  private editDoc: ProjectDoc | null = null;
  /** 開いているプレハブの中身（アウトプットとは別に映す） */
  private readonly prefabView = new EntityView();
  private prefabWorld: World | null = null;
  private prefabKey = "";
  private prefabDef: PrefabDef | null = null;
  private prefabDefKey = "";
  /** 開いたプレハブの置き場所（置く先の空間の原点から見た位置）。開いたときに一度決め、開いている間は動かさない */
  private prefabPlace: { key: string; origin: Vec3 | null; waited: number } | null = null;
  private materialsDoc: ProjectDoc | null = null;
  private frameTimer = 0;
  private materials: MaterialDef[] = [];
  private materialsRev = -1;
  private accumulator = 0;
  private uiTimer = 0;
  private anchorKey = "";
  private holdTimer = 0;
  private turning = false;
  private previewKey = "";
  private previewTimer = 0;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly engine: SessionEngine) {
    engine.scene.add(this.view.root, this.prefabView.root);
    // 開いているプレハブの中身は、編集の手伝いなので、サムネイルに写さない（ADR 0046）
    this.prefabView.root.userData.noShot = true;
    this.prefabView.root.visible = false;
    this.disposers.push(
      engine.solids.bind("workspace", () => {
        const ws = useWorkspace.getState();
        if (!ws.project || !ws.ready) return null;
        // アウトプットの置き場所（プレハブを離れた空間で開いていても、アウトプットは元の所にある）
        const origin = this.anchorOf().position;
        if (ws.mode !== "edit") {
          const world = ws.runtime()?.world ?? ws.remote?.world;
          return world ? { world, origin } : null;
        }
        return this.editWorld ? { world: this.editWorld, origin } : null;
      }),
      // 開いているプレハブの中身にも、ぶつかる
      engine.solids.bind("workspace-prefab", () =>
        this.prefabWorld && this.prefabView.root.visible
          ? { world: this.prefabWorld, origin: this.prefabView.root.position.toArray() }
          : null,
      ),
    );
    this.bounds = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xfdd046, transparent: true, opacity: 0.9 }),
    );
    this.bounds.visible = false;
    this.selectionBox.visible = false;
    // 編集の手伝いの枠はサムネイルに写さない（ADR 0046）
    this.bounds.userData.noShot = true;
    this.selectionBox.userData.noShot = true;
    engine.scene.add(this.bounds, this.selectionBox);

    // リングメニュー（T）の「装備を外す」：再生中に、自分が装備しているとき（ADR 0053）
    this.disposers.push(
      provideRingItems(() => {
        const ws = useWorkspace.getState();
        if (ws.mode !== "play") return [];
        const world = ws.runtime()?.world;
        return [
          {
            id: "unequip",
            label: "装備を外す",
            hint: "装備していません",
            enabled: !!world && equipsSomething(world, this.me()),
            run: () =>
              ws.input({ action: "unequip", phase: "down", player: this.me(), ...this.viewRay() }),
          },
        ];
      }),
    );
    this.disposers.push(
      engine.onFrame((dt) => this.update(dt)),
      engine.onPointer((button, phase) => this.onPointer(button, phase)),
      engine.onHoldWheel((meters) => {
        if (useWorkspace.getState().mode !== "play") return;
        useWorkspace.getState().input({
          action: "reach",
          phase: "down",
          player: this.me(),
          pointer: [meters, 0],
          ...this.viewRay(),
        });
      }),
    );
    useWorkspace.setState({
      viewPoint: () => this.pointInFront(2),
      placePoint: () => {
        const cam = this.engine.camera;
        const p = cam.getWorldPosition(new THREE.Vector3());
        const d = cam.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
        const r = (n: number) => Math.round(n * 100) / 100;
        return {
          position: [r(p.x + d.x * 3), 0, r(p.z + d.z * 3)],
          yaw: this.engine.controller.yaw,
        };
      },
    });
    useWorkspace.setState({
      teleport: (to) => {
        const anchor = useWorkspace.getState().anchor;
        if (anchor) enterSpace(this.engine, to === "space" ? anchor.position : anchor.slot);
      },
    });
    this.disposers.push(() =>
      useWorkspace.setState({ viewPoint: null, placePoint: null, teleport: null, anchor: null }),
    );
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    const onCapture = useApp.getState().client.on((msg) => {
      if (msg.t === "ws.capture") void this.capture(msg);
    });
    this.disposers.push(onCapture, () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    });
  }

  dispose(): void {
    this.endTurn();
    for (const d of this.disposers) d();
    this.view.dispose();
    this.prefabView.dispose();
    this.bounds.removeFromParent();
    this.bounds.geometry.dispose();
    this.selectionBox.removeFromParent();
  }

  private update(dt: number): void {
    const ws = useWorkspace.getState();
    // アウトプットの編集空間の位置（重ならないように横にずらす。非公開・ワールドは独立した空間）
    const outputAnchor = this.anchorOf();
    this.view.root.position.set(...outputAnchor.position);
    // 自分がいる編集空間。プレハブを「離れた空間」で開いている間は、そのための独立した空間
    const prefab = this.openPrefab();
    const anchor =
      prefab?.editIn === "isolated"
        ? prefabAnchor(useApp.getState().session?.workspaces ?? [], ws.workspaceId ?? "")
        : outputAnchor;
    const anchorKey = JSON.stringify(anchor);
    if (anchorKey !== this.anchorKey) {
      this.anchorKey = anchorKey;
      const prev = useWorkspace.getState().anchor;
      const next = ws.workspaceId ? anchor : null;
      useWorkspace.setState({ anchor: next });
      // 独立した空間に切り替わったら（別の独立した空間へ移るときも）移動し、終わったらセッションへ戻す
      const moved = prev?.position.join() !== next?.position.join();
      if (next?.isolated && (!prev?.isolated || moved)) enterSpace(this.engine, next.position);
      else if (!next?.isolated && prev?.isolated) enterSpace(this.engine, prev.slot);
    }
    if (!ws.project || !ws.ready) {
      this.view.sync(EMPTY_WORLD, { materials: [], holdCamera: null });
      this.syncPrefab(null, [], outputAnchor, anchor, dt);
      this.bounds.visible = false;
      this.selectionBox.visible = false;
      return;
    }
    // マテリアルの一覧は制作データが変わったときだけ取り直す
    if (this.materialsRev !== ws.rev || this.materialsDoc !== ws.project) {
      this.materials = ws.project.snapshotWithPackages(ws.fieldSchemas).materials;
      this.materialsRev = ws.rev;
      this.materialsDoc = ws.project;
    }
    const materials = this.materials;

    this.sendHold(dt);
    // 装備している人のアバターは、腕を前に出して構える
    const playing = ws.mode !== "edit" ? ws.runtime()?.world : undefined;
    this.engine.setEquippedPlayers(
      "workspace",
      playing ? playersWithEquipment(playing) : new Set(),
    );
    if (ws.mode !== "edit" && ws.sim) {
      // ホスト：実行して、状態を配る
      if (ws.mode === "play") {
        this.accumulator = Math.min(this.accumulator + dt, STEP * MAX_STEPS_PER_FRAME);
        while (this.accumulator >= STEP) {
          ws.sim.step(STEP);
          this.accumulator -= STEP;
        }
      }
      this.view.sync(ws.sim.world, {
        materials,
        holdCamera: this.engine.camera,
        player: this.me(),
      });
      const sounds = ws.sim.drainSounds();
      if (sounds.length > 0) {
        this.playSounds(sounds);
        queueOutgoingSounds(sounds);
      }
      const effects = ws.sim.drainEffects();
      if (effects.length > 0) {
        this.showEffects(effects);
        queueOutgoingEffects(effects);
      }
      this.frameTimer += dt;
      if (this.frameTimer > FRAME_SEC) {
        this.frameTimer = 0;
        sendFrame();
      }
      this.refreshUi(dt, ws.sim.systemStatus());
    } else if (ws.mode !== "edit" && ws.remote) {
      // ホスト以外：ホストから届いた状態を表示する
      this.view.sync(ws.remote.world, {
        materials,
        holdCamera: this.engine.camera,
        player: this.me(),
      });
      if (ws.incomingSounds.length > 0) {
        this.playSounds(ws.incomingSounds);
        useWorkspace.setState({ incomingSounds: [] });
      }
      if (ws.incomingEffects.length > 0) {
        this.showEffects(ws.incomingEffects);
        useWorkspace.setState({ incomingEffects: [] });
      }
    } else {
      const key = `${ws.rev}:${ws.outputId}`;
      if (key !== this.editKey || !this.editWorld || this.editDoc !== ws.project) {
        this.editKey = key;
        this.editDoc = ws.project;
        // プレハブのインスタンスは、中身に展開して見せる（ADR 0076。画面のほかの所と同じ展開を使う）
        this.editWorld = buildWorld(
          expandedSnapshot(ws.project, ws.rev, ws.fieldSchemas),
          ws.outputId,
        ).world;
      }
      this.view.sync(this.editWorld, { materials, holdCamera: null });
      // ほかの人へ送る見た目は、アウトプットのもの（プレハブを開いていても変えない）
      this.publishPreview(
        dt,
        outputAnchor,
        anchor === outputAnchor ? anchorKey : JSON.stringify(outputAnchor),
      );
    }
    this.syncPrefab(prefab, materials, outputAnchor, anchor, dt);
    // 選ぶ相手と境界は、いま編集しているもの（開いているプレハブか、アウトプット）
    const target = prefab ? this.prefabView : this.view;

    // 編集空間の境界（Edit のときだけ）
    const box = ws.mode === "edit" && target.root.visible ? target.bounds() : null;
    this.bounds.visible = box !== null;
    if (box) {
      const size = box.getSize(new THREE.Vector3()).addScalar(0.3);
      this.bounds.position.copy(box.getCenter(new THREE.Vector3()));
      this.bounds.scale.copy(size);
    }

    // 選択中の Entity の枠
    const sel = ws.selection?.kind === "entity" ? target.objectOf(ws.selection.id) : undefined;
    this.selectionBox.visible = Boolean(sel) && ws.mode === "edit";
    if (sel && ws.mode === "edit") {
      this.selectionBox.setFromObject(sel);
    }
  }

  /**
   * 制作データの座標にカメラを置き、サムネイルと同じ描き方で PNG にする。
   * 置き位置（アンカー）の分だけずらす。読み込みが残っていれば、そのことを返す。
   */
  private async capture(msg: {
    workspaceId: string;
    requestId: string;
    position: [number, number, number];
    target: [number, number, number];
    fov?: number;
  }): Promise<void> {
    const send = (body: { png?: string; error?: string; pending?: boolean }) =>
      useApp.getState().client.send({
        t: "ws.shot",
        workspaceId: msg.workspaceId,
        requestId: msg.requestId,
        ...body,
      });
    const ws = useWorkspace.getState();
    if (msg.workspaceId !== ws.workspaceId || !ws.ready) {
      send({ error: "このワークスペースを開いていません" });
      return;
    }
    const idle = await waitUntilIdle(() => this.view.pending, 2_000);
    const anchor = this.anchorOf();
    const camera = new THREE.PerspectiveCamera(
      msg.fov ?? CAMERA_FOV,
      PREVIEW_SHOT_WIDTH / PREVIEW_SHOT_HEIGHT,
      0.05,
      500,
    );
    camera.position.set(
      anchor.position[0] + msg.position[0],
      anchor.position[1] + msg.position[1],
      anchor.position[2] + msg.position[2],
    );
    camera.lookAt(
      anchor.position[0] + msg.target[0],
      anchor.position[1] + msg.target[1],
      anchor.position[2] + msg.target[2],
    );
    camera.updateMatrixWorld();
    const target = new THREE.WebGLRenderTarget(PREVIEW_SHOT_WIDTH, PREVIEW_SHOT_HEIGHT);
    target.texture.colorSpace = THREE.SRGBColorSpace;
    try {
      this.engine.renderShot(camera, target);
      const png = readShotPng(this.engine.renderer, target);
      if (png.length > 8 * 1024 * 1024) {
        send({ error: "撮った画像が大きすぎます" });
        return;
      }
      send({ png, pending: !idle });
    } catch (e) {
      send({ error: e instanceof Error ? e.message : "画面を撮れませんでした" });
    } finally {
      target.dispose();
    }
  }

  /** 開いているプレハブ（Edit のときだけ。制作データが変わるまで、同じものを返す） */
  private openPrefab(): PrefabDef | null {
    const ws = useWorkspace.getState();
    const open = ws.mode === "edit" && ws.ready ? ws.editingPrefab : null;
    if (!open || !ws.project) {
      this.prefabDefKey = "";
      this.prefabDef = null;
      return null;
    }
    const key = `${ws.workspaceId}:${ws.rev}:${open.id}`;
    if (key !== this.prefabDefKey) {
      this.prefabDefKey = key;
      this.prefabDef = ws.project.prefab(open.id) ?? null;
    }
    return this.prefabDef;
  }

  /**
   * 開いているプレハブの中身を映す（ADR 0076 の 9）。prefab が null なら、片付ける。
   * 置き場所は、開いたときに一度決める（直している間に、中身が動かないように）。
   * - その場：アウトプットの編集空間の中。開いた元のインスタンスの横か、区画に出ているものの手前
   * - 離れた空間：そのための独立した空間の中
   */
  private syncPrefab(
    prefab: PrefabDef | null,
    materials: MaterialDef[],
    outputAnchor: WorkspaceAnchor,
    anchor: WorkspaceAnchor,
    dt: number,
  ): void {
    const ws = useWorkspace.getState();
    const root = this.prefabView.root;
    if (!prefab || !ws.project) {
      if (this.prefabWorld || this.prefabPlace) {
        this.prefabView.sync(EMPTY_WORLD, { materials: [], holdCamera: null });
        this.prefabWorld = null;
        this.prefabKey = "";
        this.prefabPlace = null;
      }
      root.visible = false;
      return;
    }
    const key = `${ws.workspaceId}:${ws.rev}:${prefab.id}`;
    if (key !== this.prefabKey || !this.prefabWorld) {
      this.prefabKey = key;
      const snapshot = prefabEditSnapshot(ws.project, prefab.id, ws.rev, ws.fieldSchemas);
      this.prefabWorld = snapshot ? buildWorld(snapshot, prefab.id).world : EMPTY_WORLD;
    }
    this.prefabView.sync(this.prefabWorld, { materials, holdCamera: null });

    const here = prefab.editIn !== "isolated";
    const from = ws.editingPrefab?.from ?? null;
    const placeKey = `${ws.workspaceId}:${prefab.id}:${from}:${here}`;
    if (this.prefabPlace?.key !== placeKey)
      this.prefabPlace = { key: placeKey, origin: null, waited: 0 };
    const place = this.prefabPlace;
    const base = here ? outputAnchor.position : anchor.position;
    if (!place.origin) {
      // 形が決まってから置く（素材を読み込んでいる間は、少し待つ）
      place.waited += dt;
      const loading = this.prefabView.pending + this.view.pending > 0;
      if (loading && place.waited < PREFAB_PLACE_WAIT_SEC) {
        root.visible = false;
        return;
      }
      // 中身の広がりは、プレハブの原点から見た箱にする
      root.position.set(0, 0, 0);
      root.updateMatrixWorld(true);
      const content = toBox(this.prefabView.bounds(), [0, 0, 0]);
      if (!here) {
        place.origin = prefabEditOrigin({ content, instance: null, output: null });
      } else {
        this.view.root.updateMatrixWorld(true);
        const at = outputAnchor.position;
        const boxOf = (o: THREE.Object3D) => toBox(new THREE.Box3().setFromObject(o), at);
        const fromObject = from ? this.view.objectOf(from) : undefined;
        // インスタンスに形がなければ、その場所（点）をよける
        const point = fromObject?.getWorldPosition(new THREE.Vector3());
        const instance = fromObject
          ? (boxOf(fromObject) ??
            toBox(point ? new THREE.Box3(point, point.clone().addScalar(0.001)) : null, at))
          : null;
        // よけるのは、アウトプットのいちばん上に並んでいる、ほかの物
        const obstacles = this.view.root.children
          .filter((o) => o !== fromObject)
          .map(boxOf)
          .filter((b): b is Box => b !== null);
        place.origin = prefabEditOrigin({
          content,
          instance,
          output: toBox(this.view.bounds(), at),
          obstacles,
        });
      }
    }
    root.position.set(
      base[0] + place.origin[0],
      base[1] + place.origin[1],
      base[2] + place.origin[2],
    );
    root.visible = true;
  }

  private anchorOf(): WorkspaceAnchor {
    const ws = useWorkspace.getState();
    // ライブラリの出力は、編集空間での置き方を Item と同じにする
    const kind = ws.project?.output(ws.outputId)?.kind === "world" ? "world" : "item";
    return workspaceAnchor(useApp.getState().session?.workspaces ?? [], ws.workspaceId ?? "", kind);
  }

  /**
   * ホストだけ：編集中の見た目を、開いていない参加者へ送る（サーバーが権限で見せ分ける）。
   * 制作データが変わったときだけ、間隔をあけて送る。
   */
  private publishPreview(dt: number, anchor: WorkspaceAnchor, anchorKey: string): void {
    const ws = useWorkspace.getState();
    this.previewTimer += dt;
    if (!ws.isHost || !ws.workspaceId || !this.editWorld || !ws.project) return;
    const key = `${ws.workspaceId}:${this.editKey}:${anchorKey}`;
    if (key === this.previewKey || this.previewTimer < PREVIEW_SEC) return;
    this.previewKey = key;
    this.previewTimer = 0;
    const box = this.view.bounds();
    useApp.getState().client.send({
      t: "ws.preview",
      workspaceId: ws.workspaceId,
      preview: {
        anchor: anchor.position,
        isolated: anchor.isolated,
        outputKind: ws.project.output(ws.outputId)?.kind === "world" ? "world" : "item",
        bounds: box
          ? {
              center: box.getCenter(new THREE.Vector3()).toArray(),
              size: box.getSize(new THREE.Vector3()).toArray(),
            }
          : null,
        world: this.editWorld.snapshot(),
        materials: this.materials,
      },
    });
  }

  /** 編集空間の座標の effect を、セッションの座標に直して出す */
  private showEffects(effects: EffectEvent[]) {
    for (const fx of effects) {
      const p = this.view.root.localToWorld(new THREE.Vector3(...fx.position)).toArray();
      this.engine.effects.spawn({ ...fx, position: p });
    }
  }

  /** 編集空間の座標の音を、セッションの座標に直して鳴らす */
  private playSounds(
    sounds: { asset: string; position: [number, number, number] | null; volume: number }[],
  ) {
    for (const snd of sounds) {
      const p = snd.position
        ? this.view.root.localToWorld(new THREE.Vector3(...snd.position)).toArray()
        : null;
      this.engine.audio.play(snd.asset, p, snd.volume);
    }
  }

  /** 持っている物があれば、視点を間隔をあけて送る（ほかの人にも持っている位置が見える） */
  private sendHold(dt: number): void {
    if (this.turning && !this.holdingPlay()) this.endTurn();
    const ws = useWorkspace.getState();
    this.holdTimer += dt;
    if (ws.mode !== "play" || this.holdTimer < HOLD_SEC) return;
    this.holdTimer = 0;
    const world = ws.runtime()?.world;
    if (!world || !(holdsSomething(world, this.me()) || equipsSomething(world, this.me()))) return;
    ws.input({ action: "hold", phase: "down", player: this.me(), ...this.viewRay() });
  }

  /** 道具を左クリックしてリングメニューを開いたとき、その押下を離す fire を送らない */
  private skipFireUp = false;

  /**
   * 照準の先（3m 以内）に、いま装備できる道具があれば、リングメニューを開いて「装備する」を選べるようにする。
   * 開いたら true
   */
  private offerEquip(): boolean {
    const ws = useWorkspace.getState();
    const world = ws.runtime()?.world;
    if (!world) return false;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.engine.camera);
    this.raycaster.far = EQUIP_REACH;
    const hit = this.view.pick(this.raycaster);
    this.raycaster.far = Number.POSITIVE_INFINITY;
    if (!equippableAt(world, hit)) return false;
    const swapping = equipsSomething(world, this.me());
    openRing([
      {
        id: "equip",
        label: swapping ? "持ち替える" : "装備する",
        enabled: true,
        run: () =>
          ws.input({ action: "equip", phase: "down", player: this.me(), ...this.viewRay() }),
      },
    ]);
    return true;
  }

  /** 再生中に、自分が物を持っているか */
  private holdingPlay(): boolean {
    const ws = useWorkspace.getState();
    if (ws.mode !== "play") return false;
    const world = ws.runtime()?.world;
    return !!world && holdsSomething(world, this.me());
  }

  /** E を押している間、見回すのを止めて、マウスで持っている物を回す */
  private beginTurn(): void {
    this.turning = true;
    this.engine.controller.setLookOverride((dx, dy) => {
      const s = this.engine.controller.sensitivity;
      useWorkspace.getState().input({
        action: "twist",
        phase: "down",
        player: this.me(),
        pointer: [-dx * s, -dy * s],
        ...this.viewRay(),
      });
    });
  }

  private endTurn(): void {
    if (!this.turning) return;
    this.turning = false;
    this.engine.controller.setLookOverride(null);
  }

  private refreshUi(dt: number, status: ReturnType<Simulation["systemStatus"]>): void {
    this.uiTimer += dt;
    if (this.uiTimer <= UI_REFRESH_SEC) return;
    this.uiTimer = 0;
    useWorkspace.setState((s) => ({ simRev: s.simRev + 1, systemStatus: status }));
  }

  /** 視線の先 distance m の位置（編集空間の座標系、高さは 0.5m 以上） */
  private pointInFront(distance: number): [number, number, number] {
    const { origin, direction } = this.viewRay();
    const p = new THREE.Vector3(...origin).addScaledVector(
      new THREE.Vector3(...direction),
      distance,
    );
    const r = (n: number) => Math.round(n * 100) / 100;
    p.y = Math.max(p.y, 0.5);
    // プレハブを開いているときは、そのいちばん上の Entity から見た位置にする（中の Entity は、その下に入る）
    const prefab = this.openPrefab();
    const frame = prefab ? this.prefabView.objectOf(prefab.root) : undefined;
    if (frame && this.prefabView.root.visible) {
      frame.updateWorldMatrix(true, false);
      frame.worldToLocal(this.view.root.localToWorld(p));
    }
    return [r(p.x), r(p.y), r(p.z)];
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

  private me(): string {
    return useApp.getState().me?.id ?? "me";
  }

  private onPointer(button: number, phase: "down" | "up"): void {
    const ws = useWorkspace.getState();
    if (ws.mode === "play" && button === 0) {
      // 持っているときの左クリックは、撃たずに傾きを直す
      if (phase === "down" && this.holdingPlay()) {
        ws.input({ action: "align", phase, player: this.me(), ...this.viewRay() });
        return;
      }
      // 置いてある道具への左クリックは、撃たずにリングメニューで「装備する」を選べるようにする（ADR 0053）
      if (phase === "down" && this.offerEquip()) {
        this.skipFireUp = true;
        return;
      }
      if (phase === "up" && this.skipFireUp) {
        this.skipFireUp = false;
        return;
      }
      ws.input({ action: "fire", phase, player: this.me(), ...this.viewRay() });
      return;
    }
    // 右クリック：押している間 Grabbable を持つ。離したら放す
    if (ws.mode === "play" && button === 2) {
      ws.input({ action: "grab", phase, player: this.me(), ...this.viewRay() });
      return;
    }
    if (ws.mode === "edit" && !ws.panelsHidden && button === 0 && phase === "down") {
      // セッションの物を持っている左クリックは、傾きを直すほうに使う
      const session = useSessionWorld.getState().view()?.world;
      if (session && holdsSomething(session, this.me())) return;
      this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.engine.camera);
      // プレハブを開いている間は、その中身だけを選ぶ（アウトプットの物を選んで、うっかり閉じないように）
      const id = (this.openPrefab() ? this.prefabView : this.view).pick(this.raycaster);
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
    // 持っている間の E は use ではなく、マウスで物を回す
    if (e.code === "KeyE" && this.holdingPlay()) {
      if (e.type === "keydown") this.beginTurn();
      else this.endTurn();
      return;
    }
    const action = KEY_ACTIONS[e.code];
    if (!action || e.repeat || ws.mode !== "play") return;
    ws.input({
      action,
      phase: e.type === "keydown" ? "down" : "up",
      player: this.me(),
      ...this.viewRay(),
    });
  }
}
