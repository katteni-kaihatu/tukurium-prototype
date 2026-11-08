# ADR 0016：公式の発行者・同梱の公式ライブラリ・reference UGC（銃と的）

- 状態：採用（2026-11-04）
- 関連：ADR 0012（権限）、ADR 0013（Package の同一性）、ADR 0015（最小の Library Package）
- 詳細計画：ロードマップの ugc-api-library-permissions の U4

## 背景

U3 で、ライブラリの作品・版・依存・実行時の取り込みがそろった。U4 は、公式の部品（Platform Library）を同じ仕組みで出し、reference UGC を end-to-end で作って、どの機能を公式の層に上げるべきかを実測する。最初の一区切りを決める。

## 決定（利用者と決めたこと）

1. **最初の一区切りは「公式の土台＋銃と的」**。扉とスイッチ、収集物と Inventory は次。
2. **公式ライブラリ「combat」に入れるのは、Health と、Damage を受けて hp を減らす System（Damageable）だけ**。銃の弾・連射・リロード、的が倒れて戻る動きは、それぞれの UGC に残す。Damage の Contract は Built-in（Damage v1）のまま。
3. **今のサンプル（銃と的・銃・射撃場）は変えない**（E2E の背骨で使っている）。公式ライブラリを使う「銃と的（公式ライブラリ）」を別のサンプルとして足す。

## 形

- **公式の発行者**：決まった ID の利用者（`u_official`、「Tukurium 公式」）。ログインはできない（token を持たない）。「公式」かどうかは、作品の持ち主がこの発行者かで決める。名前が同じでも、ほかの利用者の作品は公式にならない（ADR 0013 §1）。`/api/works` は `official` を返し、ライブラリの欄に「公式」の印を出す。
- **同梱と登録**：公式ライブラリの中身は `packages/repo-model/src/official.ts` にある。サーバーは起動のときに、決まった ID（リポジトリ `r_official_combat`・作品 `w_official_combat`）で公式の発行者の作品として用意する（`ensureOfficialLibraries`）。どのサーバーでも同じ Package ID になる。最新の版の content hash が同梱の中身と違えば（版がなければ）、コミットして新しい版を出す。出した版は書き換えない。何度起動しても、中身が同じなら版は増えない。
- **combat v1 の中身**：`/Health.koko`（hp・maxHp）と `/Damageable.system`（`contracts.Damage` で hp を減らす。0 より下にはしない）。
- **reference UGC「銃と的（公式ライブラリ）」**：今の銃と的と同じ遊び方。的は公式の `Health` を持ち、Damage は公式の `@combat/Damageable` が受ける。的が倒れて戻る動きは、自分の `TargetFall`（`@combat/Health.koko` を import）と自分の KokoState `Respawn` が持つ。サンプルを作るときに、そのサーバーの公式 combat の最新の版を依存に固定（lock）する。
- **相互運用**：公式ライブラリを使わない今の銃（別の作者の Item）からの Damage も、公式の Damageable が受ける（Contract は Built-in の Damage v1 で、受ける側が誰の System でもよい）。
- 公式ライブラリは、セキュリティの境界ではない。Runtime gateway を迂回できる特権は持たず、権限は今までどおり「宣言 ∩ 置いた物への付与」。

## 扉とスイッチ（2026-11-04 に足した）

利用者と決めたこと：

- プレイヤーは E（use）で、見ている物を押す。Host が視線の先を調べ、その物が `Interact` を受け付けていれば、Built-in の Contract「Interact v1」を送る。物を持っていなくても押せる。
- 公式「interaction」には、Toggle（on）と、Interact を受けて on を切り替える System（Toggleable）だけを入れる。扉の開き方（角度・速さ）とスイッチの色は、扉とスイッチのサンプルの側に残す。扉とスイッチは同じプロジェクトに置く。

形：

- **Interact v1**：payload は `{ player }`。player は Host が実際の入力から入れる。スクリプトからは `hit.send("Interact")` で送れない（偽の player を名乗れない。`HOST_ONLY_CONTRACTS`）。
- **届く条件**：視線の先 3 m まで（`INTERACT_RANGE`）。自分が持っている物は通り抜ける。セッションでは、相手の配置の「外からの見え方」が非公開なら見つからず、衝突のみなら届かない（インタラクション可能のときだけ）。ワークスペースの再生（作者の試し）では見え方で止めない。受け付ける System（`contracts.Interact`）がなければ何もしない。use の入力そのものは、今までどおり System の onInput にも届く。
- **公式 interaction v1**：`/Toggle.koko`（on）と `/Toggleable.system`。リポジトリ `r_official_interaction`・作品 `w_official_interaction`。
- **reference UGC「扉とスイッチ」**：スイッチ（公式の Toggle）を E で押すと、扉の軸（自分の KokoState `Door`：開く角度・速さ・今の角度・つないだスイッチ）が `world.get(スイッチ, Toggle)` を見て回る。スイッチの色は自分の `SwitchLight`。

## 結果

- 「Health と Damage の受け取り」は、二つの UGC（今の銃と、reference の的）の間で、公式ライブラリを通して共通に使えることを確かめた。
- まだ決めていないこと（次の段階）：
  - API の安定度（experimental / preview / stable / deprecated）の印と診断。combat v1 は experimental 扱い（印はまだない）。
  - Damage の Contract を Built-in から公式ライブラリへ移すか（Contract をライブラリから公開する仕組みが要る）。
  - 収集物と Inventory（Pickup・所有権）の reference UGC。
  - 別の作者のスイッチで扉を開ける（配置をまたいで状態を読む公開の手段が要る）。
  - 公式ライブラリの更新の案内（使う側は lock した版のまま。更新は U5 の画面）。
