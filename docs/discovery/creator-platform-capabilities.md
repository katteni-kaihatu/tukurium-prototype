# Creator Platform 機能候補

- 状態: **Discovery**
- 実装順: **未決定**
- 正本の範囲: UGC の制作・表現・配布を広げる候補の比較と昇格判断
- ロードマップ: [`../ROADMAP.md`](../ROADMAP.md)
- 関連する Active 計画: [`../plans/ugc-api-library-permissions.md`](../plans/ugc-api-library-permissions.md)

## 1. この文書の位置付け

ここには、価値がありそうだが実装時期・仕様・採用可否をまだ決めていない機能を置く。名前だけのアイデア集にはせず、利用者価値、責務を置く層、最小の縦切り、前提、検証方法までは整理する。一方、ここへの掲載や Focus 選定は、実装、公開 API の安定化、互換性維持を約束しない。

採用済みの設計は ADR、着手する仕事と受け入れ条件は Active plan、現在利用できる機能は README を正本とする。この文書と実装が食い違う場合は実装を優先し、候補を無言で現在仕様として扱わない。

## 2. 層と利用時点

| 層 | 責務 |
| --- | --- |
| Editor 機能 | 選択、編集、履歴、プレビューなど、作者が制作時に使う操作 |
| Runtime Built-in | 保存、同期、identity、描画、authority のため Runtime が直接理解すべき最小データ |
| Host Capability | QuickJS 外の入力、物理、描画、音声、Player / World 操作へ権限付きで到達する境界 |
| 公式 Library | Capability、Contract、KokoState を組み合わせる再利用部品。権限の強制境界にはしない |
| Package / 公開 metadata | ライセンス、出所、依存、翻訳可能な表示情報など、install・fork・公開に必要な情報 |
| Reference / Sample UGC | API の検証、学習、改造、回帰確認に使う作品。unit / conformance test の代わりにはしない |

制作時だけの機能を安易に Runtime Built-in へ入れず、実行時に強い作用を持つ機能を権限なしの Library だけで提供しない。

## 3. 運用方法

### 3.1 状態

候補は次の状態で管理する。API の `experimental / preview / stable / deprecated` lifecycle とは別の、企画上の状態である。

- **Candidate**: 調査対象として記録済み。着手時期と採否は未決定
- **Focus**: 次に解像度を上げる対象。常時最大 5 件とし、実装順は表さない
- **Promoted**: 昇格条件を満たし、個別の Active plan または既存計画の明示的な slice へ移した
- **Parked**: 現時点では追わない。理由と再検討条件を残す

### 3.2 候補の追加

候補を追加するときは、少なくとも次を記載する。

1. 解決したい問題と代表ユースケース
2. 主な層と、制作時・実行時のどちらで使うか
3. identity、権限、authority、保存・同期、API、アセット形式に関する前提
4. 最小の縦切りと、後回しにできる高度機能
5. Reference / Sample UGC での検証方法
6. 未決定事項

項目を埋められない場合も推測で仕様を固定せず、未決定事項として残す。

### 3.3 Focus の選定と見直し

Focus は、次の観点を文章で比較して選ぶ。見栄えだけの点数付けや、根拠の薄い合計点で固定しない。

- 他の候補を解放する基盤性
- 複数の UGC での再利用性と利用者価値
- 現在の Active plan、Package、権限、Diagnostic との接続
- 小さな end-to-end slice で検証できるか
- 後から変更すると互換性、安全性、データ移行へ与える影響

関連する Active plan の phase 完了時、ROADMAP の numbered section 完了時、重大な前提変更時、または候補を Active plan へ昇格した時に見直す。Focus が 5 件を超える場合は、何を外すかと理由を同じ変更で記録する。

候補の一部が既に Active plan に含まれる場合は、Active な slice へのリンクと Discovery に残す範囲を候補内で分ける。同じ受け入れ条件を Focus と Active の両方で管理しない。残りの探索範囲がなくなった時だけ候補全体を Promoted にする。

### 3.4 Active plan への昇格条件

次が揃うまで、ロードマップの実装チェック項目や stable API に昇格させない。

- 最小の縦切りと非目標が明確
- 層の分担と、保存・同期・authority・権限の責任主体が説明できる
- 既存 API で代替できない理由、または既存機能を統合する理由がある
- Reference UGC と自動テストの両方で検証する方法がある
- 依存関係、migration、Diagnostic、性能上限の主要リスクが列挙されている
- 公開 API を伴う場合は identity、schema、version、lifecycle の案がある

