/** 履歴の 1 件。新しいものから古いものへ並べる（Git の log と同じ順）。 */
export interface LogNode {
  oid: string;
  parents: string[];
}

/**
 * 1 行ぶんのグラフ。
 * 列は左から 0。incoming は上から降りてくる線、outgoing は下へ続く線。
 * forks は、この点から横に出て下のその列へつながる線（合流や、2 本目以降の親）。
 */
export interface LogGraphRow {
  oid: string;
  lane: number;
  incoming: boolean[];
  outgoing: boolean[];
  forks: number[];
}

/**
 * コミットの並びから、Git の log のような線の配置を決める。
 * いまの履歴は main の一本だが、親が複数あっても線が分かれる。
 */
export function layoutLog(commits: LogNode[]): LogGraphRow[] {
  let lanes: (string | undefined)[] = [];
  const rows: LogGraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    let lane = before.indexOf(commit.oid);
    if (lane === -1) {
      lane = before.indexOf(undefined);
      if (lane === -1) {
        lane = before.length;
        before.push(commit.oid);
      } else {
        before[lane] = commit.oid;
      }
    }

    const outgoingLanes = before.slice();
    outgoingLanes[lane] = undefined;
    const forks: number[] = [];
    const place = (parent: string, preferred: number | null): number => {
      const existing = outgoingLanes.indexOf(parent);
      if (existing !== -1) return existing;
      if (preferred !== null && outgoingLanes[preferred] === undefined) {
        outgoingLanes[preferred] = parent;
        return preferred;
      }
      let slot = outgoingLanes.indexOf(undefined);
      if (slot === -1) {
        slot = outgoingLanes.length;
        outgoingLanes.push(parent);
      } else {
        outgoingLanes[slot] = parent;
      }
      return slot;
    };

    const first = commit.parents[0];
    if (first) {
      const firstLane = place(first, lane);
      if (firstLane !== lane) forks.push(firstLane);
    }
    for (const parent of commit.parents.slice(1)) {
      const parentLane = place(parent, null);
      if (parentLane !== lane && !forks.includes(parentLane)) forks.push(parentLane);
    }

    while (outgoingLanes.length > 0 && outgoingLanes[outgoingLanes.length - 1] === undefined) {
      outgoingLanes.pop();
    }

    const width = Math.max(before.length, outgoingLanes.length, lane + 1);
    rows.push({
      oid: commit.oid,
      lane,
      incoming: Array.from({ length: width }, (_, i) => lanes[i] !== undefined),
      outgoing: Array.from({ length: width }, (_, i) => outgoingLanes[i] !== undefined),
      forks,
    });
    lanes = outgoingLanes;
  }

  return rows;
}
