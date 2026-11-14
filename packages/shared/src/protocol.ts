import { z } from "zod";

/**
 * 通信プロトコルの版。互換性のない変更をしたら上げる。
 * 8：メッセージを、タグ付きの JSON（ADR 0065）で運ぶ。フィールドの値に undefined・Date・Map・Set・
 * bigint・NaN が入り、参照の「なし」は null から undefined に変わった。送るときは stringifyValue、
 * 受けるときは parseValue（@tukurium/eks）を使う。
 * 9：制作データのフィールドの型が、決まった名前（vec3 など）から TypeScript の型の文（Vec3 など）に変わった。
 * 配置・適用・ホストへの配置に、フィールドのスキーマ（schemas）を付けられる。
 * 10：編集中の制作データ（Y.Doc）の KokoState の定義が、フィールドごとの Y.Map になった。
 * 11：制作データに、型の定義（types）と、KokoState が使う型の定義の一覧（typeDefs）が入った。
 * 12：参照から読み書きする Host API（world.getState など）と、参照の値（KokoState・フィールドの参照）が入った。
 * 14：制作データに、プレハブ（prefabs・prefabEntities）と、インスタンスの印（Entity の instanceOf）が入った
 * （ADR 0076）。
 */
export const PROTOCOL_VERSION = 16;

/** エージェントの視点プレビュー（ADR 0059）。開いている画面がこの大きさで撮る */
export const PREVIEW_SHOT_WIDTH = 960;
export const PREVIEW_SHOT_HEIGHT = 540;

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

export const UserInfo = z.object({
  id,
  name: z.string(),
  /** ログインに使ったアカウント（例：`@rhenium@misskey.resonite.love`）。エージェントは持たない */
  account: z.string().optional(),
  /** アイコンの画像の URL（ADR 0074） */
  avatarUrl: z.string().optional(),
});
export type UserInfo = z.infer<typeof UserInfo>;

export const SocialProfile = z.object({
  availability: z.enum(["joinable", "online", "ask", "busy"]),
  note: z.string().trim().max(120),
});
export type SocialProfile = z.infer<typeof SocialProfile>;

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

/**
 * 置いた物への付与（ADR 0012）。Capability の ID の一覧。null は「コードから読み取った宣言どおり」。
 * 古いサーバー・ホストからは届かないので、ないときは null
 */
export const PlacementGrants = z
  .array(z.string().regex(/^[a-z]+\.[a-z]+$/))
  .max(32)
  .nullable()
  .default(null);

/** セッションに配置された実体（ワークスペースのアウトプット 1 回分） */
export const PlacementInfo = z.object({
  id,
  /** ワークスペースから出した配置（適用できる）。作品のリリースから置いた配置なら null */
  workspaceId: id.nullable(),
  releaseId: id.nullable(),
  workspaceName: z.string(),
  outputId: z.string(),
  outputName: z.string(),
  /** 置いたアウトプットの種類。ワールドが、セッションで開いている空間 */
  outputKind: z.enum(["item", "world", "library"]).nullable().default(null),
  position: vec3,
  yaw: z.number(),
  placedBy: id,
  grants: PlacementGrants,
});
export type PlacementInfo = z.infer<typeof PlacementInfo>;

/**
 * ルートワールドを入れ替える前のカウントダウン（ADR 0066）。
 * セッションの状態に載せるので、途中から参加した人も残り時間を見る。
 * 無いときは、入れ替えの予定がない。
 */
export const WorldChange = z.object({
  id,
  releaseId: id,
  worldName: z.string(),
  /** 変えようとした人の名前 */
  byName: z.string(),
  /** このメッセージを送った時点から、入れ替わるまでのミリ秒 */
  remainingMs: z.number().int().min(0).max(60_000),
});
export type WorldChange = z.infer<typeof WorldChange>;

