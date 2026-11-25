/**
 * トラックパッドの 2 本指の横スクロール (wheel イベント) で行うスワイプの判定。
 *
 * トラックパッドでは、指を離したあとも OS が慣性の動きを送り続ける (macOS、Windows の
 * Precision Touchpad とも。DOM からは指の動きか慣性かを区別する情報が得られない)。
 * 操作したあとに続く慣性で次の操作をしないよう、届く動きが「慣性の続き」か
 * 「新しく払い始めた動き」かを、動きの速さの変わり方で見分ける。
 *
 * - 慣性は、同じ向きのまま、だんだん遅くなる。
 * - 新しく払い始めた動きは、途切れのあとに始まるか、速さが続けて上がる、または向きが変わる。
 *
 * 速さは「動いた量 ÷ 前の動きからの時間」で測る。画面が固まる (別のメールを描く) と、
 * その間の動きはブラウザーが 1 つにまとめて大きな動きとして届けるが、時間で割るので
 * 速さは変わらず、新しい動きと取り違えない。時刻は動きが作られた時刻 (eventTime) を使う。
 */

/** 横の動きがこれだけ途切れたら、そのあとの動きは新しく払い始めたもの (ms)。 */
export const WHEEL_GESTURE_GAP_MS = 100;
/** 新しく払い始めたとみなす、速さの上がり方 (直前までのいちばん遅い速さに対する倍率)。 */
const SPEED_UP_RATIO = 1.5;
/** 速さの上がり方を比べる、直前の動きの数。 */
const WINDOW = 5;
/** 操作を決めたあと、速さがいちばん速いときのこれだけに落ちたら、指を離した (慣性) とみなす。 */
const SLOW_DOWN_RATIO = 0.5;

/** まとめて届いた動きとみなす、直前の速さに対する割合。 */
const MERGED_SPEED_RATIO = 0.5;

type Sample = { at: number; dx: number; speed: number };

/** 横の動きの流れ。1 つの枠 (開いているメールの画面など) に 1 つ持つ。 */
export class WheelStream {
  private samples: Sample[] = [];
  private lastAt = Number.NEGATIVE_INFINITY;
  /** いま行っているスワイプでの、いちばん速い速さ。 */
  private peak = 0;

  /**
   * 横の動きを 1 つ加える。at は動きが作られた時刻 (ms)、dx は横の動きの量。
   * 戻り値は、前の動きからの時間 (ms)。
   */
  add(at: number, dx: number): number {
    const gap = at - this.lastAt;
    this.lastAt = at;
    const previous = this.samples.at(-1);
    // 間が空いて見えても、画面が固まっていた間の動きが 1 つにまとめて届いただけなら
    // (時刻は最後の動きのもの)、その間も同じくらいの速さで動き続けている。
    // 新しく払い始めた動きは止まった状態から始まるので、間の長さに比べて小さい。
    const broken =
      gap >= WHEEL_GESTURE_GAP_MS &&
      !(
        previous &&
        Math.sign(previous.dx) === Math.sign(dx) &&
        Math.abs(dx) / gap >= previous.speed * MERGED_SPEED_RATIO
      );
    // 途切れたあとの最初の動きは、時間で割ると遅く見えすぎるので、1 コマ分で割る。
    const interval = broken ? 16 : Math.max(8, gap);
    const speed = Math.abs(dx) / interval;
    if (broken) this.samples = [];
    this.samples.push({ at, dx, speed });
    if (this.samples.length > WINDOW + 3) this.samples.shift();
    this.peak = Math.max(this.peak, speed);
    return gap;
  }

  /** 新しいスワイプを始めた (いちばん速い速さを数え直す)。 */
  begin() {
    this.peak = this.samples.at(-1)?.speed ?? 0;
  }

  /**
   * 最後に加えた動きが、新しく払い始めた動きか。操作の直後 (慣性を無視している間) に使う。
   */
  restarted(): boolean {
    const samples = this.samples;
    const last = samples.at(-1);
    if (!last) return false;
    // 途切れたあとの動き (add で、それより前の動きは消してある)。
    if (samples.length === 1) return true;
    if (Math.abs(last.dx) < 3) return false;
    const before = samples.at(-2);
    const earlier = samples.at(-3);
    if (!before || !earlier) return false;
    // 向きが変わり、2 つ続けてその向き (慣性は向きを変えない。指の揺れの 1 つは数えない)。
    if (
      Math.sign(last.dx) === Math.sign(before.dx) &&
      Math.sign(before.dx) !== Math.sign(earlier.dx)
    ) {
      return true;
    }
    // 速さが 2 回続けて上がり、それまでのいちばん遅い速さよりはっきり速い
    // (慣性の始まりで 1 回だけ速くなることがあるので、1 回では数えない)。
    const previous = samples.slice(0, -2);
    if (previous.length === 0) return false;
    const slowest = Math.min(...previous.map((sample) => sample.speed));
    return (
      last.speed > before.speed &&
      before.speed > earlier.speed &&
      last.speed >= slowest * SPEED_UP_RATIO + 0.05
    );
  }

  /**
   * いまのスワイプで、指を離して慣性に移ったか (速さが十分に落ちた)。
   * 操作を行う位置まで来ていれば、慣性が終わるのを待たずにそこで操作を決める。
   */
  slowedDown(): boolean {
    const last = this.samples.at(-1);
    if (!last) return false;
    return Math.abs(last.dx) < 3 || last.speed < this.peak * SLOW_DOWN_RATIO;
  }
}

/**
 * イベントが作られた時刻 (ms)。iframe の中の文書とは時刻の基準が違うので、
 * それぞれの文書の基準 (timeOrigin) を足して揃える。
 */
export function eventTime(event: Event): number {
  const view = (event as UIEvent).view ?? window;
  const origin = view?.performance?.timeOrigin ?? performance.timeOrigin;
  return origin + event.timeStamp;
}