昇格時は個別 plan へ受け入れ条件と実装順を移し、この文書にはリンクと判断理由だけを残す。設計を採用したら ADR に記録する。候補を外す場合も削除で経緯を消さず、Parked と再検討条件を残す。

## 4. 現在の Focus 5件

この 5 件は優先順位順ではない。制作の安全性、現在進行中の Package / UGC API 基盤との接続、後続候補を解放する度合いを重視して選んだ。

1. **Undo / Redo** — Brush と Timeline を含む制作ツール全体の安全な編集 transaction の前提
2. **Animation** — キャラクター、装置、演出で再利用され、Timeline などの基礎になる表現 primitive
3. **Camera** — Player の視点へ作用するため、権限・競合・アクセシビリティを API 固定前に検証する必要がある
4. **License / provenance** — Package の依存・install・fork・公開が進む前に、出所と継承を失わないデータモデルが必要
5. **Sample UGC の充実** — Reference UGC から公式 API を育て、利用者が学習・改造できる検証ループを作る

Particle、Timeline、Brush、Post processing は上記の基盤から利益を受けるため Candidate に置く。Video と多言語化も重要だが、媒体・配布範囲を決めてから縦切りを選ぶ。HUD（10.1）は多くの UGC が要るが、DOM を公開しない宣言的な形と、別の作者の表示が重なったときの規則を決めてから縦切りを選ぶ。

## 5. 制作基盤

### 5.1 Undo / Redo

- 状態: **Focus**
- 価値と例: 誤操作から安全に戻す。Entity の作成・削除、移動、property 変更を試行錯誤できる。将来の Brush stroke と Timeline 編集の前提になる
- 主な層・利用時点: Editor 機能、制作時。履歴の identity と transaction metadata は workspace model と同期層に関係する
- 境界・前提: transaction / author / resource identity を持つ。編集権限の範囲で、各 author の Editor が自分の履歴だけを管理する。変更結果は Yjs で同期・保存するが履歴自体を永続化するかは未決定。Runtime API や実行時 asset にはしない
- 最小スコープ: 単一作者の Entity 作成・削除・transform・主要 property 変更を、意味のある一操作単位で Undo / Redo する。他参加者の変更を壊さず、自分の操作だけを戻せることを検証する
- 後回し: 複数文書をまたぐ transaction、履歴 UI、任意地点への time travel、branching history、大規模 Brush / import の部分 Undo
- 検証 UGC: 小部屋を編集し、壁・扉・ライトを配置して移動・削除・復元する共同制作シナリオ
- 未決定: Yjs UndoManager をそのまま使える範囲、resource rename / move、stable ID の再利用規則、server commit 後の履歴保持

### 5.2 Brush

- 状態: **Candidate**
- 価値と例: 木、岩、小物などを面へ連続配置し、環境制作を速くする
- 主な層・利用時点: Editor 機能、制作時。生成結果は既存 Entity / resource として保存し、Runtime 専用 Brush API は作らない
- 境界・前提: stroke / author / 配置 asset identity を持つ。編集権限を持つ authoring client が stroke の authority を持ち、生成結果を既存 Entity / resource として Yjs へ同期・保存する。Editor command の形と共同編集中の競合規則は未決定で、Runtime API は作らない
- 最小スコープ: 選択した既存 asset を地表へ間隔指定で配置する Placement Brush。1 stroke を1回で Undo できる
- 後回し: Terrain sculpt、texture paint、voxel、植生 batching、pressure、custom brush script
- 検証 UGC: 小さな庭を木と岩で作り、再現可能な stroke、保存サイズ、共同編集、Undo を測る
- 未決定: 「Brush」をどの編集対象まで含めるか、生成物を個別 Entity と instance 群のどちらで持つか

## 6. 動き・演出

### 6.1 Animation

