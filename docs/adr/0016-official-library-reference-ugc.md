# ADR 0016：公式の発行者・同梱の公式ライブラリ・reference UGC（銃と的）

- 状態：採用（2026-11-04）
- 関連：ADR 0012（権限）、ADR 0013（Package の同一性）、ADR 0015（最小の Library Package）
- 詳細計画：[`../plans/ugc-api-library-permissions.md`](../plans/ugc-api-library-permissions.md) の U4

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

## 結果

- 「Health と Damage の受け取り」は、二つの UGC（今の銃と、reference の的）の間で、公式ライブラリを通して共通に使えることを確かめた。
- まだ決めていないこと（次の段階）：
  - API の安定度（experimental / preview / stable / deprecated）の印と診断。combat v1 は experimental 扱い（印はまだない）。
  - Damage の Contract を Built-in から公式ライブラリへ移すか（Contract をライブラリから公開する仕組みが要る）。
  - 扉とスイッチ（Interact）、収集物と Inventory（Pickup・所有権）の reference UGC。
  - 公式ライブラリの更新の案内（使う側は lock した版のまま。更新は U5 の画面）。
