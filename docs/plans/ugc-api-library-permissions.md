# UGC API・権限・Library Package 計画案

- 状態: **Active**
- 対象: ResourcePathIndex / Diagnostic core 後、System binding と Runtime Host API を固定する前から段階的に着手
- 実装状況: U0 完了（ADR 0011〜0013、`packages/runtime/src/capabilities.ts` の型と Host API の棚卸し、`ugcBoundary.characterization.test.ts`）。U1 は途中（`HOST_API_ARGS`、呼び出し主体の配置、別の配置を「見つからない」にする既定境界は完了。PackageExecutionContext、要求 Capability、effective grant の強制は未実装）。U2 は最初の縦の一本まで（Raycast の opaque handle、`hit.send`、`hit.effect`、System の `contracts`、Built-in の Damage v1、出力の `exposure`、土台の World の `guestPolicy`、拒否の知らせ（`SystemStatus.warnings`）。書き方・初期値・Item の所属（最初の World）は利用者と決めた）
- U0 で利用者と決めたこと: 権限は置いた物（Placement）に与える／今は協調セッションに限り、サーバーの判定は U2 以降／境界はセッションに置いた World ごと／非公開の対象は「見つからない」
- 関連 ADR: [0001](../adr/0001-script-runtime-quickjs.md)、[0006](../adr/0006-session-world-apply-assets.md)、[0008](../adr/0008-private-work-world-editing.md)、[0010](../adr/0010-resource-identity-paths-diagnostics.md)
- ロードマップ: [`../ROADMAP.md`](../ROADMAP.md)

対象 baseline: `tukurium-prototype` main (`83eb5aad3ef01877a87efb8d569996f964732a3b`)

## 1. 目的

UGC が Item / World / Player の境界を越えて安全に相互作用し、公式・ユーザー製の再利用部品を同じ Library の仕組みで利用できる土台を作る。

次を同じ設計として扱う。

1. KokoState を、状態ではない入力・一時イベント・ホスト機能の万能な受け渡し手段にしない。
2. System から Physics / Input / Audio / Effect / World 操作へ触れる Host API を、型・検証・権限のある一つの境界へ集約する。
3. 呼び出し側の権限と、対象 Item / World が外部へ公開する操作を分ける。
4. 相手の内部 Entity / KokoState を公開せず、Collider、表面、一時 effect、公開 Contract だけを利用できるようにする。
5. stable package ID、version、exports、dependencies、capability requirements を持つ最小の Library Package を作る。
6. 公式 API を Library から使える形にしつつ、最終的な権限強制は QuickJS 内の利用者コードではなく Host / Server で行う。
7. 権限不足、未解決 dependency、API version 不一致を構造化 Diagnostic として扱う。

## 2. 非目標

初期段階では次を作り込まない。

- Library marketplace のランキング、評価、コメント、収益化、自動推薦
- 任意の npm package の直接実行
- UGC から DOM、`fetch`、Three.js、Rapier、ブラウザ API への直接アクセス
- 自動で最新版へ追従する dependency resolution
- あらゆるゲームジャンルを覆う巨大な公式 KokoState 集
- 別 World の内部状態へ暗黙に到達できるグローバル検索 API

## 3. 不変条件

### 3.1 KokoState は継続する状態

KokoState にするのは、保存・同期・復元・Inspector 表示の対象になる継続的なデータとする。

- Health / Inventory / Equipped / Transform は KokoState の候補。
- fire / reload / hit は一時的な Action / Event / Contract とする。
- raycast / audio.play / effects.spawn は Host Capability とする。
- 入力の押下を KokoState の boolean として立て、誰かが後で消す設計を標準にしない。

### 3.2 実効権限は複数の許可の共通部分

操作を許可するには、少なくとも次をすべて満たす。

1. 呼び出し Package / System が Capability を宣言している。
2. Item の配置または実行 context が Capability を grant されている。
3. World policy がその種類の外部操作を許可している。
4. 対象 resource / Item が操作または Contract を公開している。
5. Player の role / authority が必要条件を満たす。

利用者スクリプトが申告した `player`、target ID、permission は信用しない。Runtime gateway は実際の接続、配置、System、Package から context を組み立てる。ただし、現在のセッション Host は参加者のブラウザであり、改変クライアントに対する信頼境界にはならない。別所有者の state、永続操作、競争結果を保護する最終判定は Server authority が必要である。

