# Tukurium ロードマップ

- 状態: **Active**
- M0〜M6: 完了
- 詳細な完了記録: [`archive/PLAN-v0.2.md`](archive/PLAN-v0.2.md)

## 現在

プロトタイプの一周は完成している。次は制作規模を増やす前に、リソース参照、System の型と境界、プロジェクト全体の診断を整理する。あわせて、UGC が他の Item / World と安全に相互作用するための Capability・権限・Library Package の基盤を、公開 API が固定される前に設計する。

### 1. リソースパスと全体診断

詳細計画: [`plans/resource-paths-and-diagnostics.md`](plans/resource-paths-and-diagnostics.md)

- [x] Phase 0: identity / path / binding / diagnostics の判断を ADR で固定する（[ADR 0010](adr/0010-resource-identity-paths-diagnostics.md)）
- [x] ResourcePathIndex と snapshot validation（名前の衝突・フォルダの輪・置き場所。UI で作る・名前を変える・移すときは衝突を避ける）
- [x] 汎用 Diagnostic model と最小 Provider（構造・リソース参照・スクリプト・実行の問題を一つの形にした。編集前の結果は stale、非同期の確認は世代で古い結果を捨てる）
- [x] ProjectDependencyGraph と増分無効化（スクリプトの確認は影響を受ける System だけ。System → KokoState は Query の名前を介した辺で、Phase 4 で安定 ID に置き換える。`usageOf()`・抽出への統合は残り）
- [x] System の構造化された resource binding（仮想 import の解決・書き換え・Query の AST 読み取り・抽出の依存・名前の変更や移動に合わせた import のリファクタリング。古い結び付けの診断は、結び付けを覚えておく仕組みと合わせて後で）
- [x] runtime を alias / stable ID ベースへ移行（状態の受け渡し・Query・world.get/set/spawn を ID ベースにし、別のフォルダの同じ名前の KokoState を使えるようにした。セッションの realm は「リポジトリ@版」で、適用は対象の配置だけを新しい版へまとめて移す）
- [ ] 独立した Problems パネル、全 resource / folder / hierarchy の集計表示
- [ ] Snapshot v2、migration、extract / fork の更新
- [ ] 型付き JavaScript。その必要性を確認後に TypeScript 対応

### 2. スクリプト境界の堅牢化

上の計画と同じ土台で進める。

- [ ] QuickJS との全境界を `unknown` から検証する
- [x] Host API の型・validator・利用者向け宣言を一つの定義から生成する（`HOST_API_SPEC`。`hostApiDeclarations` と `hostApiCompletions`）
- [ ] 構造化された ScriptDiagnostic を Runtime・通信・Problems UI まで保つ
- [ ] メモリ超過時の復旧動作と ADR 0001 を一致させる

### 3. UGC API・権限・Library Package

詳細計画（Active）: [`plans/ugc-api-library-permissions.md`](plans/ugc-api-library-permissions.md)

現在の dependency graph の次から設計判断を始め、System binding と Runtime Host API を固定する前に権限境界を組み込む。Library の検索・共有 UI より、実行時に強制できる安全な API と最小 package model を先に作る。