export const SessionInfo = z.object({
  id,
  name: z.string(),
  owner: id,
  participants: z.array(UserInfo),
  workspaces: z.array(WorkspaceInfo),
  placements: z.array(PlacementInfo),
  /** セッションの世界を実行している人（持ち主）。いなければ null */
  host: id.nullable(),
  /** ルートワールドの入れ替え予定。無い、または古いサーバーでは null */
  worldChange: WorldChange.nullable().default(null),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SessionSummary = z.object({
  id,
  name: z.string(),
  owner: UserInfo,
  count: z.number(),
  participants: z.array(UserInfo).default([]),
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
   * 入力した人の表示名。無いときは空。
   * 本人の確定は player の ID で、名前は画面に出すため（今はクライアントの申告どおり。ADR 0012）。
   */
  playerName: z.string().max(32).optional(),
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

/** 一時的な effect（保存しない。ADR 0012） */
export const EffectEvent = z.object({
  kind: z.enum(["spark"]),
  position: vec3,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  size: z.number().min(0).max(1),
  life: z.number().min(0).max(2),
});

/** System の状態（止まった理由と行） */
export const SystemStatusInfo = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  error: z.string().nullable(),
  line: z.number().int().nullable().default(null),
  /** 止まるほどではない注意（拒否など）。古いホストからは届かないので、ないときは空 */
  warnings: z
    .array(z.object({ code: z.string(), message: z.string(), count: z.number().int() }))
    .max(16)
    .default([]),
});

/** ホストが配信する実行状態。world は EKS の WorldSnapshot。 */
/** バッグの中の 1 個（ADR 0018）。種類はライブラリの KokoState の ID、値はフィールドの名前で持つ */
export const BagItem = z.object({
  type: z.string().max(200),
  name: z.string().max(80),
  values: z.record(z.string(), z.unknown()),
});
/** プレイヤー → バッグ。ホストが替わっても引き継げるよう、フレームに入れて配る */
const Bags = z.record(z.string(), z.array(BagItem).max(64));
/** 配置 → Entity。実行中に作った物の処理・削除のため、ホスト交代時にも所属を戻す。 */
const PartEntities = z.record(z.string(), z.array(z.string()));

export const DebugStop = z.object({
  change: z
    .object({
      entity: z.string(),
      koko: z.string(),
      field: z.string(),
      oldValue: z.unknown(),
      newValue: z.unknown(),
      source: z.string(),
    })
    .optional(),
  message: z.string().optional(),
  states: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        fields: z.array(z.object({ id: z.string(), name: z.string(), value: z.unknown() })),
      }),
    )
    .default([]),
  id: z.string(),
  systemId: z.string(),
  entity: z.string().nullable(),
  line: z.number(),
  reason: z.string(),
  frames: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      line: z.number(),
      variables: z.array(
        z.object({
          name: z.string(),
          value: z.unknown(),
          writable: z.boolean(),
          unavailable: z.boolean().optional(),
          state: z.object({ entity: z.string(), koko: z.string() }).optional(),
          binding: z.string().optional(),
        }),
      ),
      systemId: z.string().optional(),
    }),
  ),
});
export type DebugStop = z.infer<typeof DebugStop>;
export const DebugCommand = z.enum(["continue", "pause", "edit", "into", "over", "out", "frame"]);
export const DebugValueEdit = z.union([
  z.object({
    kind: z.literal("variable").optional(),
    frameId: z.number(),
    name: z.string(),
    value: z.unknown(),
  }),
  z.object({
    kind: z.literal("state"),
    entity: z.string(),
    koko: z.string(),
    field: z.string(),
    value: z.unknown(),
  }),
]);

export const PlayFrame = z.object({
  debugStart: z
    .object({
      world: z.unknown(),
      names: z.record(z.string(), z.string()),
      time: z.number(),
      bags: Bags,
      partEntities: PartEntities,
      queues: z.unknown(),
      systems: z.array(SystemStatusInfo),
    })
    .nullable()
    .optional(),
  debug: DebugStop.nullable().optional(),
  sounds: z.array(SoundEvent).max(32).optional(),
  effects: z.array(EffectEvent).max(32).optional(),
  mode: PlayMode,
  outputId: z.string(),
  time: z.number(),
  world: z.unknown(),
  names: z.record(z.string(), z.string()),
  status: z.array(SystemStatusInfo),
  bags: Bags.optional(),
  partEntities: PartEntities,
});
export type PlayFrame = z.infer<typeof PlayFrame>;

