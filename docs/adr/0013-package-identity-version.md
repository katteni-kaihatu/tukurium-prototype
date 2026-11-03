# ADR 0013：Package の同一性・版・exports・依存

- 状態：採用
- 関連：ADR 0007（リポジトリ・コミット・抽出）、ADR 0010（リソースの同一性）、ADR 0011（役割）、ADR 0012（権限）
- 詳細計画：[`../plans/ugc-api-library-permissions.md`](../plans/ugc-api-library-permissions.md)

## 背景

公式の部品も利用者の部品も、同じ Library の仕組みで使えるようにしたい。今の「抽出」は、リソースを別のリポジトリへ写すだけで、出所・版・必要な権限を持たない。配布や検索を作る前に、Package の最小の形を決める。

## 決定

### 1. 同一性

- Package は安定 ID（`PackageId`）を持つ。名前を変えても ID は変わらない。
- 「公式」かどうかは、名前ではなく publisher の同一性で決める。

### 2. 版は書き換えない

- 同じ Package ID・同じ版の中身を、後から置き換えない。
- `contentHash` は、manifest の自己申告を信じない。canonical な並べ方で、Registry が計算する。同じ ID・同じ版に違う hash を登録しようとしたら拒む。
- 実行するときは、解決した版と content hash を固定する。自動で最新版へは切り替えない。

### 3. exports と依存

- 外から import できるのは、export したものだけ（KokoState・System・Contract・Script API・素材・Output / テンプレート）。
- 中では安定 ID で参照し、ソースでは Package のパスと別名で書く（ADR 0010 の import と同じ考え方）。
- 依存は版を固定する（lock）。見つからない版・輪になった依存・API の版の不一致・Capability の拒否は、問題（Diagnostic）にする。
- 依存の辺は `ProjectDependencyGraph` に入れる。

### 4. 実行の主体

- Package を置くと、`PackageExecutionContext`（Package の実体の ID・Package ID・解決した版・content hash・System・置いた物・World）ができる。権限の付与・handle・監査・Diagnostic はこれを主体として使う（ADR 0012）。
- 配布（U3 以降）でも同じ主体を使い、仮の realm や System のキーから、別の権限のキーを作り直さない。

## 結果

- 型は `packages/runtime/src/capabilities.ts` に置いた（`PackageId`・`ContractRef`・`PackageExecutionContext`）。まだ実行時には使わない。
- U3 で、同梱の公式 Package とローカルの依存だけを扱う最小の Registry を作る。検索・公開・install は、基盤を実測してから（U6）。
