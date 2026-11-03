# Tukurium ロードマップ

- 状態: **Active**
- M0〜M6: 完了
- 詳細な完了記録: [`archive/PLAN-v0.2.md`](archive/PLAN-v0.2.md)

## 現在

プロトタイプの一周は完成している。次は制作規模を増やす前に、リソース参照、System の型と境界、プロジェクト全体の診断を整理する。

### 1. リソースパスと全体診断

詳細計画: [`plans/resource-paths-and-diagnostics.md`](plans/resource-paths-and-diagnostics.md)

- [ ] Phase 0: identity / path / binding / diagnostics の判断を ADR と characterization test で固定する
- [ ] ResourcePathIndex と snapshot validation
- [ ] 汎用 Diagnostic model と最小 Provider
- [ ] ProjectDependencyGraph と増分無効化
- [ ] System の構造化された resource binding
- [ ] runtime を alias / stable ID ベースへ移行
- [ ] 独立した Problems パネル、全 resource / folder / hierarchy の集計表示
- [ ] Snapshot v2、migration、extract / fork の更新
- [ ] 型付き JavaScript。その必要性を確認後に TypeScript 対応

### 2. スクリプト境界の堅牢化

上の計画と同じ土台で進める。

- [ ] QuickJS との全境界を `unknown` から検証する
- [ ] Host API の型・validator・利用者向け宣言を一つの定義から生成する
- [ ] 構造化された ScriptDiagnostic を Runtime・通信・Problems UI まで保つ
- [ ] メモリ超過時の復旧動作と ADR 0001 を一致させる

## 後で判断するもの

実測や利用経験が必要なため、先回りして作り込まない。

- QuickJS の Worker 化
- Entity / field の差分転送
- 外部 package / library output
- commit 単位のサーバー診断・CIキャッシュ
- 診断 suppression policy
- TypeScript を正式な利用者スクリプト形式にするか

## 進め方

- 一度に全 Phase を実装せず、小さな end-to-end slice で進める。
- production code より先に失敗するテストを書き、RED → GREEN → REFACTOR を確認する。
- Phase 完了時に、決定事項は ADR、再利用できる注意点は DEVELOPMENT、現在できることは README へ反映する。
- Active な詳細計画が完了したら、結果を正本へ移して計画自体は archive へ移す。
