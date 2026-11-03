import type { EntityId, Vec3, World } from "@tukurium/eks";
import { BUILTIN, type MaterialDef } from "@tukurium/repo-model";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { assetUrl } from "../net/api";

const DEG = THREE.MathUtils.DEG2RAD;

interface Node {
  object: THREE.Object3D;
  mesh: THREE.Mesh | null;
  /** GLB のモデル（Mesh.model が指定されているとき） */
  model: THREE.Object3D | null;
  modelId: string | null;
  geometryKey: string;
  materialKey: string;
}

export interface SyncOptions {
  materials: MaterialDef[];
  /** Play 中：Held を持つ Entity をこのカメラに付ける */
  holdCamera?: THREE.Camera | null;
  /** 自分の ID。Held の player が自分（か空）のものだけカメラに付ける。ほかの人が持つ物はその位置に出す */
  player?: string;
}

/**
 * EKS の World を Three.js のオブジェクトに映す。
 * - Entity ごとに Object3D を作り、親子関係をそのまま反映する。
 * - Mesh を持つ Entity にはプロシージャル形状を作る（形状・大きさが変わったときだけ作り直す）。
 * - 選択や当たり判定のため、各オブジェクトの userData.entityId に Entity の ID を入れる。
 */
export class EntityView {
  readonly root = new THREE.Group();
  private readonly nodes = new Map<EntityId, Node>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly held = new Set<EntityId>();
  private readonly gltf = new GLTFLoader();
  private readonly modelCache = new Map<string, Promise<THREE.Group>>();
  private readonly textures = new Map<string, THREE.Texture>();

