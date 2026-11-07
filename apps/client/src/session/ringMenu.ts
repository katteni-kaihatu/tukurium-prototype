/**
 * リングメニュー（T で開く）に並べる項目（ADR 0053）。
 * 空間を動かしている側（ワークスペースの再生・セッションの世界）が、その時にできることを出す。
 * 同じ id の項目は一つにまとめ、どれか一つでもできれば押せる。押すと、できる側のものをすべて実行する。
 */
export interface RingItem {
  id: string;
  label: string;
  /** 押せないときの説明 */
  hint?: string;
  enabled: boolean;
  run: () => void;
}

const providers = new Set<() => RingItem[]>();

/** 項目を出す側を登録する。戻り値で解除 */
export function provideRingItems(provider: () => RingItem[]): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

/** いま並べる項目（同じ id はまとめる） */
export function ringItems(): RingItem[] {
  const byId = new Map<string, RingItem[]>();
  for (const provide of providers) {
    for (const item of provide()) byId.set(item.id, [...(byId.get(item.id) ?? []), item]);
  }
  return [...byId.values()].map((same) => {
    const first = same[0] as RingItem;
    const able = same.filter((i) => i.enabled);
    return {
      id: first.id,
      label: first.label,
      hint: able.length > 0 ? undefined : first.hint,
      enabled: able.length > 0,
      run: () => {
        for (const i of able) i.run();
      },
    };
  });
}