### 3.3 権限強制は Runtime / Server authority 境界で行う

公式 Library は使いやすい API・型・標準 Contract を提供するが、セキュリティ境界にはしない。

```text
UGC System
  -> official / user Library API
  -> RuntimeHostApi capability gateway
  -> permission / target policy / schema validation
  -> Physics / World / Audio / Effect / Network
```

利用者が公式 wrapper を使わなくても、Runtime gateway を迂回できない構造にする。honest Host 上の sandboxed UGC を隔離する保証と、改変 Host client から他作者・他参加者を守る保証を区別し、後者を必要とする操作は Server で再検証または実行する。

### 3.4 発見と操作を分ける

対象の存在、Entity ID、内部 state を知れること自体が権限である。

- 非公開対象は permission denied ではなく not found 相当を返せるようにする。
- Raycast の結果は原則として生の Entity API を持たない opaque handle にする。利用者へ渡す handle ref は Host / Server 管理テーブルを指す推測困難な token とし、同じ形の JSON を作るだけでは利用できないようにする。
- position / normal / distance / 公開 surface のような衝突結果と、state.read / state.write を分ける。

### 3.5 別 World は既定で分離する

別 security domain の World との通信は Portal / Bridge / Message channel / Shared service のような明示的な接続だけにする。`world.getById()` や全体列挙から別 World へ暗黙に到達させない。現行は一つの Session Simulation と物理空間へ複数の World / Item output を置けるため、U0 で canonical `WorldInstanceId`、World output と Session の関係、各 Collider が従う policy scope を決めるまで、座標上の距離だけを security boundary とみなさない。

### 3.6 Package の version は不変

同じ package ID / version の内容を後から置き換えない。実行時には解決済み version と content hash を固定し、自動で最新版へ切り替えない。

### 3.7 脅威モデルと authority

初期段階で次を分けて扱う。

1. **sandboxed UGC からの保護**: 正規クライアント上の QuickJS code が、grant されていない Host API や対象へ到達できないこと。Runtime gateway で強制する。
2. **改変クライアントからの保護**: セッション Host 自身が gateway、frame、effect、Contract result を偽造しても、別所有者の永続 state、権限、競争結果を変更できないこと。Server-authoritative な検証または実行が必要。
3. **協調セッションの暫定範囲**: Server authority をまだ持たない操作は、同一所有者または参加者が Host を信頼する協調セッションに限定し、セキュリティ保証として表示しない。

U0 で操作ごとの authority matrix を作る。少なくとも state.write、entity.spawn / destroy、公開 Contract による永続変更、権限変更は Server authority がないまま「保護済み」としない。Physics query と cosmetic effect を Client / Host に残す場合も、結果から永続操作へ昇格できないようにする。

## 4. 概念モデル

### 4.1 主体と境界

| 概念 | 主な責務 |
| --- | --- |
| Player | 操作した本人と role |
| Package | コードと定義の出所、version、要求 Capability |
| System | Package 内の実行単位 |
| Item / Placement | World に置かれた実体と、配置単位の grant |
| Output | 配布・実行する resource closure |
| Workspace / Repository | 制作・所有・共同編集の境界 |
| World / Session | 外部 Item に対する上限 policy と authority |
| Runtime Host | sandboxed UGC の API gateway、schema validation、協調セッションの Simulation |
| Server | 接続元の確定、別所有者に影響する操作の authority、権限強制、監査 |

### 4.2 相互作用の種類

| 種類 | 例 | 初期方針 |
| --- | --- | --- |
| discover | Entity / resource の存在を知る | 既定拒否 |
| physics.query | raycast / overlap で Collider を検出 | World と対象の公開設定が必要 |
| state.read | 公開 KokoState / field を読む | field 単位まで拡張可能にする |
| state.write | 公開 state を変更 | 強い権限。初期は限定 |
| contract.send | Damage / Interact などを送る | 対象が公開した Contract のみ |
| effects.spawn | 弾痕、火花、一時音を出す | quota と寿命を持つ非永続操作 |
| entity.spawn | World へ永続 Entity を追加 | effects.spawn と分離 |
| entity.destroy | Entity を削除 | owner / admin を基本にする |

### 4.3 公開 Contract

相互運用を公式 KokoState の共有だけに依存させない。対象は入力 schema と policy を持つ Contract を公開できる。