  sync(world: World, opts: SyncOptions): void {
    const ids = new Set(world.entityIds());
    for (const id of [...this.nodes.keys()]) if (!ids.has(id)) this.removeNode(id);

    const matDefs = new Map(opts.materials.map((m) => [m.id, m]));
    for (const id of ids) {
      let node = this.nodes.get(id);
      if (!node) {
        const object = new THREE.Object3D();
        object.userData.entityId = id;
        node = { object, mesh: null, model: null, modelId: null, geometryKey: "", materialKey: "" };
        this.nodes.set(id, node);
      }
      this.syncMesh(node, world, id, matDefs);
      this.syncTransform(node, world, id);
    }

    // 親子付け（Held は Play 中はカメラへ）
    this.held.clear();
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const held = opts.holdCamera ? world.get(id, BUILTIN.Held) : undefined;
      const holder = (held?.player as string | undefined) ?? "";
      const heldState = held && (holder === "" || holder === opts.player) ? held : undefined;
      let parent: THREE.Object3D = this.root;
      if (heldState && opts.holdCamera) {
        parent = opts.holdCamera;
        node.object.position.set(...(heldState.offset as Vec3));
        const turn = (heldState.rotation as Vec3 | undefined) ?? [0, 0, 0];
        node.object.rotation.set(turn[0] * DEG, turn[1] * DEG, turn[2] * DEG, "XYZ");
        this.held.add(id);
      } else {
        const p = world.parentOf(id);
        const pn = p ? this.nodes.get(p) : undefined;
        if (pn) parent = pn.object;
      }
      if (node.object.parent !== parent) parent.add(node.object);
    }
  }

  /** 画面中央（カメラの視線）にある Entity を返す。Held は除く。 */
  pick(raycaster: THREE.Raycaster): EntityId | null {
    const targets: THREE.Object3D[] = [];
    for (const [id, n] of this.nodes) {
      if (this.held.has(id)) continue;
      if (n.mesh) targets.push(n.mesh);
      if (n.model) targets.push(n.model);
    }
    const hit = raycaster.intersectObjects(targets, true)[0];
    // 当たったオブジェクトから親をたどって、Entity の ID を探す
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      if (o.userData.entityId) return o.userData.entityId as EntityId;
    }
    return null;
  }

  objectOf(id: EntityId): THREE.Object3D | undefined {
    return this.nodes.get(id)?.object;
  }

  /** 表示中の物体全体の境界（Held は除く）。何もなければ null。 */
  bounds(): THREE.Box3 | null {
    const box = new THREE.Box3();
    let any = false;
    for (const [id, n] of this.nodes) {
      if (this.held.has(id)) continue;
      const target = n.model ?? n.mesh;
      if (!target) continue;
      box.expandByObject(target);
      any = true;
    }
    return any ? box : null;
  }

  dispose(): void {
    for (const id of [...this.nodes.keys()]) this.removeNode(id);
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.geometries.clear();
    this.materials.clear();
    this.root.removeFromParent();
  }

  private syncTransform(node: Node, world: World, id: EntityId): void {
    const t = world.get(id, BUILTIN.Transform);
    if (!t) {
      node.object.position.set(0, 0, 0);
      node.object.rotation.set(0, 0, 0);
      node.object.scale.set(1, 1, 1);
      return;
    }
    const p = t.position as Vec3;
    const r = t.rotation as Vec3;
    const s = t.scale as Vec3;
    node.object.position.set(p[0], p[1], p[2]);
    node.object.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, "XYZ");
    node.object.scale.set(s[0], s[1], s[2]);
  }

  private syncMesh(
    node: Node,
    world: World,
    id: EntityId,
    matDefs: Map<string, MaterialDef>,
  ): void {
    const mesh = world.get(id, BUILTIN.Mesh);
    const modelId = mesh && typeof mesh.model === "string" ? mesh.model : null;
    this.syncModel(node, modelId);
    if (!mesh || modelId) {
      // メッシュがない、または GLB で表示するときは形状を消す
      if (node.mesh) {
        node.mesh.removeFromParent();
        node.mesh = null;
        node.geometryKey = "";
        node.materialKey = "";
      }
      return;
    }
    const shape = String(mesh.shape);
    const size = mesh.size as Vec3;
    const geometryKey = `${shape}:${size.join(",")}`;
    const md = typeof mesh.material === "string" ? matDefs.get(mesh.material) : undefined;
    // マテリアルが指定されていれば色はマテリアル、なければ Mesh.color
    const color = md ? md.color : String(mesh.color);
    const materialKey = `${color}:${md?.roughness ?? 0.6}:${md?.metalness ?? 0}:${md?.map ?? ""}`;

    if (!node.mesh) {
      node.mesh = new THREE.Mesh();
      node.mesh.castShadow = true;
      node.mesh.receiveShadow = true;
      node.object.add(node.mesh);
    }
    if (node.geometryKey !== geometryKey) {
      node.mesh.geometry = this.geometry(shape, size, geometryKey);
      node.geometryKey = geometryKey;
    }
    if (node.materialKey !== materialKey) {
      node.mesh.material = this.material(materialKey, color, md);
      node.materialKey = materialKey;
    }
  }

  private geometry(shape: string, size: Vec3, key: string): THREE.BufferGeometry {
    const cached = this.geometries.get(key);
    if (cached) return cached;
    const [x, y, z] = size.map((v) => Math.max(Math.abs(v), 0.001)) as Vec3;
    let g: THREE.BufferGeometry;
    switch (shape) {
      case "sphere":
        g = new THREE.SphereGeometry(x / 2, 32, 16);
        break;
      case "cylinder":
        g = new THREE.CylinderGeometry(x / 2, x / 2, y, 32);
        break;
      case "capsule":
        g = new THREE.CapsuleGeometry(x / 2, Math.max(y - x, 0.001), 8, 16);
        break;
      case "plane":
        g = new THREE.PlaneGeometry(x, z).rotateX(-Math.PI / 2);
        break;
      default:
        g = new THREE.BoxGeometry(x, y, z);
    }
    this.geometries.set(key, g);
    return g;
  }

  private material(key: string, color: string, md: MaterialDef | undefined): THREE.Material {
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color,
        roughness: md?.roughness ?? 0.6,
        metalness: md?.metalness ?? 0,
        map: md?.map ? this.texture(md.map) : null,
      });
      this.materials.set(key, m);
    }
    return m;
  }

  private texture(id: string): THREE.Texture {
    let t = this.textures.get(id);
    if (!t) {
      t = new THREE.TextureLoader().load(assetUrl(id));
      t.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(id, t);
    }
    return t;
  }

  /** GLB のモデルを付け外しする（読み込みは素材 ID ごとに 1 回、表示はその複製） */
  private syncModel(node: Node, modelId: string | null): void {
    if (node.modelId === modelId) return;
    node.model?.removeFromParent();
    node.model = null;
    node.modelId = modelId;
    if (!modelId) return;
    let loading = this.modelCache.get(modelId);
    if (!loading) {
      loading = this.gltf.loadAsync(assetUrl(modelId)).then((g) => g.scene);
      this.modelCache.set(modelId, loading);
    }
    loading
      .then((scene) => {
        if (node.modelId !== modelId) return; // 読み込み中に別のモデルに変わった
        const copy = scene.clone(true);
        copy.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        node.model = copy;
        node.object.add(copy);
      })
      .catch(() => this.modelCache.delete(modelId));
  }

  private removeNode(id: EntityId): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.object.removeFromParent();
    this.nodes.delete(id);
  }
}
