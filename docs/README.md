# Tukurium ドキュメント

このディレクトリでは現在使う文書と歴史資料を分けて管理する。

## まず読む

- [プロジェクトの README](../README.md)：必要なもの、起動方法
- [開発の約束](../CLAUDE.md)：実装・テスト・文言について守ること
- [Tukurium のテーマと原則](PRINCIPLES.md)：目指す状態と、判断に迷ったときに頼るもの。言葉の意味は[用語](GLOSSARY.md)
- [UIデザイン](../design.md)：配色・文字・部品・ウィンドウ配置を、現在の画面にそろえるための基準
- [できること](FEATURES.md)：いまの Tukurium で使える機能
- [ロードマップ](roadmap/README.md)：テーマと原則のために計画して進める、重い変更
- [設計判断の記録](adr/README.md)：採用済みの設計と、その理由

## 現在使う文書

| 文書 | 役割 |
| --- | --- |
| [FEATURES.md](FEATURES.md) | いまできること。利用者の行動ごとにまとめる |
| [roadmap/](roadmap/README.md) | ロードマップの項目。計画・進行中・完了のフォルダに分け、項目ごとに構想と実装計画を置く |
| [adr/](adr/) | 採用・変更・廃止した設計判断の記録。[ADR 一覧](adr/README.md) |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 開発中に実際に詰まった点と対策 |
| [DEPLOY.md](DEPLOY.md) | VPS / Coolify への設置・更新・バックアップ |
| [AGENT_MCP.md](AGENT_MCP.md) | AI エージェントで制作するための案内（MCP の登録・頼み方）。Claude 以外のツールも |

## 歴史資料

[archive/](archive/) には[初期要件](archive/requirements-v0.1.md)、[完了済みロードマップ](archive/PLAN-v0.2.md)、[2026-11 までのロードマップ](archive/ROADMAP-2026-11.md)、[メインメニューの UI/UX](archive/social-workshop-experience.md)、[機能候補](archive/creator-platform-capabilities.md)などを残す。経緯を調べるための資料であり、現在の仕様や実装指示としては使わない。

## 情報が食い違うときの優先順位

[原則](PRINCIPLES.md)は判断の向きを示すもので、個々の仕組みは決めない。個々の仕組みについては、次の順で確かめる。

1. 実際のコード、schema、テスト
2. 採用済みで、後続 ADR に置き換えられていない ADR
3. `roadmap/in-progress/` の構想と実装計画、[FEATURES.md](FEATURES.md)
4. ルートの [README.md](../README.md) と [CLAUDE.md](../CLAUDE.md)
5. `roadmap/planned/` の構想
6. `archive/` の歴史資料と、`roadmap/done/` の完了の記録

食い違いを見つけたら、黙って都合のよい文書を選ばない。実装と意図を確認し、必要なら ADR または現役文書を更新する。

## 文書の運用

- 設計を決めたら ADR に残す。原則との関係を書くときは、ADR の側から[原則](PRINCIPLES.md)を指す。原則のページからは ADR を指さない。既存 ADR を無言で書き換えず、変更した ADR から置き換え元を示す。
- ロードマップの書き方と進め方は [roadmap/README.md](roadmap/README.md) に従う。
- 機能を足したり変えたりしたら、[FEATURES.md](FEATURES.md) を直す。
- 診断結果、生成物、一時的な調査ログは文書としてコミットしない。
- 同じ説明を複数文書へ複製せず、その内容を管理する文書へリンクする。