例:

```text
Damage v1
input:
  amount: number
  type?: string
target policy:
  public / same-owner / role / deny
```

対象は内部で Health、Shield、部位破壊、無敵時間などを自由に実装し、外部には Damage Contract だけを公開できる。

### 4.4 opaque Hit Handle

Raycast は初期段階では次のような権限制限済み結果を返す。

```ts
interface HitHandleRef {
  /** Host / Server 管理テーブルを引く推測困難な token。Entity ID ではない */
  token: string;
  position: Vec3;
  normal: Vec3;
  distance: number;
  surface?: ResourceRef;
  // 生の Entity accessor は持たない
}
```

管理テーブル側には caller principal、PackageInstanceId、PlacementId、WorldInstanceId、run / revision、target、発行時刻、expiry、使用回数を保持する。`hit.send(Damage, payload)` や `effects.spawnAt(hit, effect)` は token を引き、handle の出所、現在の caller、scope、revision、対象 policy、距離、payload、quota を再検証する。scope の終了、apply / reset、host migration、revision 更新で失効させ、必要な操作は単回利用にする。利用者が同じ JSON を作る、別 System へ渡す、保存して後の run で使う、別 World へ送るだけでは利用できない。

## 5. Library Package の最小モデル

```ts
interface PackageManifest {
  id: PackageId;
  name: string;
  version: string;
  contentHash: string;
  publisher: PublisherId;
  exports: PackageExports;
  dependencies: PackageDependency[];
  capabilities: CapabilityRequirement[];
  apiVersion: string;
}
```

`contentHash` は manifest の自己申告値を信用しない。canonical serialization の対象（manifest から `contentHash` を除いた値、export された definitions / source / assets、dependency lock）と並び順を仕様化し、Registry が計算する。ローカル package でも同じ ID / version に異なる hash を登録したら拒否する。共有 release では Server registry が計算・保存・衝突拒否の正本になり、publisher identity と結び付ける。

初期 export kind:

- KokoState
- System
- Contract
- Script API
- Material / Model / Image / Audio
- Output / Template

内部参照は stable ID、source では package path / alias を使う。compile artifact に解決済み package version、resource binding、API version、Capability requirements を保存する。source と手編集可能な解決済み manifest を二重正本にしない。

U1 より前に、完全な配布機能とは独立して最小の実行主体を導入する。

```ts
interface PackageExecutionContext {
  packageInstanceId: string;
  packageId: PackageId;
  resolvedVersion: string;
  contentHash: string;
  systemId: ResourceId;
  placementId: string;
  worldInstanceId: string;
}
```

U1 / U2 の grant、handle、監査、Diagnostic はこの context を principal として使う。U3 は同じ identity を配布・dependency lock へ拡張し、暫定 realm / System key から別の権限 key へ作り直さない。

## 6. 権限設定 UX

内部モデルは操作単位で保持し、通常 UI はプリセットを中心にする。

初期プリセット:

1. **非公開**: 外部から存在・Collider・Contract・state を取得できない。
2. **衝突のみ**: 公開 Collider への physics query と制限付き一時 effect を許可する。
3. **インタラクション可能**: 公開 Contract を呼べる。
4. **読み取り可能**: 明示的に公開した state を読める。
5. **編集可能**: 明示的に許可した state / command を変更できる。
6. **カスタム**: 操作、Contract、field ごとに上書きする。

World policy は Item 側の設定に上限をかける。Item が World の禁止を上書きして強い権限を得ることはできない。

## 7. 段階的実装

### U0: ADR と characterization test

成果物:

- KokoState / Event / Capability / Package の責務 ADR
- runtime authority / target policy / public Contract ADR
- Package identity / version / exports / dependencies ADR
- 現在の銃、入力、Raycast、`world.emit`、Held 表示の characterization test

決定すること:

- Capability / Contract の stable identity と versioning
- Package / System / Placement のどれを grant 単位にするか
- policy inheritance と明示 deny の優先順位
- permission denied と hidden not-found の使い分け
- host migration 後に grant / handle / input authority をどう復元するか
- canonical `WorldInstanceId` と security domain、World output / Session / Placement の関係、Collider が従う policy scope
- 操作ごとの authority matrix（Runtime Host で足りる操作 / Server の再検証が必要な操作 / Server 実行に移す操作）
- 最小 `PackageExecutionContext` の生成・復元・監査方法

