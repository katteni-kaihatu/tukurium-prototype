# ADR 0015：最小の Library Package（ライブラリの作品・公開の印・content hash）

- 状態：採用（2026-11-03）
- 関連：ADR 0007（作品・リリース）、ADR 0010（論理パス・import）、ADR 0013（Package の同一性・版）
- 詳細計画：[`../plans/ugc-api-library-permissions.md`](../plans/ugc-api-library-permissions.md) の U3

## 背景

ADR 0013 で Package の考え方（安定 ID・書き換えない版・exports・依存の lock）を決めた。今ある「作品」と「リリース」の仕組みに載せて、最小の形を作る。

## 決定（利用者と決めたこと）

1. **Package はライブラリの作品とそのリリースで作る**。Output の Kind に「ライブラリ」を足す。Package ID は作品の ID、版はリリースの番号。
2. **使う側はプロジェクトの依存に足して import する**。依存には別名・Package ID・版・content hash を固定して書き、`import Gun from "@別名/Gun.koko"` のように書く（次の段階で入れる）。
3. **外から import できるのは「公開」の印を付けたものだけ**。印は KokoState・System・Material・素材に付けられる。フォルダと Built-in には付けない。
4. **Damage は今は Built-in のまま**。公式 Library へ移すのは U4。

## 形

- 公開の印は制作データに保存する（Y.Doc の `exports`、Snapshot の `exports`、Git の `exports.json`）。
- Package の中身（manifest）は、公開したリソースを ID の順に並べ、それぞれの論理パスと定義を持つ（`packageManifest`）。公開していないものは入らない。
- content hash は、サーバーがリリースのときに manifest を並べ方を決めた JSON（キーを並べ替える `stableStringify`）にして SHA-256 をかけて計算し、リリースに残す。クライアントの申告は使わない。
- 同じ作品・同じ版が違う hash で出ていたら拒む。取り出すとき（`GET /api/works/:id/releases/:version/package`）も計算し直して確かめる。
- 取り出せるのは、作品の「利用」が許されている人と持ち主。
- ライブラリの作品はセッションに置けない（置くものではなく、import して使う）。編集空間では Item と同じ置き方で見る。

## 依存と `@別名/...` の import（2026-11-04 に足した）

利用者と決めたこと：

- 今回は依存の lock・import の解決・診断・依存を足す最小の画面まで。実行時の取り込みは次の段階。
- 依存から取り込んだリソースの ID は、Package と版で区切る（`pkg:<Package ID>@<版>/<元の ID>`）。フォーク元のライブラリに依存しても、自分のリソースや別の版と ID がぶつからない。
- 依存は「ライブラリ」の欄から足す（作品と今の最新の版を選び、別名を付ける）。外すこともできる。使用箇所の表示・版の更新の案内は U5。

形：

- 依存は制作データに保存する（Y.Doc の `dependencies`、Snapshot の `dependencies`、Git の `tukurium.json` の `dependencies`）。一つずつ別名・Package ID・版・content hash を持つ。一つの Package は一つの版だけ、別名はプロジェクトの中で一つだけ。
- 別名には空白・`@`・`/` を使えない。`builtin` は Built-in のために取っておく。`@` で始まる import はライブラリを指す（`@builtin/` だけは Built-in）。
- 足すとき、版の content hash はサーバーが返したもの（`GET .../package`）を固定する。クライアントの申告は使わない。
- 依存の中身は、編集中の確認のときにクライアントが取り出し、Package ID と版ごとに覚える（版の中身は変わらないため）。取り出せなかったもの（許可がない・通信の失敗）は覚えず、次の確認で取り出し直す。取り出した hash が lock と違えば使わない。
- import できるのは、今の import と同じく KokoState だけ。
- 問題（Diagnostic）：
  - `import-package-unknown`：依存にない別名
  - `import-package-unavailable`：中身を取り出せない（許可・通信・hash の不一致）。再生（依存の中身を渡さない実行）でも、まだ使えないことをこの形で知らせる
  - `import-package-not-found`：その版に当てはまる公開のものがない。公開していないものと、ないものを区別しない（ライブラリの中身を漏らさない）
- 依存グラフでは、System → `name:package/<別名>` の辺を持つ。依存の版などを変えると、その別名を import した System だけを調べ直す。

## 実行時の取り込み（2026-11-04 に足した）

利用者と決めたこと：

- 今回は KokoState を再生まで通す。依存の KokoState を Entity に付けて値を入れ、それを import した System が再生で動く。ライブラリの System をアウトプットで使うこと・PackageExecutionContext は次の段階。
- 同じライブラリの同じ版の KokoState は、セッションに置いた別の物どうしで同じものとして扱う（相互運用の土台）。読み書きできるかは、今までどおり配置の境界と権限で決まる。
- セッションでは、サーバーがリポジトリ（リリースなら作品）の持ち主の許可で依存の中身を取り出し、配置と一緒にホストへ渡す。ホストが替わっても同じ結果になる。

形：

- 依存の KokoState の定義は、各クライアントが依存の中身から作り、`ProjectDoc` に持たせる（Y.Doc には入れない。同期も保存もしない）。Inspector で Entity に付けられ、値は制作データの Entity に `pkg:<Package ID>@<版>/<元の ID>` の名前で保存する。Resources には並べない（このプロジェクトのリソースではない）。
- Entity が持つ依存の KokoState が、今の依存（Package と版）のものでなければ注意にする（`package-kokostate-not-in-dependencies`。版を変えた・外したとき）。版を上げたときの値の移し替えは U5 の更新の案内で扱う。
- Simulation は、依存の KokoState を Built-in と同じく realm で区切らずに登録する（どの realm からも同じ ID）。名前での引き当て（移行の間の書き方）には出さない。どの realm も使わなくなったら外す。
- 区切らない KokoState は、Query だけでは別の配置の Entity まで当たってしまう。そこで、System が処理する Entity を、その System を使う配置の Entity に限った（ADR 0012 の既定の境界。Built-in だけの Query にも同じ穴があった）。
- 渡す形は、依存ごとの解決の結果（`PackageResolution`）の配列。ホストへの配置（`HostPart.packages`）と適用（`host.apply` の `packages`）に、依存があるときだけ足す（足すだけなので `PROTOCOL_VERSION` は上げない）。届いた結果が lock（Package・版・hash）と違うか、届いていない依存は、それを import した System が「中身が届いていません」で止まる。
- サーバーは版の中身をリリースごとに覚える（版は書き換えない）。許可は取り出すたびに確かめる。
- ワークスペースの再生では、クライアントが自分の許可で取り出した中身を渡す。

## 結果

- 内部（公開していないもの）だけを変えて出し直しても、hash は変わらない。使う側は hash の違いで中身の違いを知れる。
- 公開したリソースの論理パスは、その版の時点のものを manifest に残す。名前やフォルダを変えると、次の版では別のパスになる（使う側は lock した版を使い続ける）。
- ライブラリの System をアウトプットで使うこと（PackageExecutionContext を付ける）・依存の依存（manifest に依存を入れる）・輪の検出（自分のライブラリへの依存も含む）・抽出／フォークでの出所の保持は、次の段階で入れる。
