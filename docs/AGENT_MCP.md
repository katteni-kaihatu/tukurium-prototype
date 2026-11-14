# AI エージェントで Tukurium を作る（MCP の使い方）

Tukurium は、AI エージェントから制作できる **MCP サーバー**を出しています。MCP（Model Context Protocol）に対応したエージェントなら、種類を問わず使えます。インストールは要りません。URL を一つ登録するだけです。

```
https://tukurium.rheni.work/mcp
```

- 方式は **Streamable HTTP**（「HTTP」「リモート」「URL」と呼ばれることもあります）です。
- 今は鍵（トークン）も、ログインも要りません（人のログインとは別。あとで足す予定）。

## 1. エージェントに登録する

使っているツールに合わせて登録します。設定の書き方はツールの版で変わることがあるので、うまくいかないときは、そのツールの「MCP サーバーの追加」の説明も見てください。

### Claude Code

```bash
claude mcp add --transport http tukurium https://tukurium.rheni.work/mcp
```

### Claude（デスクトップ・Web）

設定 → コネクタ → 「カスタムコネクタを追加」で、URL に `https://tukurium.rheni.work/mcp` を入れます。

### Cursor

`~/.cursor/mcp.json`（そのプロジェクトだけなら `.cursor/mcp.json`）に足します。

```json
{
  "mcpServers": {
    "tukurium": { "url": "https://tukurium.rheni.work/mcp" }
  }
}
```

### VS Code（GitHub Copilot のエージェント）

`.vscode/mcp.json` に足します。

```json
{
  "servers": {
    "tukurium": { "type": "http", "url": "https://tukurium.rheni.work/mcp" }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json` に足します。

```json
{
  "mcpServers": {
    "tukurium": { "httpUrl": "https://tukurium.rheni.work/mcp" }
  }
}
```

### Codex CLI

`~/.codex/config.toml` に足します。

```toml
[mcp_servers.tukurium]
url = "https://tukurium.rheni.work/mcp"
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` に足します。

```json
{
  "mcpServers": {
    "tukurium": { "serverUrl": "https://tukurium.rheni.work/mcp" }
  }
}
```

### そのほかのツール

- URL（HTTP）で MCP サーバーを足せるツールなら、`https://tukurium.rheni.work/mcp` を登録します。
- コマンドで動かす MCP サーバー（stdio）しか足せないツールは、橋渡しの `mcp-remote` を使います（Node.js が要ります）。

```json
{
  "mcpServers": {
    "tukurium": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://tukurium.rheni.work/mcp"]
    }
  }
}
```

登録できたら、エージェントの MCP の一覧に `tukurium` が出て、`guide`・`join_session`・`create_entity` などの道具が使えるようになります。

## 2. 作る場所を用意する（人がブラウザで）

エージェントは、人がいるセッションに入って作ります。

1. ブラウザで https://tukurium.rheni.work を開き、セッションを作って入る。
2. 「ワークスペース」から、作るワークスペースを開く（または新しく作る）。
3. アドレス欄の URL の `/s/` のあと（`s_` で始まる文字列）が、**セッションの ID** です。これをエージェントに伝えます。

## 3. エージェントに頼む

頼み方の例です。そのまま貼って、`s_xxxxxxxxxx` と作りたいものを書き換えてください。

```
Tukurium の MCP を使って制作してください。
1. まず guide を読んで、Tukurium の作り方を確かめてください。
2. join_session でセッション s_xxxxxxxxxx に入り、名前は「（あなたの名前）」にしてください。
3. list_workspaces で見えるワークスペースを open_workspace で開いてください。
4. 作ってほしいもの：（例）的が左右に動く射的。弾が当たると的の色が変わる。
5. 同じ形の Entity は apply_entities でまとめて作り、画像や GLB は import_asset で取り込んで材質に貼ってください。
6. 作ったら check で問題を確かめ、simulate で試しに動かし、preview で入口からの見た目を確かめてください。
7. 終わったら、何を作ったかを教えてください。保存は私がします。
```

## 4. 知っておくこと

- **エージェントの編集は、その場で画面に出ます。** エージェントは参加者「エージェント（名前）」として入ります。足したものや変えたものには、Inspector や Hierarchy に変化の印が付きます。
- **保存は人がします。** エージェントは保存（コミット）できません。結果を見て、よければワークスペースの「保存」から残してください。気に入らない変更は、保存パネルの差分から元に戻せます。
- **試しに動かす（simulate）は、サーバーの中だけで動きます。** ほかの人の画面には出ません。実際に遊んで確かめるときは、ブラウザで Play を押します。返す Entity は 200 件までです。`total` と `truncated` は、切れていないときも毎回入ります。
- **まとめて変える（apply_entities）は、成功した分が一つの変更になります。** 失敗した操作は結果に分かれ、成功した分は残ります。作成も更新も、成功すると ID と名前が返ります。
- プレハブは `create_prefab` で作り、`make_prefab_from_entity` で既存の Entity からも作れます。`place_prefab` でアウトプットや別のプレハブへ置き、中身は Entity の編集用の道具で変えます。`get_prefab` で中身を確認し、`update_prefab` で設定を変えます。
- インスタンスやそれを含む Entity は `duplicate_entity` で複製します。`revert_prefab_change` でインスタンスの変更を個別に戻せます。`apply_prefab_instance` は確認画面を出さずに元のプレハブへ適用します。`unpack_prefab_instance` は一段だけリンクを解除し、内側のインスタンスを残します。ライブラリの定義へは適用できません。
- **素材（import_asset）は、人が上げるときと同じ置き場に入ります。** GLB・PNG・JPEG・WebP・MP3・OGG・WAV で、1 つ 20MB までです。材質の色のテクスチャは、その画像の名前か ID で付けます。
- **視点の確認（preview）は、ブラウザでワークスペースを開いている人の画面を撮ります。** 再生中なら再生のホスト、編集中なら開いている人です。開いている人がいないときは撮れません。
- **サーバーを更新すると、セッションは消えます。** そのときは、もう一度セッションを作り、エージェントに新しい ID を伝えてください（作ったものはワークスペースに残ります）。
- **今は鍵がありません。** URL を知っている人は誰でもエージェントを使えます。人がブラウザから入るときは Misskey でのログインが要りますが、エージェントはまだ要りません。アカウントごとの鍵（トークン）と権限の設定は、あとで足す予定です。

## 困ったとき

| 起きたこと | 確かめること |
| --- | --- |
| 道具が一覧に出ない | URL が `/mcp` で終わっているか。ツールが HTTP（Streamable HTTP）の MCP に対応しているか（していなければ `mcp-remote` を使う） |
| 「セッションが見つかりません」 | セッションの ID が合っているか。サーバーの更新でセッションが消えていないか |
| 「ワークスペースを開いていません」 | 先に `join_session` と `open_workspace` を使う |
| 「閲覧だけです」 | そのワークスペースの既定の権限が閲覧になっている。ブラウザで共同編集の権限にする |
| 撃つなどの入力が効かない | 銃などの道具は、装備しないと入力が届かない。`simulate` の `equip` に道具を渡す |
