# Tukurium ドキュメント

このディレクトリでは現在使う文書と歴史資料を分けて管理する。

## まず読む

- [プロジェクトの README](../README.md)：現在できること、必要なもの、起動方法
- [開発の約束](../CLAUDE.md)：実装・テスト・文言について守ること
- [Tukurium のテーマと原則](PRINCIPLES.md)：目指す状態と、判断に迷ったときに頼るもの。言葉の意味は[用語](GLOSSARY.md)
- [UIデザイン](../design.md)：配色・文字・部品・ウィンドウ配置を、現在の画面にそろえるための基準
- [現在のロードマップ](ROADMAP.md)：利用者向けの機能ごとの実装済み・これから実装するもの・検討中の候補
- [設計判断の記録](adr/README.md)：採用済みの設計と、その理由

## 現在使う文書

| 文書 | 役割 |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | 機能ごとの実装状況と残作業、検討中の候補、詳細計画への入口。分野の並びは優先順位を表さない |
| [plans/](plans/) | 実装中・検討中の詳細計画。[リソースパス・System 参照・全体診断](plans/resource-paths-and-diagnostics.md)、[UGC API・権限・Library Package](plans/ugc-api-library-permissions.md)。メインメニューは[実装済みUI/UX](plans/social-workshop-experience.md)と[完了記録](archive/main-menu-implementation.md)を参照 |
| [discovery/](discovery/) | 実装を約束する前の機能候補、比較、Focus と昇格条件。[Creator Platform 機能候補](discovery/creator-platform-capabilities.md) |
| [adr/](adr/) | 採用・変更・廃止した設計判断の記録。[ADR 一覧](adr/README.md) |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 開発中に実際に詰まった点と対策 |
| [DEPLOY.md](DEPLOY.md) | VPS / Coolify への設置・更新・バックアップ |
| [AGENT_MCP.md](AGENT_MCP.md) | AI エージェントで制作するための案内（MCP の登録・頼み方）。Claude 以外のツールも |

## 歴史資料

[archive/](archive/) には[初期要件](archive/requirements-v0.1.md)や[完了済みロードマップ](archive/PLAN-v0.2.md)を残す。経緯を調べるための資料であり、現在の仕様や実装指示としては使わない。

## 情報が食い違うときの優先順位

[原則](PRINCIPLES.md)は判断の向きを示すもので、個々の仕組みは決めない。個々の仕組みについては、次の順で確かめる。

1. 実際のコード、schema、テスト
2. 採用済みで、後続 ADR に置き換えられていない ADR
3. 現在の [ROADMAP.md](ROADMAP.md) と `plans/` の Active な計画
4. ルートの [README.md](../README.md) と [CLAUDE.md](../CLAUDE.md)
5. `discovery/` の候補と未採用の案
6. `archive/` の歴史資料

食い違いを見つけたら、黙って都合のよい文書を選ばない。実装と意図を確認し、必要なら ADR または現役文書を更新する。

## 文書の運用

- 設計を決めたら ADR に残す。原則との関係を書くときは、ADR の側から[原則](PRINCIPLES.md)を指す。原則のページからは ADR を指さない。既存 ADR を無言で書き換えず、変更した ADR から置き換え元を示す。
- 詳細計画には `Draft / Active / Completed` の状態と実装状況を書く。
- `discovery/` は `Candidate / Focus / Promoted / Parked` で運用する。Focus は最大 5 件とし、実装順や実装の約束として扱わない。昇格条件を満たした候補だけを Active plan へ移す。
- 完了した計画は現在必要な結果を ADR・README・DEVELOPMENT に移してから `archive/` へ移す。
- 診断結果、生成物、一時的な調査ログは文書としてコミットしない。
- 同じ説明を複数文書へ複製せず、その内容を管理する文書へリンクする。
