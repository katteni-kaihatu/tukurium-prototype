# Architecture Decision Records

ADR は、採用した設計、その理由、制約を残す。実装が完了しても削除しない。判断を変更するときは新しい ADR を追加し、置き換える ADR を明記する。

| ADR | 状態 | 判断 | 備考 |
| --- | --- | --- | --- |
| [0001](0001-script-runtime-quickjs.md) | 採用 | 利用者スクリプトを QuickJS で実行する | メモリ超過後の復旧動作は実装との整合を再確認する |
| [0002](0002-host-migration-snapshot.md) | 採用 | ホスト引き継ぎに実行状態スナップショットを使う | |
| [0003](0003-panels-2d-3d.md) | 採用 | パネルを 2D / 3D で表示する | |
| [0004](0004-workspace-sync-yjs.md) | 採用 | ワークスペースを Yjs で権限付き同期する | |
| [0005](0005-sessions-identity-host.md) | 採用 | セッション、本人識別、ワークスペースホスト | M2 |
| [0006](0006-session-world-apply-assets.md) | 採用 | セッション世界、適用、状態維持、素材 | M3 |
| [0007](0007-repos-commits-works.md) | 採用 | リポジトリ、コミット、作品、フォーク、抽出 | M4 |
| [0008](0008-private-work-world-editing.md) | 採用 | 権限、プライベート作業、ワールド編集 | M5 |
| [0009](0009-spatial-input-grab-folders.md) | 採用（一部置き換え） | 空間入力、物を持つ操作、Resources のフォルダ | 「フォルダは並べ方だけ」は 0010 で置き換え |
| [0010](0010-resource-identity-paths-diagnostics.md) | 採用 | リソースの同一性・論理パス・参照の結び付け・診断 | System 構文と runtime の移行は計画の Phase 4〜7 |