U0 は現在の `ProjectDependencyGraph` の次に始め、System binding / Runtime Host API の公開形を固定する前に完了する。

### U1: schema-first Capability gateway

最初の Capability:

- `physics.raycast`
- `interaction.send`
- `effects.spawn`
- `audio.play`

一つの定義から runtime validator、利用者向け型、API version、Diagnostic metadata を生成する。QuickJS との境界では入力・出力を `unknown` として検証する。

最初の slice で、既存の `world.get / set / find / spawn / destroy / emit / raycast / playSound` を含む全 Host API を棚卸しし、同じ gateway の deny-by-default な Capability 分類へ置く。移行中に残す legacy API は同じ PackageExecutionContext の内側だけに制限し、cross-Item / cross-World target を受け取れないようにする。旧 API の迂回路が残った状態を U1 完了としない。

Placement grant の保存形式と effective permission の計算も U1 の runtime model として実装し、PackageExecutionContext、要求 Capability、World policy と合わせて全 Host API で強制する。細かな設定 UI は U5 へ分離する。

### U2: target policy / Contract / opaque handle

最初の end-to-end behavior:

> 外部の銃が、保護された World の公開 Collider を Raycast し、内部 Entity / KokoState を取得せず、衝突点へ一時 effect を出し、公開された Damage Contract だけを呼ぶ。

- caller grant と target policy の双方を検証する。
- 非ホスト入力は Runtime gateway を通し、別所有者の永続 state や競争結果へ影響する操作は Server authority でも検証する。Server validation を実装していない操作は協調セッション限定と明示する。
- effect は非永続、寿命・個数・サイズ・距離に quota を持つ。
- 拒否は構造化 Runtime Diagnostic にする。
- Damage などの Contract request は authority が発行する request ID / idempotency key を持ち、scope 内の重複を一度だけ適用する。U0 で順序、再送、dedupe lifetime、host migration、apply / reset 後の失効を決め、重複配送と消失をテストする。

### U3: 最小ローカル Library Package

- stable package ID / immutable version / content hash
- canonical serialization と Registry が計算する content hash、同一 ID / version の衝突拒否
- exports / dependencies / capability requirements
- lock された dependency resolution
- unresolved / cycle / version / capability diagnostic
- package dependency edge を `ProjectDependencyGraph` に統合
- extract / fork で package provenance と binding を保つ

最初は同梱された公式 package とローカル dependency だけを扱い、検索 marketplace は作らない。

### U4: 公式 Platform Primitive / Library と reference UGC

UGC の種類を増やすため、Runtime Built-in、Host Capability、公式 Library を段階的に拡張する。API の網羅的な一覧を先に固定せず、reference UGC を end-to-end で実装し、共通性または Host 境界としての必要性が確認できた機能だけを、設計レビュー後に適切な層へ昇格させる。

#### U4 の開始条件

公開 API の横展開は次を満たしてから始める。開始条件を満たす前でも、reference UGC 内の experimental API として必要性を検証してよいが、stable API として公開しない。

- 全 Host API が共通の schema-first gateway を通る。
- PackageExecutionContext と effective Placement grant / World policy を実行時に評価できる。細かな設定 UI は U5 で追加してよい。
- U3 の最小 Library Package、immutable version、dependency lock が利用できる。
- Capability の schema、権限、authority、quota、Diagnostic を一つの正本から定義できる。
- API version、互換性、deprecated API、Package / snapshot migration の規則が決まっている。

#### 層の使い分け

- **Runtime Built-in**: 保存、同期、identity、物理、描画、authority のため、Runtime が直接理解する必要がある最小のデータ。Snapshot / migration の対象になる。
- **Host Capability**: QuickJS の外側にある物理、入力デバイス、音声、描画、Player、World / Server 機能へ、schema・権限・quota 付きで到達する境界。
- **公式 Library**: Built-in、Capability、Contract、KokoState を組み合わせる version 付き Package。セキュリティ境界にはせず、Runtime gateway を迂回できる特権も持たせない。
- **reference UGC**: API の必要性、使いやすさ、権限、lifecycle を実測する作品。利用例と end-to-end の検証対象にはするが、unit / conformance test の代わりにはしない。

Health、Inventory、Equipment のようなドメインモデルは、Runtime が直接理解する理由がなければ Built-in にせず公式 Library を優先する。Three.js、Rapier、DOM、ブラウザ API を UGC へ直接公開しない。

