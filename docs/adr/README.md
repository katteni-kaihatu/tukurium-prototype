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
| [0011](0011-kokostate-event-capability-package.md) | 採用 | KokoState・Event・Contract・Capability・Package の役割 | UGC U0 |
| [0012](0012-runtime-authority-target-policy.md) | 採用 | 権限の単位（置いた物）・境界（World の配置）・判定の場所・対象の policy | 今は協調セッションに限る。サーバーの判定は U2 以降 |
| [0013](0013-package-identity-version.md) | 採用 | Package の同一性・書き換えない版・exports・依存 | 型だけ。Registry は U3 |
| [0014](0014-session-open-world.md) | 採用 | セッションで開くワールドは公開作品から一つ。開くと入れ替わる | アイテムの配置は残る |
| [0015](0015-library-package-minimal.md) | 採用 | 最小の Library Package：ライブラリの作品、公開の印、サーバーが計算する content hash、依存・`@別名` の import・実行時の取り込み・依存の依存・抽出 | U3 |
| [0016](0016-official-library-reference-ugc.md) | 採用 | 公式の発行者・同梱の公式ライブラリ（combat・interaction）・reference UGC（銃と的・扉とスイッチ）・Built-in の Interact | U4。収集物と安定度の印は次 |
| [0017](0017-label-and-player-name.md) | 採用 | 文字を出す Label と、入力に添える表示名 | プロトコルの版は上げない。本人の確定は ID |
| [0018](0018-player-bag.md) | 採用 | プレイヤーが持ち歩くバッグ：種類はライブラリの KokoState、触れるのは E で押したときだけ、セッションの間だけ残る | U4 の収集物と Inventory |
| [0019](0019-api-stability-all-experimental.md) | 採用 | API の安定度は、今はすべて experimental。公式ライブラリは公式アカウントの UGC として扱い印を付けない | 上げるのはワークショップができてから |
| [0020](0020-social-workshop-direction.md) | 採用（方向性） | 3D の制作・交流・試遊と、ワークショップでの発見・利用をつなぐ。2D クライアントは当面対象外 | 最初はセッション・参加者メニューと公開アイテムの検索・取り出しの UI/UX を設計 |
| [0021](0021-main-menu-window.md) | 採用（画面構成） | 左上のツクリウムボタンから開く一つのウィンドウに、ホーム・フレンド・セッション・アイテム・マーケットをまとめる | 実装計画は `feat/main-menu`。本体は未実装 |
| [0022](0022-main-menu-first-release.md) | 採用 | 無料の入手・版の固定、申請承認型のフレンド、状態・招待までを初期範囲とする | A1〜A7に分けて実装・確認・コミット |
| [0023](0023-session-menu-transitions.md) | 採用・実装済み | 参加先を受理してから切り替え、失敗時は元の場所を保つ。一覧は参加中も更新する | A2、通信の版4 |
| [0024](0024-owned-items-and-placement.md) | 採用・基盤実装済み | 入手時の版を固定して所持し、取り出し結果を要求IDへ対応させる | A3、画面はA4 |
| [0025](0025-friend-requests-and-presence.md) | 採用・実装済み | 申請・承認型のフレンドと、状態・参加先の共有 | A5 |
