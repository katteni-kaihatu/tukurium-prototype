import { decodeValue, stringifyValue } from "@tukurium/eks";
import type { DebugStop } from "@tukurium/shared";

/** 一時停止したときのコピーだけを読む。VM に問い合わせない。 */
export function debugHoverValue(
  stop: DebugStop | null,
  frameId: number | null,
  systemId: string,
  name: string,
): string | null {
  if (!stop) return null;
  const frame = stop.frames.find((f) => f.id === frameId) ?? stop.frames.at(-1);
  if ((frame?.systemId ?? stop.systemId) !== systemId) return null;
  const value = frame?.variables.find((v) => v.name === name);
  if (!value) return null;
  return value.unavailable ? "この位置では読めません" : stringifyValue(decodeValue(value.value), 2);
}