/** セッションのホストが配る、セッションの世界の状態 */
export const SessionFrame = z.object({
  sounds: z.array(SoundEvent).max(32).optional(),
  effects: z.array(EffectEvent).max(32).optional(),
  time: z.number(),
  world: z.unknown(),
  names: z.record(z.string(), z.string()),
  /** 表示用のマテリアル（ID はリポジトリごとに付け替え済み） */
  materials: z.array(z.unknown()),
  status: z.array(SystemStatusInfo),
  bags: Bags.optional(),
  partEntities: PartEntities,
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
  /** 依存の中身（サーバーが持ち主の許可で取り出したもの。依存がなければない。ADR 0015） */
  packages: z.array(z.unknown()).optional(),
  /** フィールドのスキーマ（出した人の画面か、サーバーが作る。なければ、型の文から分かる分だけで確かめる。ADR 0065） */
  schemas: z.unknown().optional(),
  position: vec3,
  yaw: z.number(),
  grants: PlacementGrants,
});
export type HostPart = z.infer<typeof HostPart>;

/**
 * 自分が開いているパネルの公開用の情報。内容（lines）はサーバーが権限を確かめてから相手に渡す。
 * 3D 表示ならその位置、2D 表示なら本人の視界の中の同じ所（画面上の位置）に見せる。
 */
export const PanelPublic = z.object({
  id: z.string().max(64),
  title: z.string().max(80),
  workspaceId: id.nullable(),
  mode: z.enum(["2d", "3d"]),
  transform: z.object({ position: vec3, yaw: z.number() }).nullable(),
  /** パネルの大きさ（px）。空間では 1px = PANEL_METERS_PER_PX で見せる */
  size: z.object({
    width: z.number().min(1).max(4000),
    height: z.number().min(1).max(4000),
  }),
  /** 2D 表示のとき、画面（3D の描画領域）の中のパネルの中心と、画面の大きさ（px） */
  screen: z
    .object({
      x: z.number(),
      y: z.number(),
      viewWidth: z.number().min(1).max(10000),
      viewHeight: z.number().min(1).max(10000),
    })
    .nullable(),
  lines: z.array(z.string().max(120)).max(12),
});
export type PanelPublic = z.infer<typeof PanelPublic>;