#### 最初の縦切り

1. **銃と的**: Input Action、Equipment、Raycast、Damage、Effect、Audio。銃自身には ammo / damage / cooldown / reload のドメインロジックを残す。
2. **扉とスイッチ**: Interact Contract、継続状態、Animation、外部操作の権限。
3. **収集物と Inventory**: Player、Pickup Contract、所有権、Entity lifecycle。

移動床、乗り物、NPC、HUD は、最初の三本で基盤を実測した後の候補とする。特に UI、外部物体への impulse、joint、Server-authoritative な操作は、権限・同期・ownership を別途判断してから追加する。

入力は一つの責務にまとめず、デバイスと action mapping は Host Capability、System へ届く `fire` / `jump` / `interact` は Event / Action、割り当ては保存される設定、操作した Player の identity は Server authority として分ける。

#### 初期候補ドメイン

- Core: identity、Transform、hierarchy、time、lifecycle
- Input: action mapping、pointer、keyboard、gamepad
- Spatial / Physics: raycast、overlap、trigger、surface。書き込み操作は自分の Placement から始める
- Player: Player reference、role、avatar、equipment、camera
- Interaction: Interact、Damage、Use、Pickup などの公開 Contract
- Effects / Audio: particle、decal、trail、spatial audio、一時 effect
- UI: 権限制限された宣言的 HUD / prompt の調査。DOM は公開せず、別 ADR を実装条件とする

この一覧は実装の約束ではなく候補 backlog とする。実際の reference UGC で必要性を確認し、昇格条件を満たしたものだけを公開 API として固定する。

公式 Library の候補:

- `@tukurium/core`
- `@tukurium/input`
- `@tukurium/interaction`
- `@tukurium/effects`
- 必要性を確認後に `@tukurium/equipment` / `@tukurium/combat-contracts` / `@tukurium/inventory`

#### 公式 API への昇格条件

次のいずれかを満たす機能を昇格候補とする。

- 独立した二つ以上の UGC で共通して必要になった。
- Runtime / Host 境界でしか安全に提供できない。
- Package 間相互運用のため、共通の identity または Contract が必要になった。

候補を昇格する前に次を定義し、設計レビューする。

- stable identity、version、入力 / 出力 schema
- Runtime Built-in / Host Capability / 公式 Library のどの層かと、その理由
- caller、target、World、Player の権限と hidden / denied の扱い
- Runtime Host / Server の authority、ネットワーク配送、再送 / 重複時の意味
- 保存、同期、reset、host migration、Package / snapshot migration 後の lifecycle
- quota、失敗時の挙動、構造化 Diagnostic、partial failure の封じ込め
- 利用者向け型・ドキュメント、unit test、conformance test、必要な end-to-end test

#### 安定性

公式 API は `experimental`、`preview`、`stable`、`deprecated` の状態を持つ。reference UGC で最初に使う API は experimental とし、互換性と権限モデルを実測してから段階的に昇格する。

- `experimental`: API identity に実験 revision を含め、Package は exact revision を固定する。互換性なく変更できるが、共有する stable Package からは依存できず、利用箇所へ Diagnostic を出す。
- `preview`: stable 候補の identity と major version を持つ。昇格条件、authority、schema、quota、conformance test が揃った段階で入り、既知のブロッカーを解消して reference UGC で実測する。Runtime が実行を保証するのは各 API identity の最新 preview major だけとする。破壊的変更は preview major を上げ、旧 preview major の利用箇所に migration と Diagnostic を用意してから置き換える。
- `stable`: Capability / Contract は exact major、公式 Library は解決済みの exact semver と content hash を Package lock に固定する。同じ major の schema と意味は後方互換にする。Runtime は API identity ごとに最新と直前の stable major を同時にサポートする。
- `deprecated`: stable major `N` は、後継の `N+1` を stable にした時点で代替 API と migration を示して deprecated にできる。`N` は直前の stable major として実行を保ち、さらに `N+2` を stable にするときにだけサポート対象から外せる。
- Runtime は未対応 version / revision を構造化 Diagnostic にし、暗黙に近い版へ読み替えない。
- `server-revalidate` / `server-execute` が必要な API は、Server authority を実装するまで協調セッション向けの experimental とし、保護済みの stable API として公開しない。

