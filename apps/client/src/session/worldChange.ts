/** 画面で数えている、ルートワールドの入れ替え */
export interface CountdownClock {
  id: string;
  endsAt: number;
}

/**
 * 同じ入れ替えの再配信では、初めに受け取った終わりを保つ。
 * 別の入れ替え（id が違う）なら、届いた残り時間から数え直す。
 */
export function nextCountdown(
  current: CountdownClock | null,
  change: { id: string; remainingMs: number } | null,
  now: number,
): CountdownClock | null {
  if (!change) return null;
  if (current?.id === change.id) return current;
  return { id: change.id, endsAt: now + change.remainingMs };
}

/** 画面に出す残り秒。入れ替わる直前まで 1 を出す */
export function countdownSeconds(endsAt: number, now: number): number {
  return Math.max(1, Math.ceil((endsAt - now) / 1000));
}
