/** カーソルを載せてから、本文の先読みを頼むまでの時間。通り過ぎただけの行は頼まない。 */
export const HOVER_DELAY_MS = 200;
/** 最後のスクロールから、止まったとみなすまでの時間。 */
export const SCROLL_SETTLE_MS = 200;
/** 見えている行が変わってから、本文の先読みを頼むまでの時間。 */
export const VISIBLE_DELAY_MS = 300;
/** 1 回に頼める数 (API の上限)。 */
export const MAX_PREFETCH_IDS = 50;

export type PrefetchReason = "hover" | "visible";

/**
 * 一覧で、本文をまだ取り込んでいないメールの先読みを頼む時機を決める。
 * - カーソルを載せた行は、少し止まっていたら頼む (同じメールは 1 回だけ)。
 * - 画面に見えている行は、顔ぶれが変わって少し経ったら、上から順にまとめて頼む。
 * - スクロールしている間は頼まず、止まってから頼む。
 */
export class BodyPrefetcher {
  private scrolling = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private visibleTimer: ReturnType<typeof setTimeout> | null = null;
  private hovered: string | null = null;
  private readonly hoverSent = new Set<string>();
  private visibleIds: string[] = [];
  private visibleKey = "";
  private visibleSentKey = "";

  constructor(
    private readonly send: (ids: string[], reason: PrefetchReason) => void,
  ) {}

  /** 一覧がスクロールした。 */
  scrolled() {
    this.scrolling = true;
    this.clear("hoverTimer");
    this.clear("visibleTimer");
    this.clear("settleTimer");
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.scrolling = false;
      this.scheduleHover();
      this.scheduleVisible();
    }, SCROLL_SETTLE_MS);
  }

  /** カーソルが載っている、本文が未取得のメール。離れたときや取得済みの行では null。 */
  hover(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.clear("hoverTimer");
    this.scheduleHover();
  }

  /** 画面に見えている行のうち、本文が未取得のメール (上から順)。 */
  visible(ids: string[]) {
    const key = ids.join(",");
    if (key === this.visibleKey) return;
    this.visibleKey = key;
    this.visibleIds = ids.slice(0, MAX_PREFETCH_IDS);
    this.clear("visibleTimer");
    this.scheduleVisible();
  }

  dispose() {
    this.clear("settleTimer");
    this.clear("hoverTimer");
    this.clear("visibleTimer");
  }

  private clear(name: "settleTimer" | "hoverTimer" | "visibleTimer") {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private scheduleHover() {
    const id = this.hovered;
    if (this.scrolling || id === null || this.hoverSent.has(id)) return;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.hoverSent.add(id);
      this.send([id], "hover");
    }, HOVER_DELAY_MS);
  }

  private scheduleVisible() {
    if (
      this.scrolling ||
      this.visibleIds.length === 0 ||
      this.visibleKey === this.visibleSentKey
    ) {
      return;
    }
    this.visibleTimer = setTimeout(() => {
      this.visibleTimer = null;
      this.visibleSentKey = this.visibleKey;
      this.send(this.visibleIds, "visible");
    }, VISIBLE_DELAY_MS);
  }
}
