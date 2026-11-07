# ADR 0015：最小の Library Package（ライブラリの作品・公開の印・content hash）

- 状態：採用（2026-11-03）
- 追記：公開の印は ADR 0054 で、ライブラリのアウトプットごとの「含めるリソース」に置き換えた
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

- 依存は制作データに保存する（Y.Doc の `dependencies`、Snapshot の `dependencies`、Git の `tukurium.json` の `dependencies`）。一つずつ別名・Package ID・版・content hash を持つ。別名はプロジェクトの中で一つだけ。同じ Package の同じ版は一つだけ（別の版は別の別名で共存できる。下の「抽出とフォーク」）。
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

## ライブラリの System（2026-11-04 に足した）

利用者と決めたこと：

- ライブラリの System が import できるのは、同じライブラリで公開した KokoState と Built-in だけ。公開していないものを import する System に公開の印を付けると、ライブラリ側で問題にする（`exported-system-imports-private`）。内部だけの変更で hash が変わらないまま。
- ライブラリの System は、使うプロジェクト（realm）とライブラリの版ごとに一つの VM で動かす。同じライブラリでも、使うプロジェクトが違えば変数は混ざらない。使う側のスクリプトとも別の VM。

形：

- アウトプットの System の一覧に、依存の System を `pkg:<Package ID>@<版>/<元の ID>` の ID で入れる。画面では `@別名/名前` と出し、「System を追加」から選べる。「使う権限」にもそのコードから読み取った Capability を足す。
- 実行するとき、依存の中身から公開したものだけの制作データを組み立て直し（`librarySnapshot`）、ライブラリの中の論理パスで import を解決する。公開していないものは「見つからない」になる。ライブラリの System の `@別名` は、そのライブラリの依存で解決する（下の「依存の依存」）。
- ライブラリの System は自分の VM（`<realm>|pkg:<Package ID>@<版>`）で動く。セッションでは、Entity の KokoState のうち使う側のもの（realm で区切った KokoState）は見えず、見えるのは Built-in と依存の KokoState。ワークスペースの再生（一人の作者のプロジェクトだけ）では区切らないので見える。
- 権限は今までどおり「System の宣言 ∩ 置いた物への付与」。宣言はライブラリの System のコードから読み取る。
- `executionContext()` は、ライブラリの System なら本当の Package（作品の ID・版・content hash）を主体にする（`packageInstanceId` は配置と Package・版）。それ以外は今までどおりワークスペースの出力を暗黙の Package とする。
- アウトプットのライブラリの System が今の依存にない版なら注意にする（`output-system-not-in-dependencies`）。届いていない・公開されていない System は、理由つきで止まる。

## 依存の依存（2026-11-04 に足した）

利用者と決めたこと：

- 依存の依存の中身は、間のライブラリの作者の許可で取り出す（Lib2 の作者が Lib1 を使えればよい。使う人は Lib2 を使えれば動く）。Lib1 が「利用」を許していなくても、公開分は Lib2 を通して届く。
- 依存をたどると同じライブラリの別の版が混ざったときは、共存させる（ID が版で区切られているのでぶつからない）。版が違う KokoState は別の型になるので、注意として知らせる（`package-versions-mixed`）。
- 使う側のプロジェクトが import したり Entity に付けたりできるのは、直接の依存のものだけ。依存の依存は、ライブラリの System のために実行時に読み込む。

形：

- manifest にライブラリの依存（lock：別名・Package ID・版・hash。別名の順）を入れる。依存があるときだけ入れるので、依存のないライブラリの hash は前と同じ。
- 依存の中身は、lock（Package・版・hash）で照らし合わせる（別名は依存を書いた側ごとに違うため）。実行には、直接の依存と依存の依存を集めたもの（pool）を渡す。
- サーバー：版の中身を取り出す API（`GET .../package`）と、セッションのホストへ添える中身は、依存の依存までたどる。たどってきた Package に戻る依存は「依存が輪になっています」、深さは 16 まで。
- ライブラリをリリースするとき、依存の依存を通して自分自身に依存していたら拒む（輪）。ライブラリの欄では、開いているプロジェクト自身のライブラリは「プロジェクトで使う」を押せない。
- クライアントは、依存の依存まで取り出せた版だけを覚える（取り出せなかったものは次の確認で取り出し直す）。

## 抽出とフォーク（2026-11-04 に足した）

利用者と決めたこと：

- 同じライブラリの別の版は、一つのプロジェクトの中でも別の別名で共存できる（「一つの Package は一つの版だけ」をやめた）。ID が版で区切られているのでぶつからない。混ざっていることは `package-versions-mixed` の注意で知らせる。

形：

- フォークはリポジトリをまるごと写すので、依存（lock）・公開の印・フォルダはそのまま残る。
- 抽出では、取り出したもの（Entity の KokoState・アウトプットの System・System の `@別名` の import）が使う依存を、取り込み先へ持ってくる。
  - 取り込み先に同じ lock があれば、その別名を使う。
  - 別名がほかのもの（別のライブラリ・同じライブラリの別の版）とぶつかれば、`別名_2` のように付け替える。
  - `pkg:` の ID は lock で決まるので、Entity の値やアウトプットの System は書き換えない。
  - 持ってきた依存は、由来（provenance）の `dependencies` に残す。
- 抽出では、取り出したものが入っていたフォルダも作る（同じパスのフォルダがあればそれを使う）。そのうえで、取り出した System の import を、取り込み先の構造（名前を付け替えた KokoState を含む）と依存の別名に合わせて AST で書き直す（`rewriteImports`）。取り出し元で解決できなかった import には手を付けない。

## 結果

- 内部（公開していないもの）だけを変えて出し直しても、hash は変わらない。使う側は hash の違いで中身の違いを知れる。
- 公開したリソースの論理パスは、その版の時点のものを manifest に残す。名前やフォルダを変えると、次の版では別のパスになる（使う側は lock した版を使い続ける）。
- U3（最小の Library Package）はこれで一通りそろった。公式 Library・reference UGC は U4、依存の画面（使用箇所・版の更新）は U5。
