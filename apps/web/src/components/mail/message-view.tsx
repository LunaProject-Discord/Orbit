"use client";

import { cn } from "cn";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderInputIcon,
  ForwardIcon,
  ImageOffIcon,
  InfoIcon,
  MailCheckIcon,
  MailIcon,
  MailOpenIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  OctagonAlertIcon,
  PaperclipIcon,
  ReplyAllIcon,
  ReplyIcon,
  SignatureIcon,
  StarIcon,
  TextSearchIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import {
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Hint } from "@/components/hint";
import { ExactTime } from "@/components/mail/exact-time";
import { MailboxMark, MoveTarget } from "@/components/mail/mailbox-icon";
import { MessageAttachments } from "@/components/mail/message-attachments";
import { MessageFindBar } from "@/components/mail/message-find-bar";
import {
  MessageSwipe,
  type MessageSwipeSide,
  SwipeSurfaceContext,
} from "@/components/mail/message-swipe";
import {
  type ProfileActions,
  ProfileName,
  ProfileNames,
} from "@/components/mail/profile-card";
import { QuickReply } from "@/components/mail/quick-reply";
import { SenderAvatar } from "@/components/mail/sender-avatar";
import {
  AuthResultsRows,
  SenderWarningBanner,
  SenderWarningMark,
  VerifiedSenderMark,
} from "@/components/mail/sender-check";
import { swipeLooks } from "@/components/mail/swipe-row";
import {
  ToolbarButton,
  ToolbarSeparator,
  ToolbarTooltip,
} from "@/components/mail/toolbar-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountListMark } from "@/lib/account-icons";
import type { MessageActionInput } from "@/lib/actions";
import {
  type Account,
  type Address,
  ApiError,
  type Attachment,
  type MailboxSummary,
  type MessageDetail,
  type MessageSummary,
  type SignatureRule,
  type SwipeSettings,
  type ThreadMessage,
} from "@/lib/api";
import {
  normalizeContentId,
  patchCidReferences,
  replaceCidReferences,
  splitAttachments,
} from "@/lib/attachments";
import { type ComposeMode, senderAccount } from "@/lib/compose";
import { useDateStyle } from "@/lib/date-format-settings";
import { isDesktopApp } from "@/lib/desktop/app";
import { attachTextMenu } from "@/lib/desktop/text-menu";
import { setTitleBarTitle } from "@/lib/desktop/title-bar-menu";
import {
  externalLinkOf,
  handlesExternalLinks,
  interceptExternalLinks,
} from "@/lib/external-links";
import {
  addressLabel,
  formatCompactDate,
  formatFullDate,
  formatListDate,
} from "@/lib/format";
import { useFontFaceCss } from "@/lib/local-fonts";
import { actionTargets, mailboxLabel, useMailboxes } from "@/lib/mailboxes";
import {
  fetchAttachment,
  getMessage,
  getThread,
  isFresh,
  loadSavedMessage,
  loadSavedThread,
  peekMessage,
  peekThread,
  warmConversation,
} from "@/lib/offline";
import {
  type ActionHandler,
  type ActionOptions,
  skipsDeleteConfirm,
} from "@/lib/permanent-delete";
import {
  bodyExtraCss,
  bodyFontFamily,
  bodyStyle,
  updatePreferences,
  usePreferences,
} from "@/lib/preferences";
import {
  buildPrintDocument,
  type PrintableMessage,
  printHtml,
} from "@/lib/print-message";
import { DESKTOP_SCROLLBARS_ATTRIBUTE } from "@/lib/scrollbar-hover";
import { shortcutLabels } from "@/lib/shortcuts";
import { findContactRule, findThreadRule } from "@/lib/signatures";
import { resolveSwipe, useSwipeSettings } from "@/lib/swipe";
import { unsubscribeLinks } from "@/lib/unsubscribe";

/**
 * 本文が外部サーバーの画像を参照しているか。
 * 「画像を表示」の案内を出すかどうかを決めるだけなので、厳密な解析はしない
 * (読み込みを実際に止めているのは iframe 側の CSP)。
 */