- 状態: **Focus**
- 価値と例: キャラクターを歩かせる、扉を開く、機械を動かす。複数ジャンルで繰り返し使う表現の土台
- 主な層・利用時点: Runtime Built-in の clip / binding / playback state、権限付き Host Capability、Editor の preview。制作時と実行時の両方
- 境界・前提: clip / binding / target identity と version 付き playback schema を持つ。制御には Capability grant を要求する。gameplay は Server authority、cosmetic は client authority の候補とし、開始時刻・再生状態の同期範囲は未決定。asset はまず Package 内の glTF animation を候補にする
- 最小スコープ: Project 内の model に含まれる clip を名前ではなく安定した参照で選び、play / pause / stop / loop / speed を単一対象で制御する。再参加時の状態を定義する
- 後回し: blend tree、retargeting、IK、state machine editor、root motion、property animation、network prediction
- 検証 UGC: 開閉する扉と、idle / walk clip を切り替える単純な NPC。単独再生とセッションで同じ結果になることを確認する
- 未決定: glTF animation の正規化範囲、Server authority が必要な gameplay animation と各 client だけの cosmetic animation の分離

### 6.2 Timeline animation / Sequencer

- 状態: **Candidate**
- 価値と例: Camera、Animation、Audio、Effect、Event を時間軸で合わせ、カットシーンや装置演出を視覚的に作る
- 主な層・利用時点: Editor の timeline authoring、Runtime Built-in の timeline asset / playback、必要な Host Capability。制作時と実行時の両方
- 境界・前提: sequence / track / binding identity を持つ timeline asset を Package に保存する。編集は author の権限と Undo transaction、実行は track ごとの Camera / Event Capability grant に従う。playback authority と途中参加時の同期、timeline asset の schema / format、Editor / Runtime API の identity と lifecycle は未決定
- 最小スコープ: Transform または Animation clip、Camera cut、公開 Event の3 trackを持つ短い sequenceを編集・再生する
- 後回し: nested sequence、curve editor、recording、multi-user live editing、nonlinear editing、video / audio の精密同期
- 検証 UGC: 扉が開き、Camera が切り替わり、完了 Event を送る10秒の導入演出
- 未決定: Timeline と汎用 property animation の境界、seek 時の副作用 Event、途中参加者の追従

### 6.3 Particle

- 状態: **Candidate**
- 価値と例: 火花、煙、魔法、天候などを、作者が再利用可能な effect として使う
- 主な層・利用時点: Particle asset と Editor preview、Runtime renderer、生成を依頼する `effects` Host Capability。制作時と実行時の両方
- 境界・前提: version 付き effect / emitter identity と schema を持つ。生成には `effects` Capability grant と GPU / particle quota を課す。emitter asset は Package に保存し、one-shot instance は原則非永続とする。同期対象を開始する authority と、client-local cosmetic との分離は未決定
- 最小スコープ: 公式 schema の emitter を asset として保存し、位置・向き・寿命を指定して one-shot 再生する
- 後回し: 任意 shader、node editor、collision、fluid、sub-emitter、永続的な World weather
- 検証 UGC: 銃口と命中地点の火花、焚き火の煙。低品質設定と quota 超過 Diagnostic も確認する
- 未決定: Three.js の内部表現を公開 schema から完全に隠す変換層、determinism の必要範囲

### 6.4 Camera

- 状態: **Focus**
- 価値と例: 一人称 / 三人称、会話、乗り物、カットシーン、shake を安全に表現する
- 主な層・利用時点: Editor camera は Editor 機能。Player camera への作用は Host Capability と Runtime の request / arbitration。制作時と実行時を分離する
- 境界・前提: Player / camera request / owner identity を持つ。Player camera への作用には Capability grant と必要に応じた利用者同意を要求し、client の arbiter が priority / lifetime / release を強制する。request は非永続、演出の開始状態を同期するかは未決定。API schema は Runtime 内部表現から分離し、Camera rig asset の要否と schema / format は未決定
- 最小スコープ: 配置された UGC が、明示的な期間を持つ camera request を開始・解除し、cut または短い blend を選べる。競合時の優先規則と強制解除を実装前に定義する
- 後回し: cinematic rig、path editor、advanced shake、splitscreen、portal / render texture、自由な projection matrix
- 検証 UGC: 三人称切替と、扉を調べた時だけ再生される短い注視演出。退出・権限拒否・競合・酔い軽減設定を確認する
- 未決定: World、Item、Player 自身の request 優先順位、ユーザー同意が必要な作用、client-local と同期演出の境界

### 6.5 Post processing

