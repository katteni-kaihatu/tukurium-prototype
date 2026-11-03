# Tukurium ドキュメント

このディレクトリでは、現在使う文書と歴史資料を分けて管理する。

## まず読む

- [プロジェクトの README](../README.md)：現在できること、必要なもの、起動方法
- [開発の約束](../CLAUDE.md)：実装・テスト・文言について守ること
- [現在のロードマップ](ROADMAP.md)：これから取り組むテーマと優先順
- [設計判断の記録](adr/README.md)：採用済みの設計と、その理由

## 現在使う文書

| 文書 | 役割 |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | 現在以降の作業と、詳細計画への入口 |
| [plans/](plans/) | 実装中・検討中のテーマごとの詳細計画 |
| [discovery/](discovery/) | 実装を約束する前の機能候補、比較、Focus と昇格条件 |
| [adr/](adr/) | 採用・変更・廃止した設計判断の記録 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 開発中に実際に詰まった点と対策 |
| [DEPLOY.md](DEPLOY.md) | VPS / Coolify への設置・更新・バックアップ |

## 歴史資料

[archive/](archive/) には、初期要件や完了済みロードマップを残す。経緯を調べるための資料であり、現在の仕様や実装指示としては使わない。

## 情報が食い違うときの優先順位

1. 実際のコード、schema、テスト
2. 採用済みで、後続 ADR に置き換えられていない ADR
3. 現在の [ROADMAP.md](ROADMAP.md) と `plans/` の Active な計画
4. ルートの [README.md](../README.md) と [CLAUDE.md](../CLAUDE.md)
5. `discovery/` の候補と未採用の案
6. `archive/` の歴史資料

食い違いを見つけたら、黙って都合のよい文書を選ばない。実装と意図を確認し、必要なら ADR または現役文書を更新する。

## 文書の運用

- 設計を決めたら ADR に残す。既存 ADR を無言で書き換えず、変更した ADR から置き換え元を示す。
- 詳細計画には `Draft / Active / Completed` の状態と実装状況を書く。
- `discovery/` は `Candidate / Focus / Promoted / Parked` で運用する。Focus は最大 5 件とし、実装順や実装の約束として扱わない。昇格条件を満たした候補だけを Active plan へ移す。
- 完了した計画は、現在必要な結果を ADR・README・DEVELOPMENT に移してから `archive/` へ移す。
- 診断結果、生成物、一時的な調査ログは文書としてコミットしない。
- 同じ説明を複数文書へ複製せず、正本へリンクする。