// ---------------------------------------------------------------------------
// クライアント → サーバー

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.number(),
    /**
     * 本人は接続したときのログインの Cookie で決まる（ADR 0074）。名前は AI エージェントの
     * 内部の接続だけが使う（人の接続では無視する）
     */
    name: z.string().min(1).max(40).optional(),
  }),
  z.object({ t: z.literal("rename"), name: z.string().min(1).max(32) }),
  z.object({ t: z.literal("sessions.list") }),
  z.object({
    t: z.literal("session.create"),
    name: z.string().min(1).max(64),
    requestId: id.optional(),
    /**
     * このリリースを、セッションの最初のルートワールドにする（ADR 0066）。
     * セッションは新しいので、カウントダウンは出さない。
     */
    worldReleaseId: id.optional(),
  }),
  z.object({ t: z.literal("session.join"), sessionId: id, requestId: id.optional() }),
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
  /** 自分だけ出る。ワークスペースはセッションに残る */
  z.object({ t: z.literal("ws.close"), workspaceId: id }),
  /** ワークスペースを閉じる（管理権限）。一覧からなくなり、開いていた人も出る */
  z.object({ t: z.literal("ws.end"), workspaceId: id }),
  z.object({ t: z.literal("ws.update"), workspaceId: id, update: b64 }),
  z.object({ t: z.literal("ws.debugUpdate"), workspaceId: id, update: b64 }),
  z.object({
    t: z.literal("ws.debugCommand"),
    workspaceId: id,
    cmd: DebugCommand,
    edit: DebugValueEdit.optional(),
    stopId: z.string().optional(),
  }),
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
    schemas: z.unknown().optional(),
    position: vec3,
    yaw: z.number(),
  }),
  /** ホストだけが送る：編集中の見た目 */
  z.object({ t: z.literal("ws.preview"), workspaceId: id, preview: WorkspacePreview }),
  /** リポジトリをこのセッションのワークスペースとして開く（1 リポジトリ 1 ワークスペース） */
  z.object({ t: z.literal("ws.openRepo"), repoId: id }),
  /** コミット（意図的な保存）。メッセージ付き */
  z.object({ t: z.literal("ws.commit"), workspaceId: id, message: z.string().max(500) }),
  /** 開いている画面からの撮影の結果（ADR 0059）。png は base64 */
  z.object({
    t: z.literal("ws.shot"),
    workspaceId: id,
    requestId: id,
    png: b64.optional(),
    error: z.string().max(500).optional(),
    pending: z.boolean().optional(),
  }),
  /** 作品のリリースをセッションに置く（作品の「利用」権限） */
  z
    .object({
      t: z.literal("placeRelease"),
      releaseId: id,
      position: vec3,
      yaw: z.number(),
      requestId: id.optional(),
      sessionId: id.optional(),
    })
    .refine(
      (message) => Boolean(message.requestId) === Boolean(message.sessionId),
      "要求IDと対象セッションは一緒に指定してください",
    ),
  /**
   * 公開されたワールドを、このセッションのルートワールドにする。
   * それまで開いていたワールドは外れ、選んだリリースが原点に置かれる。アイテムは残る。
   * 入れ替えの前に、セッションの全員へカウントダウンを出す（ADR 0066）。
   */
  z.object({ t: z.literal("session.openWorld"), releaseId: id }),
  /** 適用：このワークスペース・アウトプットにリンクしている配置をすべて更新する */
  z.object({
    t: z.literal("apply"),
    workspaceId: id,
    outputId: z.string(),
    snapshot: z.unknown(),
    schemas: z.unknown().optional(),
  }),
  z.object({ t: z.literal("unplace"), placementId: id }),
  /** 置いた物への付与を変える（セッションの持ち主・置いた人・そのワークスペースの共同編集以上。null で宣言どおり） */
  z.object({ t: z.literal("setGrants"), placementId: id, grants: PlacementGrants }),
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
  z.object({ t: z.literal("social.changed") }),
  z.object({
    t: z.literal("placement.result"),
    requestId: id,
    sessionId: id,
    placementId: id.nullable(),
    error: z.string().nullable(),
  }),
  z.object({ t: z.literal("welcome"), protocol: z.number(), you: UserInfo }),
  /** ログインしていない（期限切れ・ログアウトを含む）。このあと接続は閉じられる */
  z.object({ t: z.literal("auth.required") }),
  z.object({ t: z.literal("sessions"), sessions: z.array(SessionSummary) }),
  z.object({ t: z.literal("session.entered"), sessionId: id, requestId: id.optional() }),
  z.object({
    t: z.literal("session.rejected"),
    sessionId: id,
    requestId: id.optional(),
    message: z.string(),
  }),
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
  z.object({ t: z.literal("ws.debugDoc"), workspaceId: id, update: b64, full: z.boolean() }),
  z.object({
    t: z.literal("ws.debugCommand"),
    workspaceId: id,
    cmd: DebugCommand,
    edit: DebugValueEdit.optional(),
    stopId: z.string().optional(),
    from: id,
  }),
  z.object({ t: z.literal("ws.denied"), workspaceId: id, reason: z.string() }),
  /** ワークスペースが閉じられた。開いていた人に届く */
  z.object({ t: z.literal("ws.ended"), workspaceId: id, reason: z.string() }),
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
    packages: z.array(z.unknown()).optional(),
    schemas: z.unknown().optional(),
    by: z.string(),
  }),
  z.object({ t: z.literal("host.removePart"), id }),
  z.object({ t: z.literal("host.resetPart"), id }),
  z.object({ t: z.literal("host.setGrants"), id, grants: PlacementGrants }),
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
  /** 開いている画面へ、制作データの座標系で撮影を頼む（ADR 0059） */
  z.object({
    t: z.literal("ws.capture"),
    workspaceId: id,
    requestId: id,
    position: vec3,
    target: vec3,
    fov: z.number().min(10).max(120).optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
