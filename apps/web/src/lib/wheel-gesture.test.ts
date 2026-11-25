import { describe, expect, it } from "vitest";
import { WheelStream } from "@/lib/wheel-gesture";

/** 動きを 16 ms ごとに加え、最後の動きで新しいスワイプと判定したかを返す。 */
function feed(stream: WheelStream, deltas: number[], start: { at: number }) {
  const results: boolean[] = [];
  for (const delta of deltas) {
    stream.add(start.at, delta);
    start.at += 16;
    results.push(stream.restarted());
  }
  return results;
}

/** 弱まり続ける慣性。jitter を与えると、毎回の量が決まった割合で揺れる。 */
function inertia(frames: number, from = 22, jitter = 0): number[] {
  const deltas: number[] = [];
  let delta = from;
  for (let frame = 0; frame < frames; frame++) {
    // 同じ結果になるよう、乱数ではなく決まった揺れ方にする。
    const wobble = 1 + jitter * Math.sin(frame * 2.3);
    deltas.push(Math.max(1, Math.round(delta * wobble)));
    delta *= 0.9;
  }
  return deltas;
}

/** 新しく払い始めた指の動き (止まった状態から速くなる)。 */
const STROKE = [2, 6, 14, 24, 30, 30, 26];

describe("WheelStream", () => {
  it("弱まり続ける慣性は、新しいスワイプとみなさない", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, STROKE, clock);
    expect(feed(stream, inertia(80), clock)).not.toContain(true);
  });

  it("揺れながら弱まる慣性も、新しいスワイプとみなさない", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, STROKE, clock);
    expect(feed(stream, inertia(80, 22, 0.15), clock)).not.toContain(true);
  });

  it("指を緩めたあとに慣性が始まって 1 回だけ速くなっても、新しいスワイプとみなさない", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, [...STROKE, 12, 5, 3], clock);
    expect(feed(stream, [14, ...inertia(40, 13)], clock)).not.toContain(true);
  });

  it("画面が固まって 1 つにまとめて届いた慣性は、新しいスワイプとみなさない", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, [...STROKE, ...inertia(6)], clock);
    const held = inertia(30).slice(6, 20);
    // 14 コマ分の動きが、最後の動きの時刻で 1 つにまとめて届く。
    clock.at += 16 * (held.length - 1);
    stream.add(
      clock.at,
      held.reduce((sum, delta) => sum + delta, 0),
    );
    clock.at += 16;
    expect(stream.restarted()).toBe(false);
    expect(feed(stream, inertia(30).slice(20), clock)).not.toContain(true);
  });

  it("慣性を指で止めてすぐ払い直すと、数コマで新しいスワイプとみなす", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, [...STROKE, ...inertia(10)], clock);
    // 指を置いて慣性が止まり、少し (40 ms) 空いてから動き始める。
    clock.at += 40;
    const results = feed(stream, STROKE, clock);
    expect(results.indexOf(true)).toBeGreaterThanOrEqual(0);
    expect(results.indexOf(true)).toBeLessThanOrEqual(3);
  });

  it("慣性が続いている上から払い直しても、新しいスワイプとみなす", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, [...STROKE, ...inertia(10)], clock);
    const tail = inertia(20, 8);
    const overlapped = STROKE.map((delta, index) => delta + (tail[index] ?? 0));
    const results = feed(stream, overlapped, clock);
    expect(results.indexOf(true)).toBeGreaterThanOrEqual(0);
    expect(results.indexOf(true)).toBeLessThanOrEqual(4);
  });

  it("途切れたあとの動きや、向きを変えた動きは新しいスワイプとみなす", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, [...STROKE, ...inertia(6)], clock);
    clock.at += 150;
    expect(feed(stream, [3], clock)).toEqual([true]);

    const turned = new WheelStream();
    const other = { at: 0 };
    feed(turned, [...STROKE, ...inertia(6)], other);
    expect(feed(turned, [-4, -8], other)).toEqual([false, true]);
  });

  it("操作を行う位置まで来たあと、速さが落ちたら指を離したとみなす", () => {
    const stream = new WheelStream();
    const clock = { at: 0 };
    feed(stream, STROKE.slice(0, 2), clock);
    stream.begin();
    feed(stream, STROKE.slice(2), clock);
    expect(stream.slowedDown()).toBe(false);
    feed(stream, [20, 16, 12], clock);
    expect(stream.slowedDown()).toBe(true);
  });
});
