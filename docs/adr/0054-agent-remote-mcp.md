# ADR 0054：AI エージェントが制作できるようにする（リモートの MCP）

- 状態：採用・実装済み（2026-11-07）
- 関連：ADR 0004（Yjs の同期）、ADR 0005（セッションと本人）、ADR 0008（権限）、ADR 0010（診断）

## 背景

AI エージェント（Claude Code など）にも Tukurium で制作してほしい。人が使う道とは別に、エージェント向けの書き込み口を作ると、権限・同時編集・差分・元に戻すを二重に持つことになる。いろいろな人に使ってほしいので、使う側の準備も少なくしたい。

## 決定（利用者と決めたこと）

- **入口はリモートの MCP**：サーバーが `/mcp`（Streamable HTTP）を出す。使う人は URL をクライアントに足すだけ。
  ```
  claude mcp add --transport http tukurium https://<サーバー>/mcp
  ```
- **エージェントは人と同じ道を通る**：MCP のセッションごとに、サーバーの中で参加者（`AgentClient`）を一人つくる。hub へ内部の接続としてつなぎ、人のクライアントと同じメッセージで動く。
  - 名乗る → セッションに入る → ワークスペースを開く → Yjs の更新で編集する
  - 編集は人の画面にそのまま届く。変化の丸・差分・元に戻すも、人の編集と同じに働く。
- **身元**：エージェントは人とは別の利用者で、「エージェント（名前）」と表示する。
- **保存は人だけ**：エージェントの接続は、hub が保存（コミット）を断る。ワークスペースのホスト（再生の実行役）にもならない。のちに権限の設定で変えられるようにする。
- **トークン・上限はまだない**：アカウントがまだないため。アカウントができたら、そのアカウントでトークンを発行し、権限を設定できるようにする。

使う人向けの案内は [`../AGENT_MCP.md`](../AGENT_MCP.md)。

## 道具

| 種類 | 道具 |
| --- | --- |
| 手引き | `guide`（考え方・進め方・System の見本・Host API の型） |
| 入る | `list_sessions`・`join_session`・`list_workspaces`・`open_workspace` |
| 見る | `get_project`・`get_entity`・`get_entities`・`get_system` |
| 作る・変える | `create_entity`・`update_entity`・`delete_entity`・`apply_entities`・`create_kokostate`・`update_kokostate`・`create_system`・`update_system`・`set_output_systems`・`create_material`・`update_material`・`import_asset` |
| 確かめる | `check`（構造・参照・System の import）・`simulate`（サーバーで決まった時間だけ動かし、System の状態・ログ・Entity の状態を返す。人には見えない。最大 20 秒）・`preview`（開いている画面を、指定した位置から撮る） |

一括・素材・プレビューの決めごとは [0059](0059-agent-batch-assets-preview.md)。

- KokoState・欄・Entity・System・アウトプットは、ID でも名前でも指せる。名前が曖昧なら、ID の候補を添えてエラーにする。
- 道具の中のエラーは、エージェントが読んで直せる文で返す。

## 結果

- `apps/server/src/agent/`：`AgentClient`（hub への内部の接続）、`tools.ts`（道具の中身。MCP に依存しない）、`mcp.ts`（MCP と `/mcp`）。
- サーバーが runtime（Simulation）を使うようになったので、`apps/server/package.json` に runtime の実行時の npm パッケージ（rapier・quickjs・three）を足した。
- スクリプトの実行時の問題は `simulate` で拾う。クライアントの「編集中のスクリプトの確認」（`checkScripts`）とそろえるのは、あとの作業。