export function hasRemoteImages(html: string): boolean {
  return (
    /<img\b[^>]*\ssrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html) ||
    /\bbackground\s*=\s*["']?\s*(https?:)?\/\//i.test(html) ||
    /url\(\s*["']?\s*(https?:)?\/\//i.test(html)
  );
}

/**
 * 本文の iframe の中のスクロールバー。アプリ側 (globals.css) と同じ見た目にする。
 * iframe の中ではスクリプトを動かさず、スクロール中かどうかが分からないので、
 * 本文にカーソルを乗せている間だけつまみを出し、つまみに乗ったら太くする。
 * 色は html に持たせた値 (--mail-sb) をつまみが引き継ぐ形にしている
 * (html:hover をスクロールバーに直接掛けても、表示が切り替わらないため)。
 * 本文の背景は白に固定しているので、色も明るい画面用に固定する。
 */
const BODY_SCROLLBAR_STYLE = [
  '<style>@property --mail-sb{syntax:"<color>";inherits:true;initial-value:transparent}',
  "html{--mail-sb:transparent;transition:--mail-sb .5s ease-out}",
  "html:hover{--mail-sb:rgb(0 0 0/.35);transition-duration:.1s}",
  "@supports selector(::-webkit-scrollbar){",
  "::-webkit-scrollbar{width:12px;height:12px;background:transparent}",
  "::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}",
  "::-webkit-scrollbar-thumb{min-height:36px;min-width:36px;border:solid transparent;border-width:2px 2px 2px 4px;border-radius:999px;background-color:var(--mail-sb);background-clip:content-box}",
  "::-webkit-scrollbar-thumb:horizontal{border-width:4px 2px 2px}",
  "::-webkit-scrollbar-thumb:hover,::-webkit-scrollbar-thumb:active{border-width:2px;background-color:rgb(0 0 0/.5)}}",
  "@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:var(--mail-sb) transparent}}",
  "</style>",
].join("");

/**
 * メール本文の HTML を iframe に入れるための文書。
 * CSP で外部への通信をすべて止め、開封を知らせる追跡画像なども読み込ませない。
 * allowRemoteImages が true のときだけ、https の画像の読み込みを許可する
 * (スクリプト、フォント、外部のスタイルシートなどは引き続き止める)。
 */
export function buildSrcDoc(
  html: string,
  allowRemoteImages = false,
  /** 本文のフォント、大きさ、行間 (設定で変えられる)。メール側の指定があれば、そちらが使われる。 */
  style = "font-family:system-ui,sans-serif;font-size:14px;line-height:1.6",
  /** 追加のスタイルの規則 (等幅の部分のフォントなど)。メール側のスタイルより前に置く。 */
  extraCss = "",
  /** フォントのファイルを読み込んでよいオリジン (Android アプリで端末のフォントを使うとき)。 */
  fontSrc = "",
): string {
  const imgSrc = allowRemoteImages ? "data: https:" : "data:";
  const fontPolicy = /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(fontSrc)
    ? `; font-src ${fontSrc}`
    : "";
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}${fontPolicy}">`,
    // 画像を読み込むときに、このアプリの URL を相手のサーバーへ伝えない。
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    '<meta charset="utf-8">',
    // 縦のスクロールは外側 (メール表示) で行うので、枠の中には縦のバーを出さない。
    // 高さは BodyFrame が中身に合わせる。
    // html と body の高さの指定 (100% など) は外す。残すと、枠を伸ばすたびに中身も伸びて高さが定まらない。
    `<style>html{background:#fff;color:#111;overflow-y:hidden}html,body{height:auto!important}body{margin:16px;${style};overflow-wrap:anywhere}img{max-width:100%;height:auto}${extraCss}</style>`,
    // パソコンだけ。スマホやタブレットは OS のバーのまま (アプリ側の globals.css と同じ)。
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute(DESKTOP_SCROLLBARS_ATTRIBUTE)
      ? BODY_SCROLLBAR_STYLE
      : "",
    // デスクトップ版では、本文の画像やリンクもつかんで引っ張れないようにする (アプリの画面と同じ)。
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-desktop")
      ? "<style>img,a{-webkit-user-drag:none}</style>"
      : "",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

type ReplyMode = Exclude<ComposeMode, "new">;

type Props = {
  /** 開いたメール。会話 (スレッド) がある場合は、その会話全体を表示する。 */
  messageId: string;
  /** 会話の全体ではなく、このメール 1 通だけを表示する (一覧で会話を広げて選んだとき)。 */
  single?: boolean;
  /** 1 通だけを表示しているときに、会話の全体の表示へ切り替える。 */
  onShowThread?: () => void;
  /** 値が変わると、表示を保ったまま取得し直す (同期による更新の反映)。 */
  refreshKey: number;
  /**
   * 一覧にあるこの会話の行。既読やスターは操作した直後からここに反映されるので、
   * 表示にはこちらを優先して使う。一覧に無ければ null。
   */
  summary: MessageSummary | null;
  /** 見出しに、どのアカウントのどのフォルダのメールかを出すために使う。 */
  accounts: Account[];
  mailboxes: MailboxSummary[];
  onAction: ActionHandler;
  /** 値が増えると、移動先のメニューを開く (ショートカットキー用)。 */
  moveRequest: number;
  /** count が増えると、表示中のメールへの返信・転送を始める (ショートカットキー用)。 */
  composeRequest: { count: number; mode: ReplyMode } | null;
  /** 返信・全員に返信・転送を始める。text は、本文の下の返信欄に書いてあった文章。 */
  onCompose: (mode: ReplyMode, message: MessageDetail, text?: string) => void;
  /** 本文の下の返信欄から、そのまま返信を送る。送れたら true。 */
  onQuickReply: (message: MessageDetail, text: string) => Promise<boolean>;
  /** 差出人や宛先のプロフィールカードから、そのアドレスのメールを検索する。 */
  onSearchAddress: (address: Address) => void;
  /** プロフィールカードから、そのアドレス宛てのメールを書き始める。accountId は開いているメールのアカウント。 */
  onComposeTo: (address: Address, accountId: string) => void;
  /** 連絡先ごと、会話ごとの署名 (設定済みかどうかの表示に使う)。 */
  signatureRules: readonly SignatureRule[];
  /** プロフィールカードから、そのアドレス宛てのメールに使う署名を決める。 */
  onContactSignature: (address: Address, accountId: string) => void;
  /** 開いている会話への返信・転送に使う署名を決める。 */
  onThreadSignature: (thread: {
    accountId: string;
    threadKey: string;
    subject: string;
  }) => void;
  onBack: () => void;
  /** メールだけを出すウィンドウ。一覧に戻るボタンを出さず、件名をタイトルバーに出す。 */
  standalone?: boolean;
  /** 一覧で前 (-1) や次 (1) にあるメールを開く。 */
  onStep: (step: 1 | -1) => void;
  /** 一覧の前や次に、開けるメールがあるか。 */
  canStep: { previous: boolean; next: boolean };
  /** メールが削除されていた場合に呼ぶ。 */
  onMissing: () => void;
  /** ツールバーの右端に置くもの (広い画面の検索欄)。 */
  toolbarEnd?: ReactNode;
  /** nonce が変わると、メールの中の検索を text で開く (検索欄の候補やショートカットキーから)。 */
  findRequest?: { text: string; nonce: number } | null;
  /** 値が増えると、表示しているメールを印刷する (デスクトップ版の Ctrl+P)。 */
  printRequest?: number;
};

type State =
  | { status: "loading" }
  | { status: "error" }
  /** thread は会話のメッセージ (古い順)。1 通だけのメールでは 1 件。 */
  /** size は会話全体の通数 (1 通だけを表示しているときも、会話全体を数える)。 */
  | { status: "ready"; thread: ThreadMessage[]; size: number };

export function MessageView({
  messageId,
  single = false,
  onShowThread,
  refreshKey,
  summary,
  accounts,
  mailboxes,
  onAction,
  moveRequest,
  composeRequest,
  onCompose,
  onQuickReply,
  onSearchAddress,
  onComposeTo,
  signatureRules,
  onContactSignature,
  onThreadSignature,
  onBack,
  standalone = false,
  onStep,
  canStep,
  onMissing,
  toolbarEnd,
  findRequest,
  printRequest = 0,
}: Props) {
  /** メールの中の検索。開いていなければ null。 */
  const [find, setFind] = useState<{ text: string; request: number } | null>(
    null,
  );
  const handledFind = useRef(findRequest?.nonce ?? 0);
  useEffect(() => {
    if (!findRequest || findRequest.nonce === handledFind.current) return;
    handledFind.current = findRequest.nonce;
    setFind((current) => ({
      text: findRequest.text || current?.text || "",
      request: (current?.request ?? 0) + 1,
    }));
  }, [findRequest]);
  const openFind = () =>
    setFind((current) => ({
      text: current?.text ?? "",
      request: (current?.request ?? 0) + 1,
    }));
  const contentRef = useRef<HTMLDivElement>(null);
  // 控えてある会話があれば、読み込み中の表示を挟まずに最初から表示する。
  const [initial] = useState(() =>
    initialView(messageId, summary?.mailboxId ?? null, single),
  );
  const [state, setState] = useState<State>(initial.state);
  /** 会話の中で、本文を開いているメッセージ。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    initial.expanded,
  );
  // 同じメールでも、会話の全体と 1 通だけの表示は別のものとして扱う。
  const viewKey = `${messageId}:${single}`;
  const [shownId, setShownId] = useState(viewKey);
  if (shownId !== viewKey) {
    // 別のメールを選んだら、前の本文を出したままにしない。
    setShownId(viewKey);
    const next = initialView(messageId, summary?.mailboxId ?? null, single);
    setState(next.state);
    setExpanded(next.expanded);
    setFind(null);
  }

  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  /** 開いているメールについて、これまでに会話の中で見たメッセージと、既読にしたかどうか。 */
  const session = useRef({
    messageId: viewKey,
    known: new Set<string>(),
    markedRead: false,
  });
  /** 取得済みの本文。返信・転送の元にする。 */
  const details = useRef(new Map<string, MessageDetail>());
  const preferences = usePreferences();
  const preferencesRef = useRef(preferences);
  const printDateStyle = useDateStyle();
  const handledPrint = useRef(printRequest);
  // 印刷を頼まれたら、本文を開いているメール (無ければ最新の 1 通) を、表示しているとおりに印刷する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 印刷は printRequest が増えたときだけ行う
  useEffect(() => {
    if (printRequest === handledPrint.current) return;
    handledPrint.current = printRequest;
    if (state.status !== "ready") return;
    const opened = state.thread.filter((item) => expanded.has(item.id));
    const targets = opened.length > 0 ? opened : state.thread.slice(-1);
    /** 外部の画像を表示しているか (本文の枠の CSP で分かる)。すべてのメールで表示しているときだけ印刷にも入れる。 */
    let remoteImages = true;
    const messages = targets.map((item): PrintableMessage => {
      const detail = details.current.get(item.id);
      // 表示している本文の枠から取る (取得済みの埋め込み画像や、表示を許した外部の画像が入っている)。
      const frame = contentRef.current?.querySelector<HTMLIFrameElement>(
        `[data-message-print="${CSS.escape(item.id)}"] iframe`,
      );
      const shown = frame?.contentDocument ?? null;
      const shownHtml = shown?.body?.innerHTML || null;
      const policy =
        shown
          ?.querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "";
      if (!policy.includes("img-src data: https:")) remoteImages = false;
      const listed = detail
        ? splitAttachments(detail.bodyHtml, detail.attachments).listed
        : [];
      return {
        subject: detail?.subject ?? item.subject,
        from: detail?.from ?? item.from,
        to: detail?.to ?? item.to,
        cc: detail?.cc ?? item.cc,
        date: formatFullDate(item.receivedAt, printDateStyle),
        bodyHtml: shownHtml ?? detail?.bodyHtml ?? null,
        bodyText: detail?.bodyText ?? item.snippet,
        attachments: listed.map((file) => file.filename || "(名前なし)"),
      };
    });
    printHtml(
      buildPrintDocument(messages, {
        allowRemoteImages: remoteImages,
        bodyStyle: bodyStyle(preferences),
      }),
    );
  }, [printRequest]);

  preferencesRef.current = preferences;
  const swipeSettings = useSwipeSettings();
  /** 値が増えると、移動先のメニューを開く (スワイプで「フォルダを選んで移動」をしたとき)。 */
  const [swipeMove, setSwipeMove] = useState(0);
  /** 「少し待ってから既読にする」設定での待ち時間。別のメールへ移るか閉じたら取り消す。 */
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いているメールが変わるたびに取り消す
  useEffect(() => () => clearTimeout(readTimer.current), [viewKey]);

  /** 最後に取得したときの refreshKey。変わっていたら、控えがあってもサーバーから取り直す。 */
  const fetchedRefreshKey = useRef(refreshKey);

  // 控えを表示するときに、読み込み中の表示を一度も描かないよう、描画の前に行う。
  useLayoutEffect(() => {
    const controller = new AbortController();
    const refreshed = fetchedRefreshKey.current !== refreshKey;
    fetchedRefreshKey.current = refreshKey;
    if (session.current.messageId !== viewKey) {
      session.current = {
        messageId: viewKey,
        known: new Set(),
        markedRead: false,
      };
    }
    const mailboxId = summaryRef.current?.mailboxId ?? null;
    /** サーバーからの応答を反映したか (それより後に届いた端末の控えは使わない)。 */
    let settled = false;
    /**
     * 会話を表示する。markable が false (端末の控えなど、古いかもしれない内容) のときは、
     * 既読にする処理はサーバーからの応答を待って行う (ほかの端末で読んだメールを既読にし直さない)。
     */
    const apply = (all: ThreadMessage[], markable: boolean) => {
      const thread = single
        ? all.filter((message) => message.id === messageId)
        : all;
      if (thread.length === 0) {
        onMissing();
        return;
      }
      const current = session.current;
      const last = thread.at(-1);
      // 初めて見るメッセージのうち、未読のものと最新のものは本文を開いておく。
      // (自分で閉じたものは、取得し直しても閉じたままにする。)
      const open = thread
        .filter(
          (message) =>
            !current.known.has(message.id) &&
            (!message.seen || message.id === last?.id),
        )
        .map((message) => message.id);
      for (const message of thread) current.known.add(message.id);
      if (open.length > 0) {
        setExpanded((ids) =>
          open.every((id) => ids.has(id)) ? ids : new Set([...ids, ...open]),
        );
      }
      setState((previous) =>
        previous.status === "ready" &&
        previous.size === all.length &&
        sameThread(previous.thread, thread)
          ? previous
          : { status: "ready", thread, size: all.length },
      );

      // 開いたら既読にする (1 回だけ。あとから未読に戻した場合は、そのままにする)。
      // 設定によって、すぐに、少し待ってから、または自動では既読にしない。
      if (current.markedRead || !markable) return;
      const { markRead, markReadDelay } = preferencesRef.current;
      if (markRead === "never") return;
      current.markedRead = true;
      const mark = () => {
        // 1 通だけを表示しているときは、会話のほかのメールは既読にしない。
        const row = single ? null : summaryRef.current;
        const unread = thread
          .filter((message) => !message.seen)
          .map((message) => message.id);
        if (unread.length > 0 || (row && !row.seen)) {
          onActionRef.current(
            [...new Set([...(row?.threadMessageIds ?? []), ...unread])],
            { action: "set_flags", seen: true },
          );
        }
      };
      if (markRead === "immediately") mark();
      else {
        readTimer.current = setTimeout(() => {
          // 待っている間に別のメールへ移っていたら、既読にしない。
          if (session.current === current) mark();
        }, markReadDelay * 1000);
      }
    };

    // 控え (前に取得した内容、端末の保存先) があれば、サーバーの応答を待たずにまず表示する。
    const memo = peekThread(messageId, mailboxId);
    const fresh = !refreshed && isFresh(memo);
    if (memo) apply(memo.value, fresh);
    if (fresh) return () => controller.abort();
    if (!memo && !refreshed) {
      void loadSavedThread(messageId, mailboxId, summaryRef.current).then(
        (saved) => {
          if (saved && !settled && !controller.signal.aborted)
            apply(saved, false);
        },
      );
    }
    // 会話の取得と並行して、開くことになる本文も取りに行く (会話が届いてから頼むと、往復が 2 回になる)。
    if (!refreshed && summaryRef.current) {
      warmConversation(summaryRef.current);
    }
    getThread(messageId, mailboxId, controller.signal)
      .then((all) => {
        settled = true;
        apply(all, true);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          onMissing();
          return;
        }
        // 再取得の失敗では、表示中の内容を消さない。
        setState((current) =>
          current.status === "ready" ? current : { status: "error" },
        );
      });
    return () => controller.abort();
  }, [messageId, single, viewKey, refreshKey, onMissing]);

  const thread = state.status === "ready" ? state.thread : null;
  /** 返信・転送の元にするメッセージ (会話の最新)。 */
  const replyTargetId = thread?.at(-1)?.id ?? null;
  const onComposeRef = useRef(onCompose);
  onComposeRef.current = onCompose;
  /** 返信・転送の元にするメッセージの本文。未取得 (本文を閉じている) なら取得する。 */
  const loadReplyTarget = async (): Promise<MessageDetail | null> => {
    if (!replyTargetId) return null;
    return (
      details.current.get(replyTargetId) ??
      // 取得できなければ始めない。もう一度押せばやり直せる。
      (await getMessage(replyTargetId).catch(() => null))
    );
  };
  const compose = (mode: ReplyMode, text?: string) => {
    void loadReplyTarget().then((message) => {
      if (message) onComposeRef.current(mode, message, text);
    });
  };
  const quickReply = async (text: string) => {
    const message = await loadReplyTarget();
    return message ? onQuickReply(message, text) : false;
  };
  const composeRef = useRef(compose);
  composeRef.current = compose;

  // ショートカットキーからの返信・転送。会話を読み込み終えているときだけ始める。
  const handledCompose = useRef(composeRequest?.count ?? 0);
  useEffect(() => {
    if (!composeRequest || composeRequest.count === handledCompose.current) {
      return;
    }
    handledCompose.current = composeRequest.count;
    if (replyTargetId) composeRef.current(composeRequest.mode);
  }, [composeRequest, replyTargetId]);

  /** 既読やスターの操作を、表示中の内容にもすぐ反映する (1 通だけの表示は、一覧の行の値を使えないため)。 */
  const act: Props["onAction"] = (ids, input, options) => {
    if (input.action === "set_flags") {
      const targets = new Set(ids);
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              thread: current.thread.map((message) =>
                targets.has(message.id)
                  ? {
                      ...message,
                      seen: input.seen ?? message.seen,
                      flagged: input.flagged ?? message.flagged,
                    }
                  : message,
              ),
            }
          : current,
      );
    }
    onAction(ids, input, options);
  };
  // 一覧の行は会話全体を表すので、1 通だけの表示では使わない。
  const row = single ? null : summary;
  const profile: ProfileActions = {
    onSearch: onSearchAddress,
    onCompose: (address) => {
      const accountId = thread?.[0]?.accountId;
      if (accountId) onComposeTo(address, accountId);
    },
    onSignature: (address) => {
      const accountId = thread?.[0]?.accountId;
      if (accountId) onContactSignature(address, accountId);
    },
    hasSignature: (address) =>
      findContactRule(signatureRules, address.address) !== null,
  };
  const handleDetail = (message: MessageDetail) => {
    details.current.set(message.id, message);
  };
  const first = thread?.[0];
  const last = thread?.at(-1);
  // 会話のキー。端末に保存してあった古い内容には無いので、一覧の行からも探す。
  const threadKey = first?.threadKey ?? summary?.threadKey ?? null;
  /** 会話のアカウントと件名。読み込み中は一覧の行の値を使う。 */
  const conversation = first ?? row ?? null;

  // 見出しの下に出す、メールのある場所 (アカウントとフォルダ)。
  const account = accounts.find((item) => item.id === first?.accountId);
  // 1 通だけの表示では、そのメールのあるフォルダ (一覧のフォルダにあれば、そちら)。
  const mailboxId =
    row?.mailboxId ??
    (summary && last?.mailboxIds.includes(summary.mailboxId)
      ? summary.mailboxId
      : (last?.mailboxIds[0] ?? null));
  const mailbox = mailboxes.find((item) => item.id === mailboxId);
  const accountMailboxes = mailboxes.filter(
    (item) => item.accountId === first?.accountId,
  );
  const place = [
    account ? account.displayName || account.email : null,
    mailbox ? mailboxLabel(mailbox) : null,
    thread && thread.length > 1 ? `${thread.length} 通のやり取り` : null,
  ].filter(Boolean);
  const meta = place.length > 0 && (
    <p className="flex items-center gap-2 text-muted-foreground text-xs">
      {account && <AccountListMark accounts={accounts} account={account} />}
      <span className="min-w-0 truncate">{place.join(" · ")}</span>
    </p>
  );
  // 1 通だけを表示しているときに出す、会話の全体への入り口。
  const threadLink = single &&
    onShowThread &&
    state.status === "ready" &&
    state.size > 1 && (
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-muted-foreground text-xs sm:px-6">
        <MessagesSquareIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {state.size} 通のやり取りのうちの 1 通を表示しています。
        </span>
        <Button variant="link" size="xs" onClick={onShowThread}>
          会話の全体を表示
        </Button>
      </div>
    );
  // 返信の宛先になる相手。自分が送ったメールへの返信は、元の宛先へ送る。
  const own = new Set(accounts.map((item) => item.email.toLowerCase()));
  const sender = last?.from[0];
  const replyTo =
    sender && own.has(sender.address.toLowerCase())
      ? (last?.to[0] ?? sender)
      : sender;
  // 返信に使うアカウント。受信専用のアカウントに届いたメールは、送信できるほかのアカウントから返す。
  // 送信できるアカウントが無ければ、返信欄は出さない (作成画面の「返信」で理由を知らせる)。
  const replyAccount = last ? senderAccount(accounts, last.accountId) : null;
  const quickReplyBox = preferences.quickReply &&
    last &&
    replyTo &&
    replyAccount &&
    !last.draft && (
      <div className="shrink-0 px-4 pt-2 pb-4 sm:px-6">
        <QuickReply
          // 別のメールを開いたり、新しいメールが届いたりしたら、宛先が変わるので作り直す。
          key={last.id}
          recipient={addressLabel(replyTo)}
          from={
            replyAccount.id === last.accountId ||
            !accounts.some((item) => item.id === last.accountId)
              ? undefined
              : replyAccount.displayName
                ? `${replyAccount.displayName} <${replyAccount.email}>`
                : replyAccount.email
          }
          onSend={quickReply}
          onExpand={(text) => compose("reply", text)}
        />
      </div>
    );

  // 開いているメールの左右のスワイプ。設定で、前後のメールへ移るか、一覧の行と同じ操作にする。
  const toolbarMailboxId = single ? mailboxId : (row?.mailboxId ?? null);
  const targetIds = row?.threadMessageIds ?? [messageId];
  const actionSide = (
    action: SwipeSettings["left"],
  ): MessageSwipeSide | null => {
    if (!thread || !first) return null;
    const outcome = resolveSwipe(
      action,
      {
        seen: row?.seen ?? thread.every((message) => message.seen),
        flagged: row?.flagged ?? thread.some((message) => message.flagged),
        mailboxId: toolbarMailboxId ?? "",
      },
      accountMailboxes,
    );
    if (!outcome) return null;
    const { input } = outcome;
    return {
      label: outcome.label,
      ...swipeLooks[outcome.kind],
      exits: outcome.removes,
      run: () => {
        if (!input) {
          setSwipeMove((count) => count + 1);
          return;
        }
        // スターは、付けるときは 1 通に、外すときは対象のすべてから外す (ツールバーと同じ)。
        const ids =
          outcome.kind === "star" ? [row?.id ?? messageId] : targetIds;
        if (!outcome.removes) {
          act(ids, input);
          return;
        }
        // 表示中のメールは一覧から無くなるので、続けて読めるよう隣のメールを開く。
        // 完全な削除は確認を出すので、削除を確定してから移る。
        act(ids, input, {
          onDone: () => {
            if (canStep.next) onStep(1);
            else if (canStep.previous) onStep(-1);
            else onBack();
          },
        });
      },
    };
  };
  const swipeSides: {
    left: MessageSwipeSide | null;
    right: MessageSwipeSide | null;
  } =
    preferences.messageSwipe === "navigate"
      ? {
          left: canStep.next
            ? {
                label: "次のメール",
                icon: ChevronRightIcon,
                color: "bg-muted text-foreground",
                exits: true,
                run: () => onStep(1),
              }
            : null,
          right: canStep.previous
            ? {
                label: "前のメール",
                icon: ChevronLeftIcon,
                color: "bg-muted text-foreground",
                exits: true,
                run: () => onStep(-1),
              }
            : null,
        }
      : preferences.messageSwipe === "actions"
        ? {
            left: actionSide(swipeSettings.left),
            right: actionSide(swipeSettings.right),
          }
        : { left: null, right: null };

  // メールだけを出すウィンドウでは、件名をタイトルバーに出す (「件名 ― Orbit Mail」)。
  const windowName = first ? first.subject || "(件名なし)" : null;
  useEffect(() => {
    if (standalone && windowName) setTitleBarTitle(windowName);
  }, [standalone, windowName]);
  useEffect(() => {
    if (!standalone) return;
    return () => setTitleBarTitle(null);
  }, [standalone]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 一覧の見出しと高さを揃えた、操作用のツールバー。 */}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-2 sm:px-4">
        {!standalone && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="一覧に戻る"
            onClick={onBack}
            className="lg:hidden"
          >
            <ArrowLeftIcon />
          </Button>
        )}
        {/* 読み込み中も一覧の行の値で出しておく (別のメールへ移るたびに作り直さない)。 */}
        {((thread && first) || row) && (
          <MessageToolbar
            accountId={first?.accountId ?? row?.accountId ?? ""}
            // 会話のうち、表示中のフォルダにある分をまとめて操作する。
            targetIds={targetIds}
            starId={row?.id ?? messageId}
            mailboxId={toolbarMailboxId}
            seen={row?.seen ?? thread?.every((message) => message.seen) ?? true}
            flagged={
              row?.flagged ??
              thread?.some((message) => message.flagged) ??
              false
            }
            moveRequest={moveRequest + swipeMove}
            onAction={act}
            onCompose={compose}
            onFind={openFind}
            signatureSet={
              threadKey !== null &&
              conversation !== null &&
              findThreadRule(
                signatureRules,
                conversation.accountId,
                threadKey,
              ) !== null
            }
            onSignature={
              threadKey === null || conversation === null
                ? null
                : () =>
                    onThreadSignature({
                      accountId: conversation.accountId,
                      threadKey,
                      subject: conversation.subject,
                    })
            }
          />
        )}
        {toolbarEnd}
      </div>
      {find && (
        <MessageFindBar
          rootRef={contentRef}
          initialText={find.text}
          request={find.request}
          onClose={() => setFind(null)}
        />
      )}
      {/* デスクトップ版で文字を選べる範囲 (それ以外の画面の文字は選べない。globals.css)。 */}
      <div
        ref={contentRef}
        className="flex min-h-0 flex-1 flex-col"
        data-selectable
      >
        <MessageSwipe
          left={swipeSides.left}
          right={swipeSides.right}
          wheel={preferences.trackpadSwipe}
          resetKey={viewKey}
        >
          {state.status === "loading" ? (
            <MessageSkeleton />
          ) : state.status === "error" || !first ? (
            <p
              role="alert"
              className="p-4 text-muted-foreground text-sm sm:p-6"
            >
              メールを読み込めませんでした。
            </p>
          ) : state.thread.length === 1 ? (
            <>
              {threadLink}
              <LoadedMessage
                // 別のメールを開いたら、スクロール位置を先頭に戻す。
                key={first.id}
                id={first.id}
                refreshKey={refreshKey}
                meta={meta}
                mailbox={mailbox}
                profile={profile}
                onDetail={handleDetail}
              />
              {quickReplyBox}
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <header
                data-find-scope=""
                className="flex flex-col gap-2 border-b p-4 sm:p-6"
              >
                <h2 className="font-semibold text-xl leading-snug">
                  {first.subject || "(件名なし)"}
                </h2>
                {meta}
              </header>
              <ol>
                {state.thread.map((message) => (
                  <ThreadItem
                    key={message.id}
                    message={message}
                    expanded={expanded.has(message.id)}
                    refreshKey={refreshKey}
                    profile={profile}
                    onToggle={() =>
                      setExpanded((ids) => {
                        const next = new Set(ids);
                        if (!next.delete(message.id)) next.add(message.id);
                        return next;
                      })
                    }
                    onDetail={handleDetail}
                  />
                ))}
              </ol>
              {quickReplyBox}
            </div>
          )}
        </MessageSwipe>
      </div>
    </div>
  );
}

