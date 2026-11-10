/** 読み込みが 0 になるか、制限時間まで待つ。終わっていれば true */
export async function waitUntilIdle(pending: () => number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (pending() > 0) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
