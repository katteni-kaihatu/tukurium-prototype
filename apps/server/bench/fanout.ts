// サーバーの中継の重さを、参加人数を変えて測る（サーバーを別に起動しておく）。
//   PORT=8799 node dist/main.js &
//   pnpm bench:server ws://localhost:8799/ws
// 全員が位置を 10Hz で送り、持ち主（セッションのホスト）が世界の状態（約 40KB ≒ 100 Entity）を 15Hz で配る。
// 位置が他の全員に届くまでの時間（中央値・95 パーセンタイル）を出す。
import { PROTOCOL_VERSION } from "@tukurium/shared";
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8799/ws";
const FRAME_BYTES = 40_000;
const SECONDS = 8;

interface Client {
  ws: WebSocket;
  id: string;
  on(fn: (m: { t: string; [k: string]: unknown }) => void): void;
  send(m: object): void;
}

async function connect(name: string): Promise<Client> {
  const ws = new WebSocket(url);
  const listeners: ((m: { t: string }) => void)[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    for (const l of listeners) l(m);
  });
  await new Promise((r) => ws.once("open", r));
  const send = (m: object) => ws.send(JSON.stringify(m));
  const welcome = new Promise<string>((r) =>
    listeners.push((m) => m.t === "welcome" && r((m as unknown as { you: { id: string } }).you.id)),
  );
  send({ t: "hello", protocol: PROTOCOL_VERSION, name });
  return { ws, id: await welcome, on: (fn) => listeners.push(fn as never), send };
}

async function run(n: number) {
  const owner = await connect("owner");
  const created = new Promise<string>((r) =>
    owner.on((m) => m.t === "session" && r((m.session as { id: string }).id)),
  );
  owner.send({ t: "session.create", name: `bench-${n}` });
  const sessionId = await created;
  const others = await Promise.all(Array.from({ length: n - 1 }, (_, i) => connect(`p${i}`)));
  for (const c of others) c.send({ t: "session.join", sessionId });
  await new Promise((r) => setTimeout(r, 500));
  const all = [owner, ...others];

  // 送った時刻を yaw に埋め込み、受け取った時刻との差を測る
  const lat: number[] = [];
  const t0 = performance.now();
  for (const c of all)
    c.on((m) => {
      if (m.t === "pose") lat.push(performance.now() - t0 - (m.yaw as number));
    });
  const world = { pad: "x".repeat(FRAME_BYTES) };
  const timers = [
    ...all.map((c) =>
      setInterval(
        () => c.send({ t: "pose", position: [0, 0, 0], yaw: performance.now() - t0, pitch: 0 }),
        100,
      ),
    ),
    setInterval(
      () =>
        owner.send({
          t: "session.frame",
          frame: { time: 0, world, names: {}, materials: [], status: [], sounds: [] },
        }),
      1000 / 15,
    ),
  ];
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  for (const t of timers) clearInterval(t);
  for (const c of all) c.ws.close();
  lat.sort((a, b) => a - b);
  const q = (p: number) => lat[Math.floor(lat.length * p)]?.toFixed(1);
  console.log({ participants: n, poses: lat.length, p50ms: q(0.5), p95ms: q(0.95) });
}

for (const n of [3, 10, 20, 40]) await run(n);
process.exit(0);