- 状態: **Candidate**
- 価値と例: bloom、color grading、vignette で World の雰囲気や一時的な状態を表現する
- 主な層・利用時点: profile asset、Runtime の合成器、権限・quota 付き Host Capability、Player 品質設定。制作時 preview と実行時
- 境界・前提: version 付き profile / request / owner identity を持つ。適用には Capability grant、GPU budget、Player のアクセシビリティ設定を要求し、client の camera pipeline が合成 authority を持つ。profile asset は Package に保存し、一時 request は非永続とする。profile asset の schema / format、同期範囲、公開 API schema は未決定
- 最小スコープ: World の base profile と、時間制限付きの局所 profile 一つを安全な値域で合成する
- 後回し: 任意 shader、custom pass graph、object mask、複数 Camera ごとの高度な pipeline
- 検証 UGC: 洞窟へ入ると color grade が変わり、退出または UGC 停止で必ず戻るシーン
- 未決定: World / Item / Player 設定の優先順、光過敏性に関わる effect の禁止・軽減規則

## 7. メディア

### 7.1 Video player

- 状態: **Candidate**
- 価値と例: World 内スクリーン、チュートリアル、展示、物語演出で動画を再生する
- 主な層・利用時点: Video asset / surface Built-in、playback Host Capability、Editor preview、Package metadata。制作時と実行時の両方
- 境界・前提: video asset / surface / playback identity を持つ。upload・公開権限、moderation、media Capability、帯域 quota を分ける。asset は Package / release に保存・配信し、local playback は client authority、共有再生は別の authority と同期設計を要する。API schema と対応 codec / container は未決定で、外部 URL は初期対象外
- 最小スコープ: Project に取り込んだ対応形式一つを面に表示し、play / pause / loop を各 client で行う。外部 URL は許可しない
- 後回し: live stream、DRM、外部埋め込み、adaptive bitrate、精密な参加者間同期、Timeline 連携
- 検証 UGC: 展示室の短い無音ループ動画。未対応 codec、asset 不足、帯域上限の Diagnostic を確認する
- 未決定: 最初の対応形式、server 側 transcode の有無、動画と音声の同期をどこまで保証するか

## 8. 配布・権利・言語

### 8.1 License / provenance

