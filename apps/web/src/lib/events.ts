import { ApiError, apiFetch, getToken } from "@/lib/api";

export type ServerEvent = { event: string; data: string };

/** SSE のテキストを 1 イベントずつに分ける。未完の残りは rest で返す。 */
export function parseSseChunk(buffer: string): {
  events: ServerEvent[];
  rest: string;
} {
  const events: ServerEvent[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

const MIN_DELAY = 1_000;
const MAX_DELAY = 60_000;

/**
 * GET /v1/events に接続し、イベントを受けるたびに onEvent を呼ぶ。
 * EventSource は Authorization ヘッダーを付けられないので fetch のストリームで読む。
 * 切れたら間隔を広げながら繋ぎ直す (ネットワークが戻ったら、すぐに繋ぎ直す)。
 * 戻り値の関数で停止する。
 */
export function subscribeEvents(
  onEvent: (event: ServerEvent) => void,
  options: {
    /** 端末ごとの ID。サーバーが、接続している端末を数えるのに使う。 */
    deviceId?: string;
    /** 接続できた、または切れたときに呼ぶ。 */
    onState?: (connected: boolean) => void;
  } = {},
): () => void {
  const controller = new AbortController();
  let delay = MIN_DELAY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let wake: (() => void) | null = null;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    });
  const onOnline = () => {
    delay = MIN_DELAY;
    wake?.();
  };
  window.addEventListener("online", onOnline);

  const run = async () => {
    while (!controller.signal.aborted) {
      if (!getToken()) return;
      try {
        const response = await apiFetch(
          options.deviceId
            ? `/v1/events?device=${options.deviceId}`
            : "/v1/events",
          { signal: controller.signal },
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("stream unavailable");
        options.onState?.(true);
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseChunk(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            // 何か届けば接続は生きているので、再接続の間隔を戻す。
            delay = MIN_DELAY;
            if (event.event !== "ping") onEvent(event);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        // セッション切れは再接続しても直らない (ログイン画面へ移る)。
        if (error instanceof ApiError && error.status === 401) return;
      }
      if (controller.signal.aborted) return;
      options.onState?.(false);
      await wait(delay + Math.random() * 500);
      delay = Math.min(delay * 2, MAX_DELAY);
    }
  };
  void run();

  return () => {
    controller.abort();
    if (timer) clearTimeout(timer);
    window.removeEventListener("online", onOnline);
  };
}
