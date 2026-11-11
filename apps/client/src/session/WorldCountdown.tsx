import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import styles from "./WorldCountdown.module.css";
import { type CountdownClock, countdownSeconds, nextCountdown } from "./worldChange";

/** ルートワールドが変わる前に、セッションの全員へ出す残り秒 */
export function WorldCountdown() {
  const change = useApp((s) => s.session?.worldChange ?? null);
  const [clock, setClock] = useState<CountdownClock | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = Date.now();
    setNow(at);
    setClock((current) => nextCountdown(current, change, at));
    if (!change) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [change]);
  if (!change || !clock || clock.id !== change.id) return null;
  const seconds = countdownSeconds(clock.endsAt, now);
  return (
    <div className={`glass ${styles.countdown}`} role="status" aria-live="assertive">
      <b className={styles.number} aria-hidden="true">
        {seconds}
      </b>
      <p className={styles.title}>
        {seconds}秒後に、ワールドが「{change.worldName}」に変わります
      </p>
      <p className={styles.by}>{change.byName} が変えようとしています</p>
    </div>
  );
}