- 状態: **Focus**
- 価値と例: 作者、利用者、依存先が、asset / Package の出所、表示義務、fork / extract 後の由来を失わず確認できる
- 主な層・利用時点: Package / release / asset / dependency / Work の metadata、公開・install UI、server validation。主に制作・配布時だが Runtime 配布物にも随伴する
- 既存 Active 範囲: [U3](../plans/ugc-api-library-permissions.md#u3-最小ローカル-library-package) は Package identity、dependency lock、content hash と、extract / fork で出所と binding を保つ基盤を扱う。[U6](../plans/ugc-api-library-permissions.md#u6-ユーザー間-library) は publish / install / fork と license / provenance / dependency の表示を扱う。この Focus は両者の実装・表示の受け入れ条件を重複管理しない
- 境界・前提: Package / release / asset / author / derived-from identity を使う。編集・公開権限を分け、Registry が immutable release の metadata を固定する。実行時同期や Host API にはせず、version 付き metadata schema と asset 単位・Package 単位の宣言を配布物へ随伴させる
- 最小スコープ: U3 の provenance を前提に、SPDX identifier またはカスタム文面への参照、copyright / author、source、attribution の metadata schema と継承規則を、依存・fork / extract を模した release graph fixture で検証する。結果は attribution manifest と不足時の Diagnostic とし、publish / install / fork の UI と表示は U6 へ委ねる。自動の法的適合判定はしない
- 後回し: 完全なライセンス互換性 solver、収益分配、地域別規約、法的助言、外部 registry との自動照合
- 検証 UGC: 複数ライセンスの asset と Library Package を使う作品の release graph fixture 上で依存・fork / extract を模擬し、attribution manifest と不足時の Diagnostic が期待どおりになることを確認する。実際の publish / install / fork の UI 検証は U6 で行う
- 未決定: asset ごとの表記をどこで集約するか、カスタムライセンスの継承表現、公開を拒否する条件と警告だけにする条件

### 8.2 Localization

- 状態: **Candidate**
- 価値と例: Tukurium の UI と UGC のタイトル、説明、字幕、ゲーム内テキストを利用者の言語で表示する
- 主な層・利用時点: Platform / Editor UI の locale、UGC の StringTable resource、Package / 公開 metadata。制作時と実行時の両方
- 境界・前提: locale / string key / StringTable / Package identity を持つ。作者と翻訳者の編集・公開権限、fallback を確定する authority は未決定。StringTable と翻訳可能 metadata を保存・version 管理し、Runtime では共有状態にせず利用者 locale ごとに解決する。lookup API と asset format は未決定
- 最小スコープ: Package の表示名・説明と、UGC の小さな StringTable を locale 別に持ち、既定言語へ fallback する
- 後回し: 翻訳 workflow、plural rules の完全対応、音声差し替え、machine translation、community translation、字幕 editor
- 検証 UGC: 日本語・英語の UI と説明を持つ短い作品を切り替え、欠落 locale の fallback と Diagnostic を確認する
- 未決定: Tukurium 本体の翻訳と UGC resource の実装共有範囲、ユーザー生成翻訳の権限と公開単位

## 9. Reference / Sample UGC

### 9.1 Sample UGC の充実

- 状態: **Focus**
- 価値と例: 初学者が遊べる作品から学び、fork / extract して改造できる。開発側は公式 API の不足、権限、Diagnostic、互換性を実作で検証できる
- 主な層・利用時点: Reference UGC、学習用 Sample、showcase、Package metadata、継続的な回帰シナリオ。制作・実行・公開の全経路
- 既存 Active 範囲: [U4](../plans/ugc-api-library-permissions.md#u4-公式-platform-primitive--library-と-reference-ugc) は「銃と的」「扉とスイッチ」「収集物と Inventory」を reference UGC として実装し、公式 API を検証する。この Focus は三本の実装・API 昇格・conformance の受け入れ条件を重複管理しない
- 境界・前提: sample Package / immutable release / 対象 API identity を持つ。公式 sample の公開・更新は保守 owner に限定し、要求 Capability と dependency lock を表示する。作品は通常の Package / release 形式、説明は同梱 document asset として保存する候補とし、tutorial metadata の schema / format は未決定。実行時同期は各 UGC の API に従う。特権 API は使わず、明確なライセンスを付ける
- 最小スコープ: U4 の reference UGC 一つを、遊び方、構成、要求 Capability、fork / extract 手順、対象 API と難易度を持つ学習用 Sample として配布し、reference から Sample へ育てる保守手順を確立する
- 後回し: 大規模 showcase、全ジャンル網羅、ランキング、ユーザー投稿サンプルの公式認定、多数の tutorial series
- 検証 UGC: 各サンプル自身が検証対象。新規 workspace への install / fork、権限拒否、依存不足、API major 更新を end-to-end で確認する
- 未決定: reference、tutorial、showcase の公開 UI 上の区別、サンプルの保守 owner と互換性期間

Reference UGC は API と境界の必要性を検証する作品、Sample UGC は学習と改造を主目的にした作品として区別する。同じ作品が両方を兼ねてもよいが、作品が成功するだけで conformance を満たしたとは扱わない。

## 10. 画面・UI

### 10.1 HUD（UGC が出す 2D の画面）

- 状態: **Candidate**
- 価値と例: 残弾・体力・スコア・目標の表示、ちょっとした案内やメニュー。ゲーム性のある UGC のほとんどが要る。今は 3D の Label（ADR 0017）とログしかない
- 主な層・利用時点: Runtime Built-in の宣言的な HUD の記述（文字・数値・ゲージ・アイコン程度）、表示を求める Host Capability、client の描画。実行時。Editor では preview
- 境界・前提: DOM・任意の HTML・CSS は UGC に公開しない（計画 U4「UI は別 ADR を実装条件とする」）。HUD request / owner（配置・Player）identity を持ち、表示には Capability grant と画面の上限（数・面積・更新頻度）を要求する。だれの画面に出すか（その Player だけ・全員）、別の作者の HUD と重なったときの優先と配置、Player が消せること（アクセシビリティ・なりすまし対策：システムの画面に見せかけない）を決める。表示内容は非永続とし、同期の範囲は未決定
- 最小スコープ: 置いた物の System が、E で押した・撃ったなどの Player に対して、文字と数値のゲージを一つ、決まった位置（画面の隅）に期限付きで出す。消える条件（期限・配置を外す・Player が閉じる）を先に決める
- 後回し: 自由な配置・レイアウト、ボタンなどの入力付きメニュー、アニメーション、画像、ワールド空間の 3D パネルへの表示
- 検証 UGC: 銃の残弾ゲージと、鍵と扉の「鍵を持っている」表示。別の作者の物を二つ置いたとき、重ならず、どちらの表示かが分かり、Player が閉じられることを確かめる
- 未決定: 宣言的な記述の形（KokoState か Host API か）、Player ごとの表示とフレームの配り方（ほかの人に見せない）、ローカライズ、3D の Label との使い分け

