/**
 * 予定の並べ方。
 * - 時刻付き: 重なる予定のかたまりごとに列を割り当てる。表示では後の列を少しずらして重ねる。
 * - 終日の段: 週の中の帯を、重ならないように段 (レーン) に分ける。
 */

export type TimedItem = { id: string; start: number; end: number };
export type PlacedTimed = TimedItem & { column: number; columns: number };

/** 長さが短すぎる予定も、この分数ぶんの高さがあるものとして重なりを見る。 */
const MIN_SPAN = 20;

export function layoutTimed(items: readonly TimedItem[]): PlacedTimed[] {
  const sorted = [...items].sort(
    (a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id),
  );
  const result: PlacedTimed[] = [];
  let cluster: PlacedTimed[] = [];
  let columnsEnd: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const columns = columnsEnd.length;
    for (const item of cluster) item.columns = columns;
    result.push(...cluster);
    cluster = [];
    columnsEnd = [];
  };
  for (const item of sorted) {
    const end = Math.max(item.end, item.start + MIN_SPAN);
    if (cluster.length > 0 && item.start >= clusterEnd) flush();
    let column = columnsEnd.findIndex((value) => value <= item.start);
    if (column < 0) {
      column = columnsEnd.length;
      columnsEnd.push(end);
    } else {
      columnsEnd[column] = end;
    }
    cluster.push({ ...item, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length > 0) flush();
  return result;
}

export type BarItem = { id: string; from: number; to: number };
export type PlacedBar = BarItem & { lane: number };

/**
 * 週の帯を段に分ける。from / to はその週の何日目か (to を含む)。
 * 長い帯を先に上の段へ置く。
 */
export function layoutBars(items: readonly BarItem[]): PlacedBar[] {
  const sorted = [...items].sort(
    (a, b) =>
      a.from - b.from ||
      b.to - b.from - (a.to - a.from) ||
      a.id.localeCompare(b.id),
  );
  const lanes: number[] = [];
  return sorted.map((item) => {
    let lane = lanes.findIndex((end) => end < item.from);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(item.to);
    } else {
      lanes[lane] = item.to;
    }
    return { ...item, lane };
  });
}
