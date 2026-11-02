import { z } from "zod";

/** 通信プロトコルの版。互換性のない変更をしたら上げる。 */
export const PROTOCOL_VERSION = 1;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** クライアント → サーバー */
export const ClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), protocol: z.number(), name: z.string().min(1).max(32) }),
  /** 自分の位置と向き（参加者の簡易表示用）。yaw / pitch はラジアン。 */
  z.object({ t: z.literal("pose"), position: vec3, yaw: z.number(), pitch: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const Participant = z.object({
  id: z.string(),
  name: z.string(),
  position: vec3,
  yaw: z.number(),
  pitch: z.number(),
});
export type Participant = z.infer<typeof Participant>;

/** サーバー → クライアント */
export const ServerMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    protocol: z.number(),
    you: z.string(),
    participants: z.array(Participant),
  }),
  z.object({ t: z.literal("joined"), participant: Participant }),
  z.object({ t: z.literal("left"), id: z.string() }),
  z.object({
    t: z.literal("pose"),
    id: z.string(),
    position: vec3,
    yaw: z.number(),
    pitch: z.number(),
  }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
