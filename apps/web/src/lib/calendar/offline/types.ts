import type {
  AttendeeStatus,
  Calendar,
  CalendarEvent,
  EventFields,
  EventRange,
  EventTimeInput,
  InviteFailure,
} from "@/lib/calendar/api";

/**
 * カレンダーのオフライン対応 (端末の保存と同期) の、画面から見た形。
 * 画面はこの CalendarClient だけを使い、API を直接呼ばない。
 *
 * 画面に出すのは常に「サーバーの内容の控え (base) に送信待ち (queue) を重ねたもの」。
 * 書き込みはすぐに返り、送信待ちに積まれて、届くようになったら順に送られる。
 */

/** 予定を作るときの中身。id は省略すると端末で決める。 */
export type CreateEventInput = EventFields & {
  id?: string;
  calendarId: string;
  time: EventTimeInput;
};

/** 表示のオンオフなど、端末から変えられるカレンダーの項目。 */
export type CalendarChanges = Partial<
  Pick<
    Calendar,
    | "name"
    | "description"
    | "color"
    | "timeZone"
    | "visible"
    | "sortOrder"
    | "pollIntervalSeconds"
  >
>;

export type QueuedOpKind =
  | "create"
  | "update"
  | "occurrence_update"
  | "delete"
  | "occurrence_delete"
  | "respond"
  | "calendar_update";

/** 送信待ちの操作 (端末の IndexedDB に置き、全ウィンドウで共有する)。 */
export type QueuedOp = {
  /** 端末で作る UUID。 */
  id: string;
  /** 端末内の順番 (Date.now() * 1000 + 連番)。小さい順に送る。 */
  seq: number;
  kind: QueuedOpKind;
  calendarId: string;
  /** 予定の ID。回の操作では原本の ID。calendar_update では null。 */
  eventId: string | null;
  recurrenceId: string | null;
  /**
   * kind ごとの中身。
   * - create: CreateEventInput (id 付き)
   * - update / occurrence_update: EventFields (変えた項目だけ)
   * - delete / occurrence_delete: null
   * - respond: { status: AttendeeStatus }
   * - calendar_update: CalendarChanges
   */
  body: unknown;
  /** 項目ごとの、操作した時刻 (端末の時計のまま。ISO 8601)。 */
  changedAt: Record<string, string>;
  /** 操作した時刻 (削除・出欠の時刻にも使う)。 */
  at: string;
  /** 変える前の値 (通知と「元に戻す」に使う)。分からなければ null。 */
  before: Partial<EventFields> | null;
  /**
   * pending: 送る (送っている最中を含む)。
   * blocked: そのカレンダーの同期が止まっている。カレンダーかアカウントが変わったらやり直す。
   * error: サーバーに断られた。retry か discard されるまで残す。
   */
  state: "pending" | "blocked" | "error";
  /** API のエラーコード (deleted_elsewhere、invalid、read_only など)。 */
  error: string | null;
  /**
   * 一度でも送ろうとしたか (送る前に保存先へ書く)。応答が失われてもサーバーには届いていることが
   * あるので、印のある操作には、どのウィンドウも後の操作をまとめない。古い控えには無い。
   */
  attempted?: boolean;
  /**
   * 積んだときの予定全体 (update / occurrence_update / respond。回の操作では原本)。
   * 送る前に同期が削除を取り込んでも「復元」で作り直せるように持つ。古い控えには無い。
   */
  target?: CalendarEvent | null;
};

/**
 * 反映されなかった変更 (競合)。サーバーが記録したもの (source: server) と、
 * 端末で分かったもの (source: local) を同じ形で並べる。
 *
 * - field_lost: 相手側 (プロバイダ) の新しい変更に負けた → restore で自分の値に戻す
 * - write_failed: 書き戻しが確定して失敗し、相手側の内容に戻った → retry
 * - create_failed: 作成が確定して失敗した → retry / delete
 * - remote_deleted: 相手側で消された → restore (新しい予定として作る)
 * - delete_cancelled: 後から変更されていたので削除しなかった → delete (やはり削除する)
 * - rejected: ほかの端末が後から変えていたので、その項目は変えなかった (端末) → restore
 * - deleted_elsewhere: 変更しようとした予定が、ほかの端末で削除されていた (端末) → restore
 * - occurrence_gone: 変えようとした回が、繰り返しの変更で無くなっていた (端末) → restore (単発の予定として作る)
 * - failed: そのほかの理由で、サーバーに断られた (端末) → retry
 * - invite_failed: 招待メール (iMIP) を送れなかった (サーバー、段取り 8b) → resend (同じメールを送り直す)。
 *   一部の宛先だけ送れなかったときは dismiss だけ
 *
 * どれも dismiss で閉じられる。
 */