#### U4 の完了条件

- 最初の三つの reference UGC が公開 API だけで実装できる。
- 非公開 Entity ID、内部 KokoState、DOM、Three.js、Rapier、無制限な `world.*` に直接依存しない。
- 共通機能が複数の UGC から再利用されるか、Host 境界に置く理由がテストで実証される。
- すべての Host Capability に schema、version、権限、authority、quota、Diagnostic、unit / conformance test がある。
- 公式 Library を使わなくても Runtime gateway を迂回できない。
- reference UGC の不足を万能な KokoState や権限制限のない API で回避していない。

### U5: Dependencies / Permissions / Problems UI

- Project が使う package / version / publisher
- export と使用箇所
- requested / granted / denied Capability
- World / Item の権限プリセットと詳細設定
- package update の preview と互換性 Diagnostic
- unresolved dependency / denied capability / hidden target / invalid payload / rate limit を Problems に統合

### U6: ユーザー間 Library

基盤の実測後に追加する。

- publish / search / install / fork / version list
- publisher identity と公式認証
- license / provenance / dependency 表示
- server-side manifest / content hash verification
- immutable release と明示的な update

ランキング、評価、収益化、自動推薦は別判断にする。

## 8. 最初の acceptance criteria

### Boundary / permission

- 外部 Item は非公開 Entity / KokoState を列挙・取得できない。
- 公開 Collider には Raycast が当たり、position / normal / distance を取得できる。
- Raycast result から生の Entity APIへ昇格できない。
- forged / expired / wrong-caller / wrong-placement / wrong-world / stale-revision の handle token は拒否される。
- 対象が公開した Contract だけを呼べる。
- World の deny を Item / Package が上書きできない。
- 非ホストが player / package / permission / target を偽装しても Runtime gateway で拒否され、別所有者に影響する操作は改変 Host client が送っても Server authority で拒否される。
- 別 World は明示的な Bridge なしに発見・操作できない。
- denied / hidden / invalid / rate-limited を構造化して区別し、hidden target の存在を漏らさない。
- 同じ Contract request の再送・二重配送は一度だけ適用され、dedupe scope の終了や migration / reset 後の扱いがテストで固定される。

### Effect

- Collider の表面へ許可された一時 effect を出せる。
- effect は永続 World state、Git、snapshot migration の対象にならない。
- effect の寿命・数・距離・payload が Runtime gateway で制限され、別参加者へ配る effect は Server が接続元と quota を検証する。

### Package / Library

- package の rename 後も stable ID は変わらない。
- 同じ package ID / version の content hash を置き換えられない。
- content hash は定めた canonical serialization から Registry が計算し、manifest の自己申告値だけでは登録できない。
- dependency は解決済み version に固定される。
- export されていない resource は外部 import できない。
- dependency cycle / missing version / API mismatch / capability denial が Diagnostic になる。
- official 表示は名前ではなく publisher identity で決まる。

## 9. 自己レビューで重点確認すること

- Raycast / overlap / collision が非公開対象の存在や位置を漏らさないか。
- opaque handle を保存・転送・別 World で再利用できないか。
- host migration、apply、reset、fork、extract 後に古い grant や handle が残らないか。
- Package が依存 Package の Capability を権限昇格に使えないか。
- 一時 effect から物理・永続 state・ネットワーク送信へ昇格できないか。
- Contract payload から prototype pollution、巨大配列、NaN / Infinity、循環値が入らないか。
- 同じ入力の再送・遅延・二重配送で Damage 等が重複しないか。
- denial Diagnostic 自体が private resource の存在を漏らさないか。
- 権限設定 UI のプリセットと実際の effective permission が食い違わないか。

## 10. 最初の作業単位

最初の PR は次に限定する。

1. U0 の三つの ADR と、操作ごとの authority matrix を追加する。
2. 現在の銃 / Held / input mapping / Raycast / cross-Item event の characterization test を追加する。
3. Capability / Contract / Package の stable ID、最小 `PackageExecutionContext`、schema の型だけを置く場合も、まだ既存 runtime API を削除しない。
4. production behavior は変えず、次の U1 vertical slice の RED test を一つ明示する。

その後、U1 / U2 は「保護された World の公開 Colliderへ銃が effect と Damageを送る」一本を end-to-end で通し、API を横に増やす前に権限境界を実証する。