- [x] U0: KokoState / Event / Capability / Package の責務と、Player / System / Item / World / Host の権限主体を ADR と characterization test で固定する（[ADR 0011](adr/0011-kokostate-event-capability-package.md)〜[0013](adr/0013-package-identity-version.md)、`HOST_API_POLICY`）
- [x] schema-first の Host API 引数検証と既定の配置境界を作る（引数を一つの定義で検証し、別の配置へは opaque handle と公開 Contract だけで届くようにした）
- [x] PackageExecutionContext、要求 Capability、Placement grant、World policy から実効権限を計算し、すべての UGC Host API で deny-by-default に強制する。利用者向け型・Diagnostic metadata も同じ定義から生成する（要る Capability はコードから読み取り、セッションでは「宣言 ∩ 付与」で全 Host API に強制。ワークスペースの再生では強制しない（利用者と決めた）。付与はサーバーの配置の台帳に保存し、setGrants で変えられる。`HOST_API_SPEC` から検証・権限の分類・拒んだときの値・利用者向けの型の宣言・エディタの入力補完を作る）
- [ ] 呼び出し側 grant と対象側 policy、公開 Contract、opaque handle を使った境界越しの相互作用を実装する（最初の縦の一本：Raycast の opaque handle → `hit.effect("spark")` と `hit.send("Damage")` → 的の `contracts.Damage`、出力の exposure。土台の World の上限（guestPolicy のプリセット）も済み、拒否の知らせ（contract-denied）も済み。呼び出し側 grant の強制は上の gateway 項目、対象側はサーバーでの判定が残り。設定 UI は U5）
- [ ] stable package ID / version / exports / dependencies / capability requirements を持つ最小のローカル Library Package を実装する（[ADR 0015](adr/0015-library-package-minimal.md)。Kind「ライブラリ」・公開の印・リリースのときにサーバーが計算する content hash・版の中身を取り出す API・依存の lock・`@別名` の import（KokoState）・その診断・依存グラフの辺・依存を足す最小の画面・依存の KokoState の実行時の取り込み（Entity に付けて再生で動く。同じ版は置いた物どうしで共有）は済み。ライブラリの System の実行と PackageExecutionContext・依存の依存と輪・出所の保持が残り）
- [ ] 公式 Platform Primitive / Library カタログを整備する。銃と的、扉とスイッチ、収集物と Inventory を reference UGC として縦に実装し、複数用途で共通する機能、Host 境界でしか安全に提供できない機能、Package 間相互運用に必要な機能だけを Runtime Built-in・Host Capability・公式 Library へ段階的に昇格させる
- [ ] 昇格する公式 API ごとに stable identity、schema、version、権限、authority、quota、lifecycle、Diagnostic、利用者向け型、unit / conformance test を揃え、experimental → preview → stable → deprecated の互換性規則を運用する
- [ ] Dependencies / Placement grant・World / Item 権限プリセット / Problems の UI を追加する（実効権限の runtime model と強制は U1 の gateway で先に完成させる）
- [ ] 基盤の実測後、ユーザー間の公開・検索・install・fork・更新へ広げる

### 4. Creator Platform の探索候補

候補と運用方法（Discovery）: [`discovery/creator-platform-capabilities.md`](discovery/creator-platform-capabilities.md)

UGC の制作体験、表現、配布を広げる機能を、実装順を固定する前に比較・検証する。候補への掲載や Focus 選定は実装の約束ではなく、最小の縦切り、層、権限、保存・同期、依存、Reference UGC による検証方法が揃ったものだけを Active plan へ昇格させる。

現在の Focus は最大 5 件で、次の並びは優先順位を表さない。

- **Undo / Redo**: Brush と Timeline に先立つ、安全な編集 transaction の基盤
- **Animation**: キャラクター、装置、演出で共通する再生・asset binding の基盤
- **Camera**: Player の視点に作用する権限・競合・解除・アクセシビリティの境界
- **License / provenance**: U3 の出所保持を前提に、Package の依存・install・fork・公開でライセンス表記を失わない metadata と表示
- **Sample UGC の充実**: U4 の Reference UGC 実装とは分けて、検証作品を学習・改造できる Sample へ育てる循環

Video player、Particle、Timeline animation、Localization、Post processing、Brush も Candidate として保持する。関連 Active plan の phase 完了、ROADMAP の numbered section 完了、重大な前提変更、Focus の昇格時に最大 5 件を見直す。

## 後で判断するもの

実測や利用経験が必要なため、先回りして作り込まない。

- QuickJS の Worker 化
- Entity / field の差分転送
- Library marketplace のランキング・評価・収益化・自動推薦
- commit 単位のサーバー診断・CIキャッシュ
- 診断 suppression policy
- TypeScript を正式な利用者スクリプト形式にするか

## 進め方

- 一度に全 Phase を実装せず、小さな end-to-end slice で進める。
- production code より先に失敗するテストを書き、RED → GREEN → REFACTOR を確認する。
- Phase 完了時に、決定事項は ADR、再利用できる注意点は DEVELOPMENT、現在できることは README へ反映する。
- Active な詳細計画が完了したら、結果を正本へ移して計画自体は archive へ移す。
