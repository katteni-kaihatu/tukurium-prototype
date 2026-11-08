# ADR 0019：API の安定度は、今はすべて experimental

- 状態：採用（2026-11-04）
- 関連：ADR 0012（権限・authority）、ADR 0016（公式ライブラリ）、ADR 0018（バッグ）
- 詳細計画：ロードマップの ugc-api-library-permissions の U4（安定性）

## 背景

U4 で、公式ライブラリ（combat・interaction・items）と、それを使う reference UGC を三つ作った（銃と的・扉とスイッチ・鍵と扉）。計画では、ここで分かったことをもとに、どの機能を公式 API として約束するかを決め、experimental / preview / stable / deprecated の印を付けることになっていた。

Host だけで判定でき、複数の作品で使われた機能（`world.raycast`・Built-in の Damage / Interact など）を preview にする案も考えた。

## 決定（利用者と決めたこと）

1. **Host API と Built-in の Contract は、今はすべて experimental**。preview・stable はまだ付けない。
2. **公式ライブラリは、ワークショップ（公開・検索）ができたあとに公式アカウントが公開する UGC の一つ**として扱う。安定度の印は付けない。使う側は、ほかのライブラリと同じく版の固定（lock）で守られる（ADR 0015）。公式ライブラリは特権を持たない（ADR 0016）。
3. **知らせ方は、エディタの型の説明と入力補完に「experimental」を添えるだけ**。すべてが experimental なので、問題の欄には出さない。

## 形

- `HOST_API_SPEC` の各項目に `stability`（書かなければ `DEFAULT_STABILITY` = experimental）。`BUILTIN_CONTRACTS` の各 Contract にも `stability`。
- `hostApiDeclarations()`・`hostApiCompletions()` の説明の終わりに「要る権限：…・experimental」。
- テストで、今はすべて experimental であることを固める（印を上げるときは、この ADR を置き換えてからテストを変える）。

## 結果・あとで決めること

- preview / stable に上げるのは、ワークショップができ、利用者の作品で実際に使われてから。上げるときは、計画の「公式 API への昇格条件」（stable identity・schema・権限・authority・quota・lifecycle・Diagnostic・conformance test）をそろえる。
- `server-revalidate` / `server-execute` の API（`world.set`・`bag.add` など）は、Server の判定を作るまで experimental のまま（計画の決まり）。
- 問題の欄で知らせるのは、preview / stable の API が出てきて、experimental と混ざるようになってから考える。