/**
 * メールを開いた直後の表示。控えてある会話があれば、それを表示する
 * (本文を開いておくメッセージの決め方は、取得した後と同じ: 未読のものと最新のもの)。
 */
function initialView(
  messageId: string,
  mailboxId: string | null,
  single: boolean,
): { state: State; expanded: ReadonlySet<string> } {
  const memo = peekThread(messageId, mailboxId);
  const thread = memo
    ? single
      ? memo.value.filter((message) => message.id === messageId)
      : memo.value
    : [];
  if (!memo || thread.length === 0) {
    return { state: { status: "loading" }, expanded: new Set() };
  }
  const last = thread.at(-1);
  return {
    state: { status: "ready", thread, size: memo.value.length },
    expanded: new Set(
      thread
        .filter((message) => !message.seen || message.id === last?.id)
        .map((message) => message.id),
    ),
  };
}

/** 会話の表示に使う値が同じか (同じなら、取得し直しても描き直さない)。 */
function sameThread(a: ThreadMessage[], b: ThreadMessage[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** 本文の内容が同じか。 */
function sameDetail(a: MessageDetail, b: MessageDetail): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function MessageSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6" aria-busy="true">
      <output className="sr-only">メールを読み込み中</output>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** メッセージ 1 通の本文を取得して表示する。 */
function LoadedMessage({
  id,
  refreshKey,
  inThread = false,
  details = false,
  meta,
  mailbox,
  profile,
  onDetail,
}: {
  id: string;
  refreshKey: number;
  /** 件名の下に出す、メールのある場所。 */
  meta?: React.ReactNode;
  /** メールのあるフォルダ。折りたたんだ見出しのアイコンに使う。 */
  mailbox?: MailboxSummary;
  profile?: ProfileActions;
  /** 会話の中の 1 通として表示する (件名と宛先の見出しは会話側で出す)。 */
  inThread?: boolean;
  /** 会話の中の 1 通で、宛先や日時などの詳細の表を本文の上に出す。 */
  details?: boolean;
  onDetail: (message: MessageDetail) => void;
}) {
  // 控えてある本文があれば、最初からそれを表示する。
  const [message, setMessage] = useState<MessageDetail | null>(
    () => peekMessage(id)?.value ?? null,
  );
  const [shownId, setShownId] = useState(id);
  if (shownId !== id) {
    setShownId(id);
    setMessage(peekMessage(id)?.value ?? null);
  }
  const [failed, setFailed] = useState(false);
  const onDetailRef = useRef(onDetail);
  onDetailRef.current = onDetail;
  const fetchedRefreshKey = useRef(refreshKey);

  useEffect(() => {
    const controller = new AbortController();
    const refreshed = fetchedRefreshKey.current !== refreshKey;
    fetchedRefreshKey.current = refreshKey;
    let settled = false;
    const show = (loaded: MessageDetail) => {
      // 内容が同じなら置き換えない (本文の枠を描き直さない)。
      setMessage((current) =>
        current && sameDetail(current, loaded) ? current : loaded,
      );
      setFailed(false);
      onDetailRef.current(loaded);
    };
    const memo = peekMessage(id);
    if (memo) onDetailRef.current(memo.value);
    // 本文は後から変わらないので、取得済みの控えがあれば取り直さない (同期で変わったときを除く)。
    if (memo && !refreshed && (isFresh(memo) || memo.value.bodyFetchedAt)) {
      if (!isFresh(memo)) {
        // 既読やスターなどは変わることがあるので、表示した後で確かめる。
        void getMessage(id, controller.signal).then(show, () => {});
      }
      return () => controller.abort();
    }
    if (!memo && !refreshed) {
      void loadSavedMessage(id).then((saved) => {
        if (saved && !settled && !controller.signal.aborted) show(saved);
      });
    }
    getMessage(id, controller.signal)
      .then((loaded) => {
        settled = true;
        show(loaded);
      })
      .catch(() => {
        // 再取得の失敗では、表示中の本文を消さない。
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [id, refreshKey]);

  if (message) {
    return (
      <MessageContent
        message={message}
        inThread={inThread}
        details={details}
        meta={meta}
        mailbox={mailbox}
        profile={profile}
      />
    );
  }
  if (failed) {
    return (
      <p role="alert" className="p-4 text-muted-foreground text-sm sm:p-6">
        メールを読み込めませんでした。
      </p>
    );
  }
  return <MessageSkeleton />;
}

/** 会話の中の 1 通。見出しを押すと本文を開閉する。 */
function ThreadItem({
  message,
  expanded,
  refreshKey,
  profile,
  onToggle,
  onDetail,
}: {
  message: ThreadMessage;
  expanded: boolean;
  refreshKey: number;
  profile: ProfileActions;
  onToggle: () => void;
  onDetail: (message: MessageDetail) => void;
}) {
  const preferences = usePreferences();
  const dateStyle = useDateStyle();
  // 詳細 (宛先、Cc、返信先、日時などの表) を出しているか。
  // 見出しを広げて使う設定なら、最初から出す。メールごとに切り替えられる。
  const [details, setDetails] = useState(
    preferences.messageHeader === "expanded",
  );
  const sender = message.from[0];
  const name = addressLabel(sender);
  const recipients = [...message.to, ...message.cc];
  return (
    <li className="border-b last:border-b-0">
      {/* 行を押すと本文を開閉する。詳細のボタンは、行のボタンの外に並べる。 */}
      <div className="flex items-center transition-colors focus-within:bg-muted/40 hover:bg-muted/60">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4 text-left outline-none focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:pl-6"
        >
          <SenderAvatar
            address={sender}
            check={message.senderCheck}
            enabled={preferences.senderIconInMessage}
            className="size-9 text-sm"
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-sm",
                (expanded || !message.seen) && "font-medium",
              )}
            >
              {!message.seen && <span className="sr-only">未読 </span>}
              {name}
              {expanded && sender?.name && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  &lt;{sender.address}&gt;
                </span>
              )}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {expanded
                ? `${
                    recipients.length > 0
                      ? `宛先: ${recipients.map(addressLabel).join("、")} · `
                      : ""
                  }${formatFullDate(message.receivedAt, dateStyle)}`
                : message.snippet}
            </span>
          </span>
          <SenderWarningMark check={message.senderCheck} />
          {message.flagged && (
            <StarIcon
              className="size-3.5 shrink-0 fill-amber-400 text-amber-500"
              aria-label="スター付き"
            />
          )}
          {!expanded && message.hasAttachments && (
            <PaperclipIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-label="添付ファイルあり"
            />
          )}
          {!expanded && (
            <ExactTime
              value={message.receivedAt}
              className="shrink-0 text-muted-foreground text-xs tabular-nums"
            >
              {formatListDate(message.receivedAt, new Date(), dateStyle)}
            </ExactTime>
          )}
        </button>
        {expanded && (
          <Hint label={details ? "詳細を隠す" : "詳細を表示"}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={details}
              aria-label={details ? "詳細を隠す" : "詳細を表示"}
              onClick={() => setDetails((shown) => !shown)}
              className={cn(
                "shrink-0 text-muted-foreground",
                details && "bg-muted text-foreground",
              )}
            >
              <InfoIcon />
            </Button>
          </Hint>
        )}
        {/* 矢印を押しても開閉できる。キーボードと読み上げでは、行のボタンを使う。 */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={onToggle}
          className="flex shrink-0 self-stretch items-center pr-4 pl-2 outline-none sm:pr-6"
        >
          <ChevronDownIcon
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      </div>
      {expanded && (
        <LoadedMessage
          id={message.id}
          refreshKey={refreshKey}
          inThread
          details={details}
          profile={profile}
          onDetail={onDetail}
        />
      )}
    </li>
  );
}

/**
 * 返信、全員に返信、転送、既読、スター、アーカイブ、移動、迷惑メール、削除のボタン。
 * アイコンだけを並べ、名前とショートカットキーはカーソルを合わせたときに出す。
 */
function MessageToolbar({
  accountId,
  targetIds,
  starId,
  mailboxId,
  seen,
  flagged,
  moveRequest,
  onAction,
  onCompose,
  onFind,
  signatureSet,
  onSignature,
}: {
  /** このメールの中の検索を開く。 */
  onFind: () => void;
  /** この会話に署名を決めてあるか。 */
  signatureSet: boolean;
  /** この会話の署名を決める画面を開く。会話のキーが分からなければ null (ボタンを出さない)。 */
  onSignature: (() => void) | null;
  accountId: string;
  /** 既読、アーカイブ、削除、移動の対象。 */
  targetIds: string[];
  /** スターを付けるメッセージ (外すときは対象のすべてから外す)。 */
  starId: string;
  /** 表示中のフォルダ。分からなければ null。 */
  mailboxId: string | null;
  seen: boolean;
  flagged: boolean;
  moveRequest: number;
  onAction: Props["onAction"];
  onCompose: (mode: ReplyMode) => void;
}) {
  const mailboxes = useMailboxes(accountId);
  const { archive, trash, inTrash, junk, notJunk, destinations } =
    actionTargets(mailboxes, mailboxId);
  // 移動先のメニュー。ショートカットキー (V) からも開く。
  const [moveOpen, setMoveOpen] = useState(false);
  const handledMoveRequest = useRef(moveRequest);
  useEffect(() => {
    if (moveRequest === handledMoveRequest.current) return;
    handledMoveRequest.current = moveRequest;
    setMoveOpen(true);
  }, [moveRequest]);
  const act = (input: MessageActionInput, options?: ActionOptions) =>
    onAction(targetIds, input, options);

  return (
    <TooltipProvider>
      <div
        role="toolbar"
        aria-label="メールの操作"
        // タッチ操作ではボタンの押せる範囲 (after) がボタンの外へ 2px 広がる。その分の余白を
        // 持たせないと、はみ出しとして扱われてスクロールバーが出る。
        className="-m-0.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-0.5 pointer-coarse:[scrollbar-width:none]"
      >
        {/* 狭い画面では、返信・転送・移動は「その他」にまとめる。 */}
        <ToolbarButton
          label="返信"
          shortcut={shortcutLabels.reply}
          onClick={() => onCompose("reply")}
          className="max-sm:hidden"
        >
          <ReplyIcon />
        </ToolbarButton>
        <ToolbarButton
          label="全員に返信"
          shortcut={shortcutLabels.replyAll}
          onClick={() => onCompose("replyAll")}
          className="max-sm:hidden"
        >
          <ReplyAllIcon />
        </ToolbarButton>
        <ToolbarButton
          label="転送"
          shortcut={shortcutLabels.forward}
          onClick={() => onCompose("forward")}
          className="max-sm:hidden"
        >
          <ForwardIcon />
        </ToolbarButton>
        {onSignature && (
          <ToolbarButton
            label={
              signatureSet ? "この会話の署名 (設定済み)" : "この会話の署名"
            }
            aria-pressed={signatureSet}
            onClick={onSignature}
            className="max-sm:hidden"
          >
            <SignatureIcon
              className={signatureSet ? "text-primary" : undefined}
            />
          </ToolbarButton>
        )}
        <ToolbarSeparator className="max-sm:hidden" />
        <span className="flex-1 sm:hidden" aria-hidden="true" />
        <ToolbarButton
          label={seen ? "未読にする" : "既読にする"}
          shortcut={seen ? shortcutLabels.markUnread : shortcutLabels.markRead}
          onClick={() => act({ action: "set_flags", seen: !seen })}
        >
          {seen ? <MailIcon /> : <MailOpenIcon />}
        </ToolbarButton>
        <ToolbarButton
          label={flagged ? "スターを外す" : "スターを付ける"}
          shortcut={shortcutLabels.toggleStar}
          aria-pressed={flagged}
          onClick={() =>
            flagged
              ? act({ action: "set_flags", flagged: false })
              : onAction([starId], { action: "set_flags", flagged: true })
          }
        >
          <StarIcon
            className={flagged ? "fill-amber-400 text-amber-500" : undefined}
          />
        </ToolbarButton>
        {archive && (
          <ToolbarButton
            label="アーカイブ"
            shortcut={shortcutLabels.archive}
            onClick={() => act({ action: "move", mailboxId: archive.id })}
          >
            <ArchiveIcon />
          </ToolbarButton>
        )}
        {destinations.length > 0 && (
          <DropdownMenu open={moveOpen} onOpenChange={setMoveOpen}>
            <ToolbarTooltip label="移動" shortcut={shortcutLabels.move}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="移動"
                    className="max-sm:hidden"
                  />
                }
              >
                <FolderInputIcon />
              </DropdownMenuTrigger>
            </ToolbarTooltip>
            <DropdownMenuContent align="start" className="w-56">
              {destinations.map((entry) => (
                <DropdownMenuItem
                  key={entry.mailbox.id}
                  onClick={() =>
                    act({ action: "move", mailboxId: entry.mailbox.id })
                  }
                >
                  <MoveTarget entry={entry} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <ToolbarTooltip label="その他の操作">
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="その他の操作"
                  // スマホ幅では、迷惑メールと削除の後ろ (右端) に置く。
                  className="order-last sm:hidden"
                />
              }
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
          </ToolbarTooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={() => onCompose("reply")}>
              <ReplyIcon />
              返信
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCompose("replyAll")}>
              <ReplyAllIcon />
              全員に返信
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCompose("forward")}>
              <ForwardIcon />
              転送
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onFind}>
              <TextSearchIcon />
              このメールの中を検索
            </DropdownMenuItem>
            {onSignature && (
              <DropdownMenuItem onClick={onSignature}>
                <SignatureIcon />
                {signatureSet ? "この会話の署名を変更" : "この会話の署名を設定"}
              </DropdownMenuItem>
            )}
            {destinations.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>移動</DropdownMenuLabel>
                  {destinations.map((entry) => (
                    <DropdownMenuItem
                      key={entry.mailbox.id}
                      onClick={() =>
                        act({ action: "move", mailboxId: entry.mailbox.id })
                      }
                    >
                      <MoveTarget entry={entry} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 迷惑メールと削除は、押し間違えにくいよう最後にまとめる。 */}
        {(junk || notJunk || trash || inTrash) && <ToolbarSeparator />}
        {junk && (
          <ToolbarButton
            label="迷惑メールにする"
            shortcut={shortcutLabels.junk}
            onClick={() => act({ action: "move", mailboxId: junk.id })}
          >
            <OctagonAlertIcon />
          </ToolbarButton>
        )}
        {notJunk && (
          <ToolbarButton
            label="迷惑メールから戻す"
            shortcut={shortcutLabels.junk}
            onClick={() => act({ action: "move", mailboxId: notJunk.id })}
          >
            <MailCheckIcon />
          </ToolbarButton>
        )}
        {(trash || inTrash) && (
          <ToolbarButton
            label={inTrash ? "完全に削除" : "削除"}
            shortcut={shortcutLabels.delete}
            onClick={(event) =>
              act(
                inTrash || !trash
                  ? { action: "delete" }
                  : { action: "move", mailboxId: trash.id },
                // 完全な削除は、Shift を押しながらなら確認を出さない。
                { skipConfirm: skipsDeleteConfirm(event) },
              )
            }
          >
            <Trash2Icon />
          </ToolbarButton>
        )}
      </div>
    </TooltipProvider>
  );
}

/** 本文に埋め込む画像 1 枚の上限。これより大きいものは埋め込まない。 */
const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;

function toDataUrl(blob: Blob, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([blob], { type }));
  });
}

/**
 * 本文に埋め込まれた画像 (cid: で参照される添付ファイル) を取得する。
 * 本文の iframe はこのアプリとは別の扱い (sandbox) で、API を呼べないので、
 * こちらで取得して data: の URL にしてから本文に差し込む。
 * 戻り値は Content-ID から URL への対応。取得できた分から順に増える。
 */
function useEmbeddedImages(
  messageId: string,
  embedded: Attachment[],
): ReadonlyMap<string, string> {
  const [state, setState] = useState<{
    key: string;
    urls: ReadonlyMap<string, string>;
  }>({ key: "", urls: new Map() });
  // 同期で同じメールを取得し直しても、画像は取得し直さない。
  const key = `${messageId}:${embedded.map((file) => file.id).join(",")}`;
  const embeddedRef = useRef(embedded);
  embeddedRef.current = embedded;

  useEffect(() => {
    const controller = new AbortController();
    for (const file of embeddedRef.current) {
      if (file.contentId === null || file.size > MAX_EMBEDDED_IMAGE_BYTES) {
        continue;
      }
      const contentId = normalizeContentId(file.contentId);
      fetchAttachment(messageId, file.id, controller.signal)
        .then((blob) => toDataUrl(blob, file.contentType.toLowerCase()))
        .then((url) => {
          if (controller.signal.aborted) return;
          setState((current) => ({
            key,
            urls: new Map(current.key === key ? current.urls : []).set(
              contentId,
              url,
            ),
          }));
        })
        // 取得できなかった画像は、表示されないままにする。
        .catch(() => {});
    }
    return () => controller.abort();
  }, [messageId, key]);

  return state.key === key ? state.urls : EMPTY_URLS;
}

const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

/**
 * 本文用の iframe。中身の高さに合わせて伸ばし、スクロールは外側 (メール表示や会話全体) で行う。
 * fill を付けると、本文が短くても残りの高さいっぱいまで広げる (1 通だけの表示用)。
 * 高さを測るために allow-same-origin を付けるが、allow-scripts は付けないので、
 * 本文の中のスクリプトは動かず、このアプリのデータにも触れない。
 */
/** 横に長い本文を枠に収めるときの、いちばん小さい倍率。 */
const MIN_BODY_ZOOM = 0.5;

function BodyFrame({
  srcDoc,
  fill,
  embeddedUrls,
}: {
  srcDoc: string;
  fill: boolean;
  /** 本文に埋め込む画像 (cid:) の URL。後から届いた分は、読み込み直さずに差し込む。 */
  embeddedUrls: ReadonlyMap<string, string>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(120);
  // 本文の上でのスワイプ (前後のメールへ移るなど) を、iframe の中でも受け取る。
  const bindSwipe = useContext(SwipeSurfaceContext);
  const unbindSwipe = useRef<(() => void) | null>(null);
  /** 大きさを合わせ終えた文書と、その文書の大きさを合わせ直す処理。 */
  const measured = useRef<Document | null>(null);
  /** リンクのクリックを受け取るようにした文書 (読み込み直すと別の文書になる)。 */
  const linked = useRef<Document | null>(null);
  const refit = useRef<(() => void) | null>(null);
  const urls = useRef(embeddedUrls);
  urls.current = embeddedUrls;
  useEffect(
    () => () => {
      observer.current?.disconnect();
      unbindSwipe.current?.();
    },
    [],
  );

  const measure = (doc: Document) => {
    const element = frame.current;
    const view = doc.defaultView;
    const body = doc.body;
    if (!element || !view || !body) return;
    measured.current = doc;
    patchCidReferences(doc, urls.current);
    unbindSwipe.current?.();
    unbindSwipe.current = bindSwipe?.(doc) ?? null;
    const root = doc.documentElement;
    /**
     * body の外にはみ出した中身 (html 側の余白、位置を固定した要素など) を収めるのに必要だった高さ。
     * これを足さないと、枠の中にもスクロールが要り、外側のバーと二重になる。
     * 枠を広げるとはみ出しは測れなくなるので、幅が変わるまで覚えておく。
     */
    let floor = 0;
    /**
     * 枠を伸ばしても同じだけ足りない状態が続いた回数と、その足りなかった高さ。
     * 枠の高さに連動して伸び続ける本文 (100vh を使った指定など) を見分けるために数える。
     */
    let chased = 0;
    let lastShort = 0;
    let width = view.innerWidth;
    /**
     * 枠より横に長い本文 (幅を固定したメールなど) は、枠の幅に収まるよう全体を縮める。
     * 縮めすぎると読めないので MIN_BODY_ZOOM までにとどめ、残りは横にスクロールする。
     * 縮める前の幅を測り直すのは、幅が変わったとき、中身の幅が変わったとき、
     * 画像を読み込んだときだけにする (測るたびに大きさが変わり、大きさの監視が回り続けるのを避ける)。
     */
    /** 最後に倍率を決めた直後の、中身の幅。変わっていたら倍率を決め直す。 */
    let fitted = 0;
    const fit = () => {
      const before = root.style.zoom;
      root.style.zoom = "";
      const natural = root.scrollWidth;
      const available = root.clientWidth;
      // はみ出した幅には右側の余白 (body の margin) が含まれないので、縮めるときは足して測る。
      // 足さないと、縮めた本文の右端が枠の端に貼り付く。
      const gutter = Number.parseFloat(view.getComputedStyle(body).marginRight);
      const wanted = natural + (Number.isFinite(gutter) ? gutter : 0);
      const zoom =
        natural > available + 1 && available > 0
          ? Math.max(MIN_BODY_ZOOM, available / wanted)
          : 1;
      const next = zoom < 1 ? String(Math.floor(zoom * 1000) / 1000) : "";
      root.style.zoom = next;
      fitted = root.scrollWidth;
      if (next !== before) {
        floor = 0;
        chased = 0;
        lastShort = 0;
      }
    };
    const update = () => {
      if (view.innerWidth !== width) {
        width = view.innerWidth;
        floor = 0;
        chased = 0;
        lastShort = 0;
        root.style.overflowY = "";
        fit();
      } else if (root.scrollWidth !== fitted) {
        fit();
      }
      if (chased >= 3) return;
      const margin = Number.parseFloat(
        view.getComputedStyle(body).marginBottom,
      );
      // 本文 (body) の下端。幅が変わって本文が短くなったときに、縮められるようにここを基準にする。
      const bottom = Math.ceil(
        body.getBoundingClientRect().bottom +
          view.scrollY +
          (Number.isFinite(margin) ? margin : 0),
      );
      if (root.scrollHeight > root.clientHeight) floor = root.scrollHeight;
      const content = Math.max(bottom, floor);
      const short = content - root.clientHeight;
      chased = short > 0 && Math.abs(short - lastShort) < 1 ? chased + 1 : 0;
      lastShort = short;
      if (chased >= 3) {
        // 追いかけるのをやめて、枠の中でスクロールできるようにする。
        root.style.overflowY = "auto";
        return;
      }
      // 横に長い本文では、横のスクロールバーの分だけ見える高さが減る。
      const next = content + (view.innerHeight - root.clientHeight);
      // 描画の前に高さを合わせる (state の反映を待つと、古い高さのまま 1 回描かれる)。
      if (Math.abs(Number.parseFloat(element.style.height) - next) >= 1) {
        element.style.height = `${next}px`;
      }
      setHeight((current) => (Math.abs(current - next) < 1 ? current : next));
    };
    refit.current = () => {
      fit();
      update();
    };
    fit();
    update();
    element.style.visibility = "";
    // 画像の読み込みや幅の変化で高さが変わったら、合わせ直す。
    observer.current?.disconnect();
    observer.current = new ResizeObserver(update);
    observer.current.observe(body);
    observer.current.observe(doc.documentElement);
    // body の大きさが変わらない (高さを固定している) 本文でも、画像を読み込んだら測り直す。
    doc.addEventListener(
      "load",
      () => {
        fit();
        update();
      },
      true,
    );
  };
  const measureLatest = useRef(measure);
  measureLatest.current = measure;

  /**
   * 本文は、倍率と高さを決め終えるまで見せない。
   * 読み込みの完了 (load) は画像を待つので、そこで初めて縮めると、
   * 元の大きさで一度表示されてから縮んで見える。文書を読み終えた時点で、描画の前に決める。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 本文が変わるたびに、新しい文書を待ち直す。
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    element.style.visibility = "hidden";
    let request = 0;
    const tick = () => {
      const doc = element.contentDocument;
      if (
        doc &&
        doc !== measured.current &&
        doc.URL === "about:srcdoc" &&
        doc.body &&
        doc.readyState !== "loading"
      ) {
        measureLatest.current(doc);
        return;
      }
      request = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(request);
  }, [srcDoc]);

  // 後から取得できた埋め込み画像は、表示中の文書に差し込む (読み込み直すと、本文が一度消える)。
  useEffect(() => {
    const doc = measured.current;
    if (doc && patchCidReferences(doc, embeddedUrls)) refit.current?.();
  }, [embeddedUrls]);

  const onLoad = () => {
    const element = frame.current;
    const doc = element?.contentDocument;
    if (!element || !doc) return;
    // アプリの中では、本文のリンクを既定のブラウザーで開く (枠の中からは新しいウィンドウを開けない)。
    if (handlesExternalLinks() && linked.current !== doc) {
      linked.current = doc;
      interceptExternalLinks(doc);
      // デスクトップ版では、本文の中の右クリックでも WebView の標準のメニューを出さない。
      if (isDesktopApp()) {
        attachTextMenu(
          doc,
          (node) => externalLinkOf(node, window.location.origin),
          element,
        );
      }
    }
    if (doc === measured.current) refit.current?.();
    else measure(doc);
    element.style.visibility = "";
  };

  return (
    <iframe
      ref={frame}
      title="メール本文"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      style={{ height }}
      className={cn(
        "w-full shrink-0 border-0 bg-white",
        // 会話の中では、本文の余白 (16px) と合わせて、見出しや文字だけの本文と左端を揃える。
        fill ? "grow" : "sm:px-2",
      )}
    />
  );
}

function MessageContent({
  message,
  inThread = false,
  details = false,
  meta,
  mailbox,
  profile,
}: {
  message: MessageDetail;
  /** 会話の中の 1 通で、詳細の表を本文の上に出す。 */
  details?: boolean;
  meta?: React.ReactNode;
  mailbox?: MailboxSummary;
  /** 差出人や宛先のプロフィールカードから始める操作。 */
  profile?: ProfileActions;
  /** 会話の中の 1 通として表示する (件名と差出人は会話側の見出しに出ている)。 */
  inThread?: boolean;
}) {
  /** 外部の画像を表示すると決めたメールの ID。別のメールを開くと元 (非表示) に戻る。 */
  const [imagesShownFor, setImagesShownFor] = useState<string | null>(null);
  const preferences = usePreferences();
  const dateStyle = useDateStyle();
  const showImages =
    preferences.remoteImages === "always" || imagesShownFor === message.id;
  const frameStyle = bodyStyle(preferences);
  // Android アプリでは、本文に使う端末のフォントのファイルを、本文の枠の中でも読み込む。
  const faceCss = useFontFaceCss(
    [
      preferences.bodyCustomFont,
      preferences.sansFont,
      preferences.serifFont,
      preferences.monoFont,
    ].filter(Boolean),
  );
  const frameCss = faceCss + bodyExtraCss(preferences);
  const fontSrc = faceCss ? window.location.origin : "";
  const { embedded, listed } = useMemo(
    () => splitAttachments(message.bodyHtml, message.attachments),
    [message.bodyHtml, message.attachments],
  );
  const embeddedUrls = useEmbeddedImages(message.id, embedded);
  // 埋め込み画像が届くたびに本文を読み込み直すと、そのたびに本文が消えて大きさも決め直しになる。
  // 組み立てた時点で届いている分だけを入れ、後から届いた分は BodyFrame が差し込む。
  const embeddedUrlsRef = useRef(embeddedUrls);
  embeddedUrlsRef.current = embeddedUrls;
  const srcDoc = useMemo(
    () =>
      message.bodyHtml
        ? buildSrcDoc(
            replaceCidReferences(message.bodyHtml, embeddedUrlsRef.current),
            showImages,
            frameStyle,
            frameCss,
            fontSrc,
          )
        : null,
    [message.bodyHtml, showImages, frameStyle, frameCss, fontSrc],
  );
  const imagesBlocked =
    !showImages &&
    message.bodyHtml !== null &&
    hasRemoteImages(message.bodyHtml);

  const collapsed = preferences.messageHeader === "collapsed";
  const fullDate = formatFullDate(message.receivedAt, dateStyle);
  // 返信先は、差出人と違うときだけ出す (同じアドレスを指定しているメールが多い)。
  const senders = new Set(
    message.from.map((item) => item.address.toLowerCase()),
  );
  const replyToShown = message.replyTo.some(
    (item) => !senders.has(item.address.toLowerCase()),
  );
  // 代理送信 (Sender) も、差出人と違うときだけ出す。
  const senderShown = (message.sender ?? []).some(
    (item) => !senders.has(item.address.toLowerCase()),
  );
  const unsubscribe = unsubscribeLinks(message.listUnsubscribe ?? []);
  // 送信日時は、届いた日時と 1 分以上ずれているときだけ出す。
  const sentAtShown =
    message.sentAt !== null &&
    Math.abs(Date.parse(message.sentAt) - Date.parse(message.receivedAt)) >=
      60_000;
  /** 差出人、宛先、日時などの表。 */
  const detailRows = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">差出人</dt>
      <dd className="min-w-0 break-words">
        {message.from.length > 0 ? (
          <ProfileNames
            addresses={message.from}
            check={message.senderCheck}
            full
            {...profile}
          />
        ) : (
          addressLabel(undefined)
        )}
      </dd>
      <AuthResultsRows auth={message.authResults} check={message.senderCheck} />
      {senderShown && (
        <>
          <dt className="text-muted-foreground">代理送信</dt>
          <dd className="min-w-0 break-words">
            <ProfileNames addresses={message.sender ?? []} full {...profile} />
          </dd>
        </>
      )}
      {message.to.length > 0 && (
        <>
          <dt className="text-muted-foreground">宛先</dt>
          <dd className="min-w-0 break-words">
            <ProfileNames addresses={message.to} full {...profile} />
          </dd>
        </>
      )}
      {message.cc.length > 0 && (
        <>
          <dt className="text-muted-foreground">Cc</dt>
          <dd className="min-w-0 break-words">
            <ProfileNames addresses={message.cc} full {...profile} />
          </dd>
        </>
      )}
      {message.bcc.length > 0 && (
        <>
          <dt className="text-muted-foreground">Bcc</dt>
          <dd className="min-w-0 break-words">
            <ProfileNames addresses={message.bcc} full {...profile} />
          </dd>
        </>
      )}
      {replyToShown && (
        <>
          <dt className="text-muted-foreground">返信先</dt>
          <dd className="min-w-0 break-words">
            <ProfileNames addresses={message.replyTo} full {...profile} />
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">
        {sentAtShown ? "受信日時" : "日時"}
      </dt>
      <dd>
        <ExactTime value={message.receivedAt}>
          {formatFullDate(message.receivedAt, dateStyle)}
        </ExactTime>
      </dd>
      {sentAtShown && message.sentAt && (
        <>
          <dt className="text-muted-foreground">送信日時</dt>
          <dd>
            <ExactTime value={message.sentAt}>
              {formatFullDate(message.sentAt, dateStyle)}
            </ExactTime>
          </dd>
        </>
      )}
      {message.listId && (
        <>
          <dt className="text-muted-foreground">メーリングリスト</dt>
          <dd className="min-w-0 break-words">{message.listId}</dd>
        </>
      )}
      {unsubscribe.length > 0 && (
        <>
          <dt className="text-muted-foreground">配信停止</dt>
          <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {unsubscribe.map((link) => (
              <a
                key={link.href}
                href={link.href}
                // mailto はメールソフトが開くので、新しいタブは要らない。
                target={link.href.startsWith("https:") ? "_blank" : undefined}
                rel="noopener noreferrer"
                title={link.href}
                className="min-w-0 break-words underline underline-offset-2 hover:text-foreground"
              >
                {link.label}
              </a>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
  const toggle = (
    <Hint label={collapsed ? "見出しを展開" : "見出しを折りたたむ"}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "見出しを展開" : "見出しを折りたたむ"}
        onClick={() =>
          updatePreferences({
            messageHeader: collapsed ? "expanded" : "collapsed",
          })
        }
        className="shrink-0 text-muted-foreground"
      >
        <ChevronDownIcon
          className={cn("transition-transform", !collapsed && "rotate-180")}
        />
      </Button>
    </Hint>
  );

  return (
    <article
      // 印刷 (Ctrl+P) で、表示している本文 (読み込んだ画像を含む) を見つけるための印。
      data-message-print={message.id}
      className={cn(
        "flex flex-col",
        // 見出しと本文をまとめてスクロールさせる (見出しは固定しない)。
        !inThread && "min-h-0 flex-1 overflow-y-auto",
      )}
    >
      {/* 会話の中では、件名と差出人は会話側の見出しに出ている。 */}
      {!inThread && (
        <header
          data-find-scope=""
          className="@container shrink-0 border-b px-4 py-3 sm:px-6"
        >
          {collapsed ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
                {preferences.senderIconInMessage ? (
                  <SenderAvatar
                    address={message.from[0]}
                    check={message.senderCheck}
                    className="size-5 text-[10px]"
                  />
                ) : (
                  <UserRoundIcon
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                )}
                <span className="sr-only">差出人</span>
                {/* 長い差出人名は省略する (日時と広げるボタンは必ず収める)。 */}
                <span className="flex min-w-0 font-medium text-foreground">
                  {message.from[0] ? (
                    <ProfileName
                      address={message.from[0]}
                      check={message.senderCheck}
                      className="truncate"
                      {...profile}
                    />
                  ) : (
                    <span className="truncate">{addressLabel(undefined)}</span>
                  )}
                </span>
                <VerifiedSenderMark check={message.senderCheck} />
                <SenderWarningMark check={message.senderCheck} />
                {message.to.length > 0 && (
                  <>
                    <span aria-hidden="true" className="shrink-0">
                      ・
                    </span>
                    <Hint label={mailbox ? mailboxLabel(mailbox) : null}>
                      <span className="shrink-0">
                        <MailboxMark
                          mailbox={mailbox}
                          className="size-4 shrink-0"
                        />
                      </span>
                    </Hint>
                    <span className="sr-only">宛先</span>
                    {/* 宛先は余った幅だけを使う (差出人を先に縮めない)。 */}
                    <span className="min-w-0 flex-1 truncate">
                      <ProfileNames
                        addresses={message.to}
                        separator="、"
                        {...profile}
                      />
                    </span>
                  </>
                )}
                {message.to.length === 0 && <span className="flex-1" />}
                {/* 狭い幅では日時を短くする (今日なら時刻だけ)。全体は広げた見出しで読める。 */}
                <ExactTime
                  value={message.receivedAt}
                  className="shrink-0 whitespace-nowrap text-xs tabular-nums"
                >
                  <span className="@lg:hidden">
                    {formatCompactDate(
                      message.receivedAt,
                      new Date(),
                      dateStyle,
                    )}
                  </span>
                  <span className="@lg:inline hidden">{fullDate}</span>
                </ExactTime>
                {toggle}
              </div>
              <h2 className="line-clamp-2 font-semibold text-xl leading-snug">
                {message.subject || "(件名なし)"}
              </h2>
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-1 sm:py-3">
              <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 font-semibold text-xl leading-snug">
                  {message.subject || "(件名なし)"}
                </h2>
                {toggle}
              </div>
              {meta}
              {preferences.senderIconInMessage ? (
                <div className="flex items-start gap-3">
                  <SenderAvatar
                    address={message.from[0]}
                    check={message.senderCheck}
                    className="size-10 text-base"
                  />
                  <div className="min-w-0 flex-1">{detailRows}</div>
                </div>
              ) : (
                detailRows
              )}
            </div>
          )}
        </header>
      )}

      {inThread && details && (
        <div
          className="pr-4 pb-3 pl-16 sm:pr-6 sm:pl-[4.5rem]"
          data-slot="thread-details"
        >
          {detailRows}
        </div>
      )}

      <SenderWarningBanner check={message.senderCheck} from={message.from[0]} />

      {message.bodyFetchedAt === null ? (
        <output className="block p-4 text-muted-foreground text-sm sm:p-6">
          本文を取得中です。取得が終わると自動で表示されます。
        </output>
      ) : srcDoc ? (
        <>
          {imagesBlocked && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/50 px-4 py-2 sm:px-6">
              <ImageOffIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="min-w-0 flex-1 text-muted-foreground text-sm">
                外部の画像は表示していません。表示すると、開封したことが差出人に伝わる場合があります。
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImagesShownFor(message.id)}
              >
                このメールの画像を表示
              </Button>
            </div>
          )}
          {/* スクリプトの実行もこのアプリのデータへのアクセスも禁止する。
              許可するのは、本文内のリンクを新しいタブで開くことだけ。 */}
          <BodyFrame
            srcDoc={srcDoc}
            fill={!inThread}
            embeddedUrls={embeddedUrls}
          />
        </>
      ) : message.bodyText ? (
        <div className={inThread ? "px-4 pb-4 sm:px-6" : "flex-1 p-4 sm:p-6"}>
          <p
            className="whitespace-pre-wrap break-words"
            style={{
              fontFamily: bodyFontFamily(preferences),
              fontSize: preferences.bodyFontSize,
              lineHeight: preferences.bodyLineHeight,
            }}
          >
            {message.bodyText}
          </p>
        </div>
      ) : (
        <p className="p-4 text-muted-foreground text-sm sm:p-6">
          本文はありません。
        </p>
      )}
      <MessageAttachments
        messageId={message.id}
        files={listed}
        inThread={inThread}
      />
    </article>
  );
}
