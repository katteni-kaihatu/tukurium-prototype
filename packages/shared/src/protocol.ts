import { z } from "zod";

/** 通信プロトコルの版。互換性のない変更をしたら上げる。 */
export const PROTOCOL_VERSION = 2;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const id = z.string().min(1).max(64);
/** Yjs の更新など、バイナリを base64 で運ぶ */
const b64 = z.string().max(8 * 1024 * 1024);

/** ワークスペースの権限（要件 §8）。null は権限なし。 */
export const WorkspaceRole = z.enum(["viewer", "editor", "admin"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const PlayMode = z.enum(["edit", "play", "paused"]);
export type PlayMode = z.infer<typeof PlayMode>;

// ---------------------------------------------------------------------------
// 共有する状態

export const UserInfo = z.object({ id, name: z.string() });
export type UserInfo = z.infer<typeof UserInfo>;

export const Participant = z.object({
  id,
  name: z.string(),
  position: vec3,
  yaw: z.number(),
  pitch: z.number(),
});
export type Participant = z.infer<typeof Participant>;

export const WorkspaceInfo = z.object({
  id,
  name: z.string(),
  /** 編集しているリポジトリ */
  repoId: id.nullable(),
  /** 再生の実行を確定する人（ワークスペースのホスト） */
  host: id.nullable(),
  /** 参加者に最初に与える権限。null は非公開（招待した人だけ） */
  defaultRole: WorkspaceRole.nullable(),
  members: z.array(z.object({ userId: id, role: WorkspaceRole })),
  /** いま開いている人 */
  present: z.array(id),
  mode: PlayMode,
});
export type WorkspaceInfo = z.infer<typeof WorkspaceInfo>;

/** セッションに配置された実体（ワークスペースのアウトプット 1 回分） */
export const PlacementInfo = z.object({
  id,
  /** ワークスペースから出した配置（適用できる）。作品のリリースから置いた配置なら null */
  workspaceId: id.nullable(),
  releaseId: id.nullable(),
  workspaceName: z.string(),
  outputId: z.string(),
  outputName: z.string(),
  position: vec3,
  yaw: z.number(),
  placedBy: id,
});
export type PlacementInfo = z.infer<typeof PlacementInfo>;

export const SessionInfo = z.object({
  id,
  name: z.string(),
  owner: id,
  participants: z.array(UserInfo),
  workspaces: z.array(WorkspaceInfo),
  placements: z.array(PlacementInfo),
  /** セッションの世界を実行している人（持ち主）。いなければ null */
  host: id.nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SessionSummary = z.object({
  id,
  name: z.string(),
  owner: UserInfo,
  count: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** 再生の入力（ランタイムの InputEvent と同じ形） */
export const PlayInput = z.object({
  action: z.string().max(32),
  phase: z.enum(["down", "up"]),
  origin: vec3,
  direction: vec3,
  player: z.string(),
  /**
   * 追加の数値。回すときはマウスの移動（ラジアン）。
   * 前後に動かすときはメートル（正で奥へ）。
   */
  pointer: z.tuple([z.number(), z.number()]).optional(),
});

/** 鳴らす音 */
export const SoundEvent = z.object({
  asset: z.string(),
  position: vec3.nullable(),
  volume: z.number(),
});

/** System の状態（止まった理由と行） */
export const SystemStatusInfo = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  error: z.string().nullable(),
  line: z.number().int().nullable().default(null),
});

/** ホストが配信する実行状態。world は EKS の WorldSnapshot。 */
export const PlayFrame = z.object({
  sounds: z.array(SoundEvent).max(32).optional(),
  mode: PlayMode,
  outputId: z.string(),
  time: z.number(),
  world: z.unknown(),
  names: z.record(z.string(), z.string()),
  status: z.array(SystemStatusInfo),
});
export type PlayFrame = z.infer<typeof PlayFrame>;

/** セッションのホストが配る、セッションの世界の状態 */
export const SessionFrame = z.object({
  sounds: z.array(SoundEvent).max(32).optional(),
  time: z.number(),
  world: z.unknown(),
  names: z.record(z.string(), z.string()),
  /** 表示用のマテリアル（ID はリポジトリごとに付け替え済み） */
  materials: z.array(z.unknown()),
  status: z.array(SystemStatusInfo),
});
export type SessionFrame = z.infer<typeof SessionFrame>;

/**
 * ワークスペースの編集中の見た目（開いていない参加者向け）。実物と境界（要件 §6）。
 * isolated：独立した空間（ワールドの編集空間・非公開の作業）に置かれている。
 */
export const WorkspacePreview = z.object({
  anchor: vec3,
  isolated: z.boolean(),
  outputKind: z.enum(["item", "world"]),
  bounds: z.object({ center: vec3, size: vec3 }).nullable(),
  world: z.unknown(),
  materials: z.array(z.unknown()),
});
export type WorkspacePreview = z.infer<typeof WorkspacePreview>;

/** ホストに渡す配置（制作データ込み） */
export const HostPart = z.object({
  id,
  realm: id,
  outputId: z.string(),
  snapshot: z.unknown(),
  position: vec3,
  yaw: z.number(),
});
export type HostPart = z.infer<typeof HostPart>;

/**
 * 自分が開いているパネルの公開用の情報。内容（lines）はサーバーが権限を確かめてから相手に渡す。
 * 3D 表示ならその位置、2D 表示なら本人の前に並べて見せる。
 */
export const PanelPublic = z.object({
  id: z.string().max(64),
  title: z.string().max(80),
  workspaceId: id.nullable(),
  mode: z.enum(["2d", "3d"]),
  transform: z.object({ position: vec3, yaw: z.number() }).nullable(),
  lines: z.array(z.string().max(120)).max(12),
});
export type PanelPublic = z.infer<typeof PanelPublic>;

// ---------------------------------------------------------------------------
// クライアント → サーバー

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.number(),
    name: z.string().min(1).max(32),
    /** 前回もらったトークン（本人識別）。なければ新しく発行する */
    token: z.string().max(128).optional(),
  }),
  z.object({ t: z.literal("rename"), name: z.string().min(1).max(32) }),
  z.object({ t: z.literal("sessions.list") }),
  z.object({ t: z.literal("session.create"), name: z.string().min(1).max(64) }),
  z.object({ t: z.literal("session.join"), sessionId: id }),
  z.object({ t: z.literal("session.leave") }),
  /** 持ち主がセッションを閉じる */
  z.object({ t: z.literal("session.close") }),
  z.object({ t: z.literal("pose"), position: vec3, yaw: z.number(), pitch: z.number() }),
  z.object({ t: z.literal("panels"), panels: z.array(PanelPublic).max(12) }),

  z.object({
    t: z.literal("ws.create"),
    name: z.string().min(1).max(64),
    /** 初期内容（ProjectSnapshot を Y.Doc にした更新） */
    initial: b64,
  }),
  z.object({ t: z.literal("ws.open"), workspaceId: id }),
  z.object({ t: z.literal("ws.close"), workspaceId: id }),
  z.object({ t: z.literal("ws.update"), workspaceId: id, update: b64 }),
  z.object({ t: z.literal("ws.awareness"), workspaceId: id, update: b64 }),
  z.object({
    t: z.literal("ws.setRole"),
    workspaceId: id,
    userId: id,
    role: WorkspaceRole.nullable(),
  }),
  z.object({ t: z.literal("ws.setDefaultRole"), workspaceId: id, role: WorkspaceRole.nullable() }),
  z.object({
    t: z.literal("ws.cmd"),
    workspaceId: id,
    cmd: z.enum(["play", "pause", "resume", "stop"]),
    outputId: z.string().optional(),
  }),
  z.object({ t: z.literal("ws.input"), workspaceId: id, input: PlayInput }),
  /** ホストだけが送る */
  z.object({ t: z.literal("ws.frame"), workspaceId: id, frame: PlayFrame }),
  z.object({
    t: z.literal("ws.log"),
    workspaceId: id,
    message: z.string().max(500),
    level: z.enum(["log", "error"]),
  }),
  /** ワークスペースのアウトプットをセッションに出す（共同編集以上） */
  z.object({
    t: z.literal("place"),
    workspaceId: id,
    outputId: z.string(),
    snapshot: z.unknown(),
    position: vec3,
    yaw: z.number(),
  }),
  /** ホストだけが送る：編集中の見た目 */
  z.object({ t: z.literal("ws.preview"), workspaceId: id, preview: WorkspacePreview }),
  /** リポジトリをこのセッションのワークスペースとして開く（1 リポジトリ 1 ワークスペース） */
  z.object({ t: z.literal("ws.openRepo"), repoId: id }),
  /** コミット（意図的な保存）。メッセージ付き */
  z.object({ t: z.literal("ws.commit"), workspaceId: id, message: z.string().max(500) }),
  /** 作品のリリースをセッションに置く（作品の「利用」権限） */
  z.object({ t: z.literal("placeRelease"), releaseId: id, position: vec3, yaw: z.number() }),
  /** 適用：このワークスペース・アウトプットにリンクしている配置をすべて更新する */
  z.object({ t: z.literal("apply"), workspaceId: id, outputId: z.string(), snapshot: z.unknown() }),
  z.object({ t: z.literal("unplace"), placementId: id }),
  z.object({ t: z.literal("resetPart"), placementId: id }),
  z.object({ t: z.literal("session.input"), input: PlayInput }),
  /** セッションのホストだけが送る */
  z.object({ t: z.literal("session.frame"), frame: SessionFrame }),
  z.object({
    t: z.literal("session.log"),
    message: z.string().max(500),
    level: z.enum(["log", "error"]),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// サーバー → クライアント

export const ServerMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), protocol: z.number(), you: UserInfo, token: z.string() }),
  z.object({ t: z.literal("sessions"), sessions: z.array(SessionSummary) }),
  z.object({ t: z.literal("session"), session: SessionInfo, participants: z.array(Participant) }),
  z.object({ t: z.literal("session.closed"), reason: z.string() }),
  z.object({ t: z.literal("joined"), participant: Participant }),
  z.object({ t: z.literal("left"), id }),
  z.object({ t: z.literal("pose"), id, position: vec3, yaw: z.number(), pitch: z.number() }),
  z.object({
    t: z.literal("panels"),
    userId: id,
    /** 権限がない内容は lines が空で restricted が true */
    panels: z.array(PanelPublic.extend({ restricted: z.boolean() })),
  }),

  z.object({ t: z.literal("ws.created"), workspaceId: id }),
  /** 開いていないワークスペースの見た目。閲覧権限がなければ restricted（境界だけ・中身なし） */
  z.object({
    t: z.literal("ws.preview"),
    workspaceId: id,
    name: z.string(),
    restricted: z.boolean(),
    preview: WorkspacePreview,
  }),
  z.object({
    t: z.literal("ws.committed"),
    workspaceId: id,
    commit: z.string(),
    message: z.string(),
    by: z.string(),
  }),
  z.object({ t: z.literal("ws.doc"), workspaceId: id, update: b64, role: WorkspaceRole }),
  z.object({ t: z.literal("ws.denied"), workspaceId: id, reason: z.string() }),
  z.object({ t: z.literal("ws.update"), workspaceId: id, update: b64 }),
  z.object({ t: z.literal("ws.awareness"), workspaceId: id, update: b64 }),
  /** 自分の権限が変わった（null なら閲覧できなくなった） */
  z.object({ t: z.literal("ws.role"), workspaceId: id, role: WorkspaceRole.nullable() }),
  /** ホストへ：再生の操作 */
  z.object({
    t: z.literal("ws.cmd"),
    workspaceId: id,
    cmd: z.enum(["play", "pause", "resume", "stop"]),
    outputId: z.string().optional(),
    from: id,
  }),
  /** ホストへ：他の人の入力 */
  z.object({ t: z.literal("ws.input"), workspaceId: id, input: PlayInput }),
  /** 自分がホストになった。resume があれば、その状態から再生を続ける */
  z.object({ t: z.literal("ws.host"), workspaceId: id, resume: PlayFrame.nullable() }),
  z.object({ t: z.literal("ws.frame"), workspaceId: id, frame: PlayFrame }),
  z.object({
    t: z.literal("ws.log"),
    workspaceId: id,
    message: z.string(),
    level: z.enum(["log", "error"]),
  }),
  /** セッションのホストへ：配置の追加・適用・削除・リセット・入力 */
  z.object({ t: z.literal("host.addPart"), part: HostPart }),
  z.object({
    t: z.literal("host.apply"),
    realm: id,
    outputId: z.string(),
    snapshot: z.unknown(),
    by: z.string(),
  }),
  z.object({ t: z.literal("host.removePart"), id }),
  z.object({ t: z.literal("host.resetPart"), id }),
  z.object({ t: z.literal("host.input"), input: PlayInput }),
  /** 自分がセッションのホストになった。parts はいまの配置すべて、resume は最後の状態 */
  z.object({
    t: z.literal("session.host"),
    parts: z.array(HostPart),
    resume: SessionFrame.nullable(),
  }),
  z.object({ t: z.literal("session.frame"), frame: SessionFrame }),
  z.object({ t: z.literal("session.log"), message: z.string(), level: z.enum(["log", "error"]) }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