export type ConflictKind =
  | "field_lost"
  | "write_failed"
  | "create_failed"
  | "remote_deleted"
  | "delete_cancelled"
  | "rejected"
  | "deleted_elsewhere"
  | "occurrence_gone"
  | "failed"
  | "invite_failed";

export type ConflictAction =
  | "restore"
  | "retry"
  | "delete"
  | "resend"
  | "dismiss";

export type ConflictItem = {
  id: string;
  source: "server" | "local";
  kind: ConflictKind;
  calendarId: string | null;
  eventId: string | null;
  /** 回の変更なら、その回。 */
  recurrenceId: string | null;
  /** 表示用の題名 (その時点の予定の題名)。 */
  title: string | null;
  /** 反映されなかった項目。 */
  fields: (keyof EventFields)[];
  /** 自分の (負けた側の) 値。 */
  lost: EventFields | null;
  /** 採用された値 (分かれば)。 */
  kept: EventFields | null;
  /** 削除されたときの予定全体 (remote_deleted / deleted_elsewhere)。 */
  snapshot: CalendarEvent | null;
  /** API のエラーコードなど。 */
  reason: string | null;
  createdAt: string;
  /** この競合に使える操作 (dismiss は常に含む)。 */
  actions: ConflictAction[];
  /** 端末の送信待ちから来たものなら、その操作の ID。 */
  opId: string | null;
  /** invite_failed のときの、送れなかったメール (古い控えには無い)。 */
  invite?: InviteFailure | null;
};

export type EventRangeQuery = { from: string; to: string; timeZone: string };

export type CalendarClient = {
  /** 中身 (calendars / range / queue / conflicts) が変わったら呼ばれる。戻り値で解除する。 */
  subscribe(listener: () => void): () => void;
  /** カレンダーの一覧。まだ分からなければ null。中身が変わるまで同じ配列を返す。 */
  calendars(): Calendar[] | null;
  /**
   * 期間内の予定と回 (API の GET /events と同じ形)。まだ分からなければ null。
   * 中身が変わるまで同じオブジェクトを返す (useSyncExternalStore で使える)。
   */
  range(range: EventRangeQuery): EventRange | null;
  /** その予定 (原本・例外の ID のどちらでも) に関わる送信待ち。 */
  pendingFor(eventId: string): QueuedOp[];
  /** 送信待ちのすべて (古い順)。 */
  queue(): QueuedOp[];
  /** 反映されなかった変更 (サーバーの記録 + 端末の控え)。新しい順。 */
  conflicts(): ConflictItem[];
  /** 予定を作る。すぐ返り、予定の ID を返す。 */
  createEvent(input: CreateEventInput): string;
  updateEvent(id: string, changes: EventFields): void;
  updateOccurrence(
    masterId: string,
    recurrenceId: string,
    changes: EventFields,
  ): void;
  deleteEvent(id: string): void;
  deleteOccurrence(masterId: string, recurrenceId: string): void;
  respond(id: string, status: AttendeeStatus): void;
  updateCalendar(id: string, changes: CalendarChanges): void;
  /** error / blocked の操作を送り直す。 */
  retry(opId: string): void;
  /** 送信待ちから外す (送っている最中のものは外せない)。 */
  discard(opId: string): void;
  resolveConflict(id: string, action: ConflictAction): Promise<void>;
  /** 予定を探す。サーバーに届かなければ、端末の控えから探す。 */
  search(q: string): Promise<CalendarEvent[]>;
  /**
   * 端末の保存先に書けなかった変更があるか (容量不足など)。true の間は、送信待ちが
   * このウィンドウのメモリーにしか無い (閉じると失われる)。書けたら false に戻る。
   */
  storageFailed(): boolean;
};
