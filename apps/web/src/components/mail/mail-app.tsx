"use client";

import { cn } from "cn";
import {
  InboxIcon,
  ListChecksIcon,
  MenuIcon,
  PenSquareIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/components/auth-provider";
import { Hint } from "@/components/hint";
import {
  AccountSidebar,
  type CategoryActions,
} from "@/components/mail/account-sidebar";
import { AddAccountDialog } from "@/components/mail/add-account-dialog";
import {
  CategoryDialog,
  type CategoryDialogTarget,
} from "@/components/mail/category-dialog";
import { CategorySettings } from "@/components/mail/category-settings";
import { ComposeWindow } from "@/components/mail/compose-window";
import { DeleteAccountDialog } from "@/components/mail/delete-account-dialog";
import { DraftList } from "@/components/mail/draft-list";
import { useDrawerSwipe } from "@/components/mail/drawer-swipe";
import { FailureToast } from "@/components/mail/failure-toast";
import {
  FolderDialogs,
  type FolderDialogTarget,
} from "@/components/mail/folder-dialogs";
import { ListLayoutMenu } from "@/components/mail/list-layout-menu";
import { MailboxOverridesDialog } from "@/components/mail/mailbox-overrides-dialog";
import {
  MessageList,
  type MessageListHandle,
} from "@/components/mail/message-list";
import { MessageView } from "@/components/mail/message-view";
import { MoveDialog } from "@/components/mail/move-dialog";
import { OutgoingList } from "@/components/mail/outgoing-list";
import { PaneResizer } from "@/components/mail/pane-resizer";
import {
  PermanentDeleteDialog,
  type PermanentDeleteRequest,
} from "@/components/mail/permanent-delete-dialog";
import { PullToRefresh } from "@/components/mail/pull-to-refresh";
import {
  rememberSearch,
  SEARCH_INPUT_ID,
  SearchBox,
  SearchScope,
} from "@/components/mail/search-bar";
import { SelectionToolbar } from "@/components/mail/selection-toolbar";
import { SettingsView } from "@/components/mail/settings-view";
import {
  SidebarFoldButton,
  SidebarRail,
  useSidebarPeek,
} from "@/components/mail/sidebar-rail";
import {
  SignatureDialog,
  type SignatureTarget,
} from "@/components/mail/signature-dialog";
import { SignatureRulesSettings } from "@/components/mail/signature-rules-settings";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import {
  hideNotice,
  hideUndo,
  showNotice,
  showUndo,
} from "@/components/mail/toasts";
import {
  UnifiedDialog,
  type UnifiedDialogTarget,
} from "@/components/mail/unified-dialog";
import { UnifiedSettings } from "@/components/mail/unified-settings";
import { Button } from "@/components/ui/button";
import { AccountListMark } from "@/lib/account-icons";
import {
  type ActionQueue,
  applyActions,
  createActionQueue,
  type MessageActionInput,
} from "@/lib/actions";
import {
  type Account,
  type Address,
  ApiError,
  deleteDraft,
  deleteOutgoing,
  deleteSignatureRule,
  dismissFailure,
  type FailedOperation,
  getMessage,
  listFailures,
  listOutgoing,
  listSignatureRules,
  listUnified,
  listUnifiedMessages,
  type MailboxSummary,
  type MessageAction,
  type MessageDetail,
  type MessageSummary,
  markMailboxRead,
  type OutgoingMail,
  oauthProviderOf,
  prefetchBodies,
  rescheduleOutgoing,
  resetMailboxOrder,
  retryFailure,
  type SearchParams,
  type ServerDraft,
  type SidebarCategory,
  type SidebarLayout,
  type SignatureRule,
  saveAccountOrder,
  saveDraft,
  saveMailboxOrder,
  saveSidebarCategories,
  saveSidebarLayout,
  sendFocus,
  startOAuthLogin,
  syncAccountNow,
  type UnifiedState,
  type User,
} from "@/lib/api";
import { onOpenAppUpdateSettings } from "@/lib/app-update";
import { backLog } from "@/lib/back-log";
import {
  buildDraftFrom,
  type ComposeDraft,
  type ComposeMode,
  draftAsFormat,
  draftFromOutgoing,
  draftFromServer,
  draftSaveInput,
  draftSignature,
  htmlToText,
  loadUnsavedDrafts,
  NO_SENDABLE_ACCOUNT,
  newDraft,
  RECEIVE_ONLY_SEND_ERROR,
  removeUnsavedDraft,
  sanitizeHtml,
  senderAccount,
  storeUnsavedDraft,
  withReplyText,
} from "@/lib/compose";
import {
  composeFormatFor,
  refreshComposeFormat,
} from "@/lib/compose-format-settings";
import { currentDateStyle, refreshDateStyle } from "@/lib/date-format-settings";
import {
  desktopPlatform,
  desktopWindow,
  isDesktopApp,
  notifyNewMail,
} from "@/lib/desktop/app";
import {
  type DesktopKeyCommand,
  isEditableTarget,
  resolveDesktopKey,
} from "@/lib/desktop/browser-keys";
import { setTitleBarMenu } from "@/lib/desktop/title-bar-menu";
import { type DraftSaveResult, DraftSaver } from "@/lib/draft-saver";
import { type ServerEvent, subscribeEvents } from "@/lib/events";
import { formatFullDate } from "@/lib/format";
import { keepRows } from "@/lib/kept-rows";
import { DEFAULT_SORT, isDefaultSort, sortComparator } from "@/lib/list-sort";
import {
  mailboxLabel,
  refreshMailboxes,
  showsRecipients,
  sortAccounts,
  withSortOrder,
} from "@/lib/mailboxes";
import { isNativeApp, setAppBackHandler } from "@/lib/native/app";
import {
  notificationActionInput,
  refreshNotificationActions,
} from "@/lib/notification-actions";
import {
  disableNotifications,
  dismissNotifications,
  dismissReadNotifications,
  enableNotifications,
  inboxUnreadCount,
  type NotificationActionRequest,
  type NotificationStatus,
  notifiedMessageIds,
  onNotificationAction,
  onNotificationOpen,
  parseMailEvent,
  showPageNotification,
  showUnreadCount,
  syncNotifications,
} from "@/lib/notifications";
import {
  applyActionLocally,
  cachedMessages,
  getThread,
  listAccounts,
  listAllMailboxes,
  listDrafts,
  listMessages,
  onQueuedSendDelivered,
  type QueuedSend,
  removeQueuedSend,
  searchMessages,
  sendMailOrQueue,
  useOnline,
  useQueuedSends,
  warmConversation,
} from "@/lib/offline";
import { adjustUnreadCounts, insertPendingMoves } from "@/lib/pending-moves";
import { markRowsRead, PendingOverlay } from "@/lib/pending-overlay";
import { createPendingShare } from "@/lib/pending-share";
import {
  type ActionHandler,
  type ActionOptions,
  isInTrash,
  skipsDeleteConfirm,
  splitForDelete,
} from "@/lib/permanent-delete";
import { usePreferences } from "@/lib/preferences";
import {
  buildRoute,
  emptyRoute,
  historyMode,
  type MailRoute,
  NEW_COMPOSE,
  parseRoute,
  type SettingsCategory,
  type SpecialView,
  sameSearch,
} from "@/lib/route";
import { emptyFilters, isSearchActive } from "@/lib/search";
import { completeQuery } from "@/lib/search-input";
import { actionBatches, selectRange, toggleSelection } from "@/lib/selection";
import { refreshSenderIconSettings } from "@/lib/sender-icon-settings";
import { registerSheetBack } from "@/lib/sheet-back";
import {
  isSelectAllKey,
  isTypingTarget,
  resolveShortcut,
  SELECT_ALL_SCOPE_ATTRIBUTE,
  selectAllTargetsList,
} from "@/lib/shortcuts";
import {
  addCategory,
  assignCategory,
  MAX_CATEGORIES,
  pruneCategories,
  removeCategory,
  renameCategory,
  reorderCategories,
} from "@/lib/sidebar-categories";
import {
  loadSidebarFolded,
  SIDEBAR_FOLD_KEY_LABEL,
  storeSidebarFolded,
} from "@/lib/sidebar-fold";
import {
  findContactRule,
  findThreadRule,
  loadCachedSignatureRules,
  storeCachedSignatureRules,
} from "@/lib/signatures";
import {
  refreshSwipeSettings,
  resolveSwipe,
  useSwipeSettings,
} from "@/lib/swipe";
import { deviceId, syncStatusOf } from "@/lib/sync-status";
import {
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  updateTableView,
  useTableView,
} from "@/lib/table-view";
import {
  applyActionToThreads,
  flattenRows,
  indexOfOpen,
  type ListItem,
  stepItem,
  type ThreadRows,
} from "@/lib/thread-rows";
import {
  affectedRows,
  isUndoable,
  restoreRows,
  UNDO_MS,
  undoMessage,
} from "@/lib/undo";
import {
  BUILTIN_VIEWS,
  type BuiltinView,
  builtinLabel,
  builtinStyle,
  describeUnified,
  emptyUnifiedState,
  loadCachedUnified,
  reorderLayout,
  scopeMailboxes,
  setEntryHidden,
  storeCachedUnified,
} from "@/lib/unified";
import { adjustUnifiedCounts, overlayUnifiedRows } from "@/lib/unified-match";
import { useMediaQuery } from "@/lib/use-media-query";
import { randomUuid } from "@/lib/uuid";
import {
  canOpenWindows,
  openWindow,
  readWindowMode,
  windowModePath,
} from "@/lib/windows";

const PAGE_SIZE = 50;
/** 表示中のフォルダをサーバーへ知らせる間隔。 */
const FOCUS_INTERVAL_MS = 30_000;
/** 検索欄の入力が止まってから検索を始めるまでの時間。 */
const SEARCH_DELAY_MS = 300;
/** 表示を閉じて履歴を戻したあと、戻り終えた知らせ (popstate) を待つ長さ (ミリ秒)。 */
const BACK_PENDING_TIMEOUT_MS = 1000;
/** サイドバーを引き出して重ねる幅 (Tailwind の md 未満)。 */
const DRAWER_QUERY = "(max-width: 767px)";
const LIST_ERROR = "メールを読み込めませんでした。";
const SEARCH_ERROR = "検索できませんでした。";
const OFFLINE_LIST_ERROR =
  "オフラインです。このフォルダは、まだこの端末に保存されていません。";
/** サーバーに届かない間、届くようになったかを確かめる間隔。 */
const RECONNECT_INTERVAL_MS = 15_000;
const emptySearch: SearchParams = {
  text: "",
  filters: emptyFilters,
  scope: "all",
};
const UNDO_ERROR = "すでにサーバーへ反映済みのため、元に戻せませんでした。";
const ACTION_ERROR =
  "操作を反映できませんでした。一覧を最新の状態に戻しました。";
const MARK_READ_ERROR =
  "既読にできませんでした。時間をおいて、もう一度お試しください。";
const PULL_OFFLINE = "オフラインのため、更新できません。";
const SYNC_NOW_ERROR =
  "同期を始められませんでした。時間をおいて、もう一度お試しください。";
/** フォルダへの操作を受け付けたときの知らせ。画面に出るのは、メールサーバーへの反映と同期のあと。 */
const FOLDER_NOTICES: Record<FolderDialogTarget["kind"], string> = {
  create: "フォルダを作成しています。少しすると一覧に表示されます。",
  rename: "フォルダの名前を変更しています。少しすると一覧に反映されます。",
  delete: "フォルダを削除しています。少しすると一覧から消えます。",
};
const SIGNATURE_RULE_DELETE_ERROR = "署名の設定を解除できませんでした。";
const ORDER_ERROR = "並び順を保存できませんでした。元の順番に戻しました。";
const RETRY_GONE =
  "対象のメールがすでに存在しないため、再試行できませんでした。";
const RETRY_ERROR =
  "再試行できませんでした。時間をおいて、もう一度お試しください。";
const NOTIFICATION_BLOCKED =
  "ブラウザーの設定で通知が拒否されています。ブラウザーの設定で、このサイトの通知を許可してください。";
/** 短い知らせを出しておく時間。 */
const QUICK_REPLY_SENT = "返信を送信しました。";
const QUICK_REPLY_QUEUED = "オフラインです。返信は、接続後に自動で送られます。";
const QUICK_REPLY_ERROR =
  "返信を送信できませんでした。時間をおいて、もう一度お試しください。";
const QUICK_REPLY_NO_RECIPIENT =
  "返信の宛先が分かりません。作成画面で宛先を入力してください。";
/** スター付きの一覧は、全アカウント・全フォルダからスターの付いたメールを探して作る。 */
const starredSearch: SearchParams = {
  text: "",
  filters: { ...emptyFilters, flagged: true },
  scope: "all",
};
const DRAFT_UPDATED_NOTICE = "ほかの端末での変更を反映しました。";
const DRAFT_CONFLICT_NOTICE =
  "ほかの端末でこの下書きが変更されていたため、この端末の内容は別の下書きとして保存しました。";
const DRAFT_GONE_NOTICE =
  "この下書きは、ほかの端末で送信または破棄されました。この端末の内容は新しい下書きとして保存します。";
/** 入力が止まってから、まだ保存していない下書きをこの端末に置くまでの時間。 */
const LOCAL_COPY_DELAY_MS = 300;

/** 下書きを 1 回サーバーへ保存し、結果を保存の係 (DraftSaver) が扱う形にする。 */
async function saveDraftOnce(
  draft: ComposeDraft,
  baseRevision: number | null,
): Promise<DraftSaveResult> {
  try {
    const saved = await saveDraft(
      draft.idempotencyKey,
      draftSaveInput(draft, baseRevision),
    );
    return { status: "saved", revision: saved.revision };
  } catch (error) {
    if (!(error instanceof ApiError)) return { status: "retry" };
    if (error.status === 409) {
      const current = (error.body as { draft?: { revision?: number } | null })
        ?.draft;
      return { status: "conflict", revision: current?.revision ?? null };
    }
    if (error.status === 410) return { status: "gone" };
    if (error.status === 429 || error.status >= 500) return { status: "retry" };
    return { status: "rejected" };
  }
}

/** 表示する一覧。mailboxId が null なら受信トレイ (accountId も null なら全アカウント分)。 */
type Selection = {
  accountId: string | null;
  mailboxId: string | null;
  /** 表示している統合フォルダ。null なら通常のフォルダ。 */
  unifiedId: string | null;
};

/** 一覧の並び順で比べる関数の型。a が b より後ろなら正。 */
type CompareMessages = (a: MessageSummary, b: MessageSummary) => number;

/**
 * 一覧で見ているメールの本文を先に取得するよう頼む。頼めなくても (オフラインなど)
 * 困らないので、失敗は無視する。
 */
function handlePrefetch(ids: string[], reason: "hover" | "visible") {
  void prefetchBodies(ids, reason).catch(() => {});
}

/** 開きそうな行の会話と本文を、開く前に用意しておく。 */
function handleWarm(message: MessageSummary) {
  // このアプリの下書きの控えは、作成画面で開くので用意しない。
  if (!message.draftId) warmConversation(message);
}

/** メールを開いてから、前後の行の準備を始めるまでの時間 (J / K で続けて移るときは用意しない)。 */
const WARM_NEIGHBORS_MS = 300;

/**
 * 取得し直した先頭ページを、読み込み済みの一覧に反映する。
 * 先頭ページの範囲は新しい内容で置き換え、それより古い読み込み済みの分は残す。
 */
function mergeFirstPage(
  current: MessageSummary[],
  firstPage: MessageSummary[],
  firstPageHasMore: boolean,
  compareMessages: CompareMessages,
): MessageSummary[] {
  const last = firstPage.at(-1);
  if (!last || !firstPageHasMore) return firstPage;
  const ids = new Set(firstPage.map((message) => message.id));
  const older = current.filter(
    (message) => !ids.has(message.id) && compareMessages(last, message) < 0,
  );
  return [...firstPage, ...older];
}

/** 画面の下に短く出す知らせ (操作の失敗など)。null を渡すと消す。 */
function setNotice(notice: { message: string; tone: "error" | "info" } | null) {
  if (notice) showNotice(notice.message, notice.tone);
  else hideNotice();
}

export function MailApp({ user }: { user: User }) {
  // 開いたときの URL が指す表示から始める (再読み込み、ブックマーク、通知から開いた場合)。
  // ログイン画面から移ってきた直後は window.location がまだ前の画面を指していることがあるので、
  // 描画中のページの URL を Next.js から受け取る。
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [initialUrl] = useState(() => `${pathname}?${searchParams.toString()}`);
  // URL は表示を変えるたびに書き換える (メールを開くたびなど)。Next.js はそのたびにこの部品を
  // 描き直すので、画面の本体は、使う値 (開いたときの URL) が変わらない限り描き直さない。
  return <MailView user={user} initialUrl={initialUrl} />;
}

const MailView = memo(function MailView({
  user,
  initialUrl,
}: {
  user: User;
  initialUrl: string;
}) {
  const preferences = usePreferences();
  const { signOut } = useAuth();
  const [initialRoute] = useState(() => parseRoute(initialUrl));
  /**
   * 1 つのことだけを出すウィンドウか。作成画面だけ (デスクトップ版の新規作成・返信・転送と、
   * 作成画面の「新しいウィンドウで開く」) と、メールだけ (一覧の「新しいウィンドウで開く」)。
   * fresh は、移すためだけに保存した下書きで、何も書かずに閉じたら消す。
   */
  const [composeWindow] = useState(() =>
    readWindowMode(new URLSearchParams(initialUrl.split("?")[1] ?? "")),
  );
  const standaloneCompose = composeWindow.mode === "compose";
  const standaloneMessage = composeWindow.mode === "message";
  /** デスクトップ版では、作成画面をいつも新しいウィンドウで開く (あおいさんの指定)。 */
  const composeInNewWindow = isDesktopApp() && !standaloneCompose;
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    initialRoute.accountId,
  );
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(
    initialRoute.mailboxId,
  );
  const [mailboxes, setMailboxes] = useState<MailboxSummary[] | null>(null);
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** メール一覧をスクロールさせている要素と、一覧を操作する窓口。 */
  const listScrollRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    initialRoute.messageId,
  );
  /**
   * 会話の全体ではなく、会話の中の 1 通だけを開いているときの、そのメールと一覧の行。
   * messageId が開いているメールと同じ間だけ有効 (別のメールを開いたら無視する)。
   * URL から開いたときは、どの行の中かが分からないので rowId は null。
   */
  const [single, setSingle] = useState<{
    messageId: string;
    rowId: string | null;
  } | null>(
    initialRoute.single && initialRoute.messageId
      ? { messageId: initialRoute.messageId, rowId: null }
      : null,
  );
  /** 一覧で広げている会話の行と、その中身。 */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [threadRows, setThreadRows] = useState<ThreadRows>(new Map());
  const [refreshKey, setRefreshKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [signatureTarget, setSignatureTarget] =
    useState<SignatureTarget | null>(null);
  /** 連絡先ごと、会話ごとの署名 (どの端末でも同じ内容)。 */
  const [signatureRules, setSignatureRules] = useState<SignatureRule[]>([]);
  const [folderDialog, setFolderDialog] = useState<FolderDialogTarget | null>(
    null,
  );
  /** 役割と見た目を変えているフォルダ。 */
  const [customizeTarget, setCustomizeTarget] = useState<MailboxSummary | null>(
    null,
  );
  const openFolderDialog = (target: FolderDialogTarget) => {
    setSidebarOpen(false);
    setFolderDialog(target);
  };
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const backdropRef = useRef<HTMLButtonElement>(null);
  // 広い画面で左のサイドバーを折りたたんでいるか。スマホ幅では使わない (引き出し式のまま)。
  const [sidebarFolded, setSidebarFolded] = useState(false);
  useLayoutEffect(() => {
    setSidebarFolded(loadSidebarFolded());
  }, []);
  const toggleSidebarFolded = () => {
    storeSidebarFolded(!sidebarFolded);
    setSidebarFolded(!sidebarFolded);
  };
  // デスクトップ版のタイトルバーのハンバーガーメニュー。
  // 広い画面ではサイドバーの折りたたみ (F9 と同じ)、狭い画面では引き出しの開閉。
  const titleBarMenuRef = useRef(() => {});
  titleBarMenuRef.current = () => {
    if (window.matchMedia("(min-width: 48rem)").matches) toggleSidebarFolded();
    else setSidebarOpen((open) => !open);
  };
  useEffect(() => {
    if (standaloneCompose || standaloneMessage || !isDesktopApp()) return;
    setTitleBarMenu({
      label: "サイドバーの表示を切り替える",
      shortcut: SIDEBAR_FOLD_KEY_LABEL,
      expanded: !sidebarFolded || sidebarOpen,
      onClick: () => titleBarMenuRef.current(),
    });
  }, [standaloneCompose, standaloneMessage, sidebarFolded, sidebarOpen]);
  useEffect(() => () => setTitleBarMenu(null), []);
  const asideRef = useRef<HTMLElement>(null);
  const sidebarPeek = useSidebarPeek(asideRef, sidebarFolded);

  /** 検索欄の内容。 */
  const [searchInput, setSearchInput] = useState<SearchParams>(
    initialRoute.search ?? emptySearch,
  );
  /** 実行中の検索 (入力が止まってから反映する)。null なら通常の一覧を表示する。 */
  const [search, setSearch] = useState<SearchParams | null>(
    initialRoute.search,
  );
  const searchRef = useRef<SearchParams | null>(null);
  searchRef.current = search;
  /**
   * スマホの検索画面を開いている (検索中は開いていなくても検索画面として出す)。
   * 開いたときに履歴へ積み (mailSearch)、「戻る」で閉じられるようにする。
   */
  const [searchScreen, setSearchScreen] = useState(false);
  /** 値が増えると、表示中のメールを印刷する (デスクトップ版の Ctrl+P)。 */
  const [printRequest, setPrintRequest] = useState(0);
  /** 開いているメールの中の検索を開く要求 (検索欄の候補やショートカットキーから)。 */
  const [findRequest, setFindRequest] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  /** 検索欄を置く場所を決める画面の幅。 */
  const wide = useMediaQuery("(min-width: 1024px)");
  /** 開いたメールを一覧の下に表示する (広い画面で、設定で「下」を選んだとき)。 */
  const messageBelow = wide && preferences.readingPane === "bottom";
  const medium = useMediaQuery("(min-width: 768px)");
  const tableView = useTableView();
  /** 一覧をテーブル表示で出しているか。狭い画面 (幅 768px 未満) ではカード表示にする。 */
  const tableShown = preferences.listLayout === "table" && medium;
  /** 一覧の並び順。テーブル表示の見出しで選んだ順で、カード表示ではいつも新しい順。 */
  const listSort = tableShown ? tableView.sort : DEFAULT_SORT;
  const listSortKey = `${listSort.key}:${listSort.order}`;
  const listSortRef = useRef(listSort);
  listSortRef.current = listSort;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 並び順は listSortKey で見分ける
  const compareMessages = useMemo(
    () => sortComparator(listSort),
    [listSortKey],
  );
  const compareMessagesRef = useRef<CompareMessages>(compareMessages);
  compareMessagesRef.current = compareMessages;
  /** 検索結果で目立たせる語 (サーバーが検索欄の入力から求める)。 */
  const [searchTerms, setSearchTerms] = useState<string[]>([]);

  /** 一覧の取得ごとに増やし、古い応答で新しい表示を上書きしないようにする。 */
  const listRequest = useRef(0);
  /**
   * 条件で絞り込んだ一覧で既読やスターを変えた行。条件から外れてサーバーの一覧に出なくなっても、
   * フォルダを切り替える・検索を変える・引っ張って更新するまでは一覧に残す。
   */
  const keptRowsRef = useRef(new Set<string>());
  /** 表示している統合フォルダ。null なら通常のフォルダ (または下書きなど)。 */
  const [unifiedId, setUnifiedId] = useState<string | null>(
    initialRoute.unifiedId,
  );
  const selectionRef = useRef<Selection>({
    accountId: null,
    mailboxId: null,
    unifiedId: null,
  });
  selectionRef.current = {
    accountId: selectedAccountId,
    mailboxId: selectedMailboxId,
    unifiedId,
  };
  /** サーバーへ送る操作の待ち行列。通信できない間の操作もここに残る。 */
  const queueRef = useRef<ActionQueue | null>(null);
  /** サーバーに届く状態か。届かない間は、端末に保存した内容を表示する。 */
  const online = useOnline();
  const onlineRef = useRef(online);
  onlineRef.current = online;
  /** 端末で預かっている、接続後に送るメール。 */
  const queuedSends = useQueuedSends();
  /** メールサーバーへ反映できなかった操作。やり直すか破棄するまで知らせ続ける。 */
  const [failures, setFailures] = useState<FailedOperation[]>([]);
  const [failureBusy, setFailureBusy] = useState(false);
  const [notificationStatus, setNotificationStatus] =
    useState<NotificationStatus>("off");
  const [notificationBusy, setNotificationBusy] = useState(false);
  const notificationStatusRef = useRef(notificationStatus);
  notificationStatusRef.current = notificationStatus;
  /** 増やすと、表示中のメールの移動先メニューが開く (ショートカットキー用)。 */
  const [moveRequest, setMoveRequest] = useState(0);
  /** 一覧でチェックを付けた行 (複数選択)。一覧から無くなった行は数えない。 */
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  /** 選択中。1 件もチェックしていなくても、各行にチェックボックスを出す。 */
  const [selectMode, setSelectMode] = useState(false);
  /** Shift を押しながらの範囲選択の起点 (最後にチェックを操作した行)。 */
  const anchorRef = useRef<string | null>(null);
  // 最後にマウスや指で押した要素。すべて選択のキーを一覧に使うかどうかの判断に使う。
  const lastPointerRef = useRef<EventTarget | null>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      lastPointerRef.current = event.target;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  /** 増やすと、選択したメールの移動先メニューが開く (ショートカットキー用)。 */
  const [bulkMoveRequest, setBulkMoveRequest] = useState(0);
  /** サーバーに保存してある下書き (どの端末で書いたものも含む)。読み込み前は null。 */
  const [drafts, setDrafts] = useState<ServerDraft[] | null>(null);
  /** 下書きの一覧を表示している。 */
  const [draftsSelected, setDraftsSelected] = useState(initialRoute.drafts);
  /** フォルダ以外の表示 (スター付き、送信待ち、設定)。null ならフォルダか下書きの一覧。 */
  const [special, setSpecial] = useState<SpecialView | null>(
    initialRoute.special,
  );
  /** 設定画面で開いているページ。null なら設定の最初の画面。 */
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategory | null>(initialRoute.settings);
  const starred = special === "starred";
  const starredRef = useRef(starred);
  starredRef.current = starred;
  /**
   * まだサーバーの値に表れていない操作 (このウィンドウとほかのウィンドウの送信待ち、
   * 受け付け済みで取り直す前のもの) と、操作したときの行の控え。
   */
  const overlayRef = useRef<PendingOverlay>(null as unknown as PendingOverlay);
  if (overlayRef.current === null)
    overlayRef.current = new PendingOverlay(null);
  const pendingMailboxesRef = useRef<MailboxSummary[] | null>(null);
  pendingMailboxesRef.current = mailboxes;
  /** 統合フォルダと、サイドバー上部の項目の並び順。 */
  const [unified, setUnified] = useState<UnifiedState>(emptyUnifiedState);
  const unifiedRef = useRef(unified);
  unifiedRef.current = unified;
  /**
   * 取得した一覧に、まだサーバーへ届いていない操作を重ねる。既読やスター、移動元から
   * 外す分に加えて、移動先の一覧には移動したメールを入れる (「元に戻す」を待つ間も含む)。
   * 統合フォルダでは、条件に当てはまらなくなった行を外し、当てはまるようになった行を入れる。
   */
  const overlayPending = useCallback(
    (rows: MessageSummary[], selection: Selection): MessageSummary[] => {
      const sources = overlayRef.current.sources(
        queueRef.current?.pending() ?? [],
        "list",
      );
      const applied = markRowsRead(
        applyActions(rows, sources.actions),
        sources.markRead,
      );
      // 検索結果・スター付きは条件で決まるので、移動先として重ねない。
      if (searchRef.current || starredRef.current) return applied;
      if (selection.unifiedId) {
        const folder = unifiedRef.current.folders.find(
          (item) => item.id === selection.unifiedId,
        );
        if (!folder) return applied;
        return overlayUnifiedRows(
          applied,
          sources.actions,
          sources.snapshots,
          folder,
          pendingMailboxesRef.current ?? [],
          keptRowsRef.current,
          compareMessagesRef.current,
        );
      }
      return insertPendingMoves(
        applied,
        sources.actions,
        sources.snapshots,
        pendingMailboxesRef.current ?? [],
        selection,
        compareMessagesRef.current,
      );
    },
    [],
  );
  /** サーバーから統合フォルダを取得し終えたか (無くなったフォルダの URL を見分けるのに使う)。 */
  const [unifiedLoaded, setUnifiedLoaded] = useState(false);
  const [unifiedDialog, setUnifiedDialog] =
    useState<UnifiedDialogTarget | null>(null);
  const [categoryDialog, setCategoryDialog] =
    useState<CategoryDialogTarget | null>(null);
  /** サーバーからの変更通知の接続。null は、まだ一度も繋がっていない。 */
  const [connected, setConnected] = useState<boolean | null>(null);
  /** いまサーバーに接続している端末の数 (この端末を含む)。 */
  const [devices, setDevices] = useState(0);
  /** まだサーバーへ送れていない操作の数。 */
  const [pendingActions, setPendingActions] = useState(0);
  /** 送信待ちの操作が変わるたびに増える (未読数に送信待ちの操作を重ね直すのに使う)。 */
  const [pendingVersion, setPendingVersion] = useState(0);
  /** 作成画面で開いているメール。閉じると、内容は下書きとしてサーバーに残る。 */
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  /** 開いてから内容を変えたか。変えていない新規のメールは、閉じたら残さない。 */
  const [draftDirty, setDraftDirty] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  // スマホ幅では、サイドバーを画面の左端からのスワイプで開き、左へのスワイプで閉じる。
  useDrawerSwipe({
    asideRef,
    backdropRef,
    open: sidebarOpen,
    onOpenChange: setSidebarOpen,
    disabled: composeOpen,
  });
  const [composeNotice, setComposeNotice] = useState<string | null>(null);
  /** 下書きをサーバーに保存した時刻。 */
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [draftSaveProblem, setDraftSaveProblem] = useState<
    "offline" | "rejected" | null
  >(null);
  /** 増やすと、作成画面の本文を下書きの内容で作り直す。 */
  const [draftVersion, setDraftVersion] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** 下書きをサーバーへ保存する係。 */
  const saverRef = useRef<DraftSaver | null>(null);
  /** 表示中のメールへの返信・転送の依頼 (ショートカットキー用)。 */
  const [composeRequest, setComposeRequest] = useState<{
    count: number;
    mode: Exclude<ComposeMode, "new">;
  } | null>(null);
  /** まだ送り終えていないメール (送信中、やり直し待ち、失敗)。 */
  const [outgoing, setOutgoing] = useState<OutgoingMail[]>([]);
  /**
   * URL が指していて、まだ開けていない作成画面 (下書きの ID か NEW_COMPOSE)。
   * アカウントと下書きの一覧を読み込んでから開く。
   */
  const [composeTarget, setComposeTarget] = useState<string | null>(
    initialRoute.composeId,
  );
  /** true にすると、次の URL の更新は履歴に積まずに書き換える (無くなった表示の後始末など)。 */
  const replaceNextRef = useRef(false);
  /**
   * 表示を閉じたので履歴を 1 つ戻している途中 (戻り先の URL)。戻り終えるまで URL には触らない。
   * 戻り先と違う URL へ戻ったとき (利用者が戻るボタンを押したなど) は、その URL の表示に切り替える。
   */
  const backPendingRef = useRef<string | null>(null);
  /** 増やすと、表示と URL を照らし合わせ直す。 */
  const [routeSync, setRouteSync] = useState(0);

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await listAccounts());
    } catch {
      // 一覧は次の通知や操作でまた取得する。
    }
  }, []);

  const loadMailboxes = useCallback(async () => {
    const started = Date.now();
    try {
      setMailboxes(await listAllMailboxes());
      // 取得を始める前にサーバーが受け付けた操作は、取得した未読数に表れている。
      overlayRef.current.fresh("mailboxes", started);
      setPendingVersion((version) => version + 1);
      // 移動先のメニューなど、フォルダ一覧を別に持っている場所も更新する。
      refreshMailboxes();
    } catch {
      // 一覧は次の通知や操作でまた取得する。
    }
  }, []);

  const loadSignatureRules = useCallback(async () => {
    try {
      const rules = await listSignatureRules();
      setSignatureRules(rules);
      storeCachedSignatureRules(rules);
    } catch {
      // 次の通知や操作でまた取得する。
    }
  }, []);
  // サーバーの応答を待つ間 (オフラインならその後も) は、前回取得した内容を使う。
  useEffect(() => {
    const cached = loadCachedSignatureRules();
    if (cached.length > 0)
      setSignatureRules((current) => (current.length === 0 ? cached : current));
  }, []);

  const loadUnified = useCallback(async () => {
    const started = Date.now();
    try {
      const state = await listUnified();
      setUnified(state);
      overlayRef.current.fresh("unified", started);
      setPendingVersion((version) => version + 1);
      setUnifiedLoaded(true);
      storeCachedUnified(state);
    } catch {
      // 次の通知や操作でまた取得する。
    }
  }, []);
  // サーバーの応答を待つ間 (オフラインならその後も) は、前回取得した内容を出す。
  useEffect(() => {
    const cached = loadCachedUnified();
    if (cached)
      setUnified((current) =>
        current === emptyUnifiedState ? cached : current,
      );
  }, []);

  /** 並び順の保存は、操作した順に 1 つずつ送る。失敗したらサーバーの順に戻す。 */
  const orderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveOrder = (save: () => Promise<void>) => {
    orderQueueRef.current = orderQueueRef.current.then(save).catch(() => {
      setNotice({ message: ORDER_ERROR, tone: "error" });
      void loadAccounts();
      void loadMailboxes();
      void loadUnified();
    });
  };
  /** サイドバー上部の項目の並び順や表示 / 非表示を変える。画面にはすぐ反映する。 */
  const changeLayout = (layout: SidebarLayout) => {
    setUnified((current) => {
      const next = { ...current, layout };
      storeCachedUnified(next);
      return next;
    });
    saveOrder(() => saveSidebarLayout(layout));
  };
  /**
   * サイドバーのカテゴリを変える。画面にはすぐ反映する。
   * 無くなったアカウントや統合フォルダの ID は、このときに取り除く。
   */
  const changeCategories = (
    change: (categories: SidebarCategory[]) => SidebarCategory[],
    /** カテゴリなしのアカウントとカテゴリの、混ぜた並び。省略したら変えない。 */
    sectionOrder?: string[],
  ) => {
    let categories = change(unified.categories);
    if (accounts && unifiedLoaded) {
      categories = pruneCategories(
        categories,
        new Set([
          ...BUILTIN_VIEWS,
          ...unified.folders.map((folder) => folder.id),
          ...accounts.map((account) => account.id),
        ]),
      );
    }
    setUnified((current) => {
      const next = sectionOrder
        ? { ...current, categories, sectionOrder }
        : { ...current, categories };
      storeCachedUnified(next);
      return next;
    });
    saveOrder(() => saveSidebarCategories(categories, sectionOrder));
  };

  const loadOutgoing = useCallback(async () => {
    try {
      setOutgoing(await listOutgoing());
    } catch {
      // 次の通知や操作でまた取得する。
    }
  }, []);

  const loadFailures = useCallback(async () => {
    try {
      setFailures(await listFailures());
    } catch {
      // 次の通知や操作でまた取得する。
    }
  }, []);

  /**
   * 下書きの一覧を取得する。開いている下書きが他の端末で変わっていたら、
   * この端末に保存していない変更が無い場合に限って、その内容に差し替える。
   */
  const loadDrafts = useCallback(async () => {
    const saver = saverRef.current;
    const before = saver?.version;
    let list: ServerDraft[];
    try {
      list = await listDrafts();
    } catch {
      // 次の通知や操作でまた取得する。
      return;
    }
    setDrafts(list);
    const current = draftRef.current;
    // 取得している間にこの端末から保存していたら、一覧のほうが古いかもしれない。
    if (!current || !saver || saver.version !== before) return;
    const id = current.idempotencyKey;
    const known = saver.revisionOf(id);
    if (known === null || saver.isBusy(id)) return;
    const remote = list.find((item) => item.id === id);
    if (!remote) {
      // 他の端末で送信または破棄された。
      void saver.forget(id);
      removeUnsavedDraft(id);
      setDraft(null);
      setDraftDirty(false);
      setComposeOpen(false);
      setComposeNotice(null);
    } else if (remote.revision > known) {
      saver.track(id, remote.revision);
      setDraft(draftFromServer(remote));
      setDraftVersion((version) => version + 1);
      setDraftSavedAt(new Date(remote.updatedAt));
      setComposeNotice(DRAFT_UPDATED_NOTICE);
    }
  }, []);
  /** 一覧を 1 ページ取得する。検索中は検索結果、そうでなければ表示中のフォルダ。 */
  const fetchPage = useCallback(
    async (
      { accountId, mailboxId, unifiedId: unified }: Selection,
      cursor: string | null,
    ) => {
      const sort = listSortRef.current;
      const params = { accountId, mailboxId, cursor, limit: PAGE_SIZE, sort };
      if (starredRef.current) {
        const page = await searchMessages({
          ...starredSearch,
          cursor,
          limit: PAGE_SIZE,
          sort,
        });
        return { page, terms: null };
      }
      const active = searchRef.current;
      if (unified) {
        // 統合フォルダは、サーバーが場所と条件から一覧を作る (端末には保存しない)。
        if (!active) {
          const page = await listUnifiedMessages(unified, {
            cursor,
            limit: PAGE_SIZE,
            sort,
          });
          return { page, terms: null };
        }
        const page = await searchMessages({
          ...active,
          unifiedId: unified,
          cursor,
          limit: PAGE_SIZE,
          sort,
        });
        return { page, terms: page.terms };
      }
      if (!active) return { page: await listMessages(params), terms: null };
      const page = await searchMessages({ ...active, ...params });
      return { page, terms: page.terms };
    },
    [],
  );

  /** 先頭ページを取得する。reset が true なら一覧を空にしてから読み込む。 */
  const loadFirstPage = useCallback(
    async (selection: Selection, reset: boolean) => {
      const request = ++listRequest.current;
      if (reset) {
        keptRowsRef.current = new Set();
        setMessages(null);
        setNextCursor(null);
        setListError(null);
        // サーバーの応答を待たずに、端末に保存してある一覧を先に出す。
        // 端末に保存してあるのは新しい順の一覧なので、ほかの並び順では使わない。
        if (
          !searchRef.current &&
          !starredRef.current &&
          !selection.unifiedId &&
          isDefaultSort(listSortRef.current)
        ) {
          void cachedMessages(selection, PAGE_SIZE).then((saved) => {
            if (!saved || request !== listRequest.current) return;
            const rows = overlayPending(saved.messages, selection);
            // サーバーの応答が先に届いていたら、そちらを残す。
            setMessages((current) => current ?? rows);
          });
        }
      }
      try {
        const { page, terms } = await fetchPage(selection, null);
        if (request !== listRequest.current) return;
        setListError(null);
        setSearchTerms(terms ?? []);
        // まだサーバーへ送れていない操作を、取得した一覧に重ねる。
        const fetched = overlayPending(page.messages, selection);
        const kept = keptRowsRef.current;
        setMessages((current) =>
          current && !reset
            ? keepRows(
                current,
                mergeFirstPage(
                  current,
                  fetched,
                  page.nextCursor !== null,
                  compareMessagesRef.current,
                ),
                kept,
                compareMessagesRef.current,
              )
            : fetched,
        );
        // 2 ページ目以降を読み込み済みなら、続きの位置はそのまま使う。
        setNextCursor((current) =>
          reset || current === null || page.nextCursor === null
            ? page.nextCursor
            : current,
        );
      } catch {
        if (request !== listRequest.current) return;
        setListError(
          searchRef.current
            ? SEARCH_ERROR
            : onlineRef.current
              ? LIST_ERROR
              : OFFLINE_LIST_ERROR,
        );
      }
    },
    [fetchPage, overlayPending],
  );

  useEffect(() => {
    void loadAccounts();
    void loadMailboxes();
    void loadOutgoing();
    void loadFailures();
    void loadDrafts();
    void loadUnified();
    void refreshSwipeSettings();
    void refreshDateStyle();
    void refreshSenderIconSettings();
    void refreshComposeFormat();
    void loadSignatureRules();
  }, [
    loadAccounts,
    loadMailboxes,
    loadOutgoing,
    loadFailures,
    loadDrafts,
    loadUnified,
    loadSignatureRules,
  ]);

  /** 未読数に、まだサーバーへ届いていない操作 (既読、移動、削除) を重ねたフォルダ。 */
  const countedMailboxes = useMemo(() => {
    void pendingVersion;
    if (!mailboxes) return mailboxes;
    const sources = overlayRef.current.sources(
      queueRef.current?.pending() ?? [],
      "mailboxes",
    );
    const read = new Set(sources.markRead.map((entry) => entry.mailboxId));
    const adjusted = adjustUnreadCounts(
      mailboxes,
      sources.actions,
      sources.snapshots,
    );
    if (read.size === 0) return adjusted;
    // 「すべて既読にする」の応答を待っているフォルダ (ほかのウィンドウで行ったものも)。
    return adjusted.map((mailbox) =>
      read.has(mailbox.id) && mailbox.unreadCount > 0
        ? { ...mailbox, unreadCount: 0 }
        : mailbox,
    );
  }, [mailboxes, pendingVersion]);

  /** 統合フォルダの未読数に、まだサーバーの値に表れていない操作を重ねたもの (サイドバー用)。 */
  const countedUnified = useMemo(() => {
    void pendingVersion;
    const sources = overlayRef.current.sources(
      queueRef.current?.pending() ?? [],
      "unified",
    );
    const folders = adjustUnifiedCounts(
      unified.folders,
      sources.actions,
      sources.snapshots,
      sources.origins,
      mailboxes ?? [],
      sources.markRead,
    );
    return folders === unified.folders ? unified : { ...unified, folders };
  }, [unified, mailboxes, pendingVersion]);

  // タブの題名に、受信トレイの未読数を出す。
  useEffect(() => {
    showUnreadCount(inboxUnreadCount(countedMailboxes ?? []));
  }, [countedMailboxes]);
  useEffect(() => () => showUnreadCount(0), []);

  /** 通知から開く。受信トレイに切り替えて、そのメールを表示する。 */
  const openFromNotification = useCallback((messageId: string | null) => {
    setSidebarOpen(false);
    setDraftsSelected(false);
    setSpecial(null);
    setUnifiedId(null);
    setSearchInput(emptySearch);
    setSearchScreen(false);
    setSearch(null);
    setSelectedAccountId(null);
    setSelectedMailboxId(null);
    // 既読にするのは、開いた本文側が行う。
    setSelectedMessageId(messageId);
    setSingle(null);
  }, []);

  // 新着メールの通知。前回この端末で有効にしていれば、送り先を登録し直す。
  useEffect(() => {
    let active = true;
    void syncNotifications().then((status) => {
      if (active) setNotificationStatus(status);
    });
    // 通知から新しく開かれた場合は URL (/messages/<ID>) でメールが指定されていて、
    // 開いたときの URL としてすでに表示に反映している。
    const unsubscribe = onNotificationOpen(openFromNotification);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [openFromNotification]);

  function handleNotificationChange(enabled: boolean) {
    setNotificationBusy(true);
    void (enabled ? enableNotifications() : disableNotifications())
      .then((status) => {
        setNotificationStatus(status);
        if (enabled && status === "blocked") {
          setNotice({ message: NOTIFICATION_BLOCKED, tone: "error" });
        }
      })
      .finally(() => setNotificationBusy(false));
  }

  /** 失敗した操作をやり直す。結果は、サーバーからの通知で一覧に反映される。 */
  function handleRetryFailures(targets: FailedOperation[]) {
    setFailureBusy(true);
    setNotice(null);
    void (async () => {
      let message: string | null = null;
      for (const failure of targets) {
        try {
          await retryFailure(failure.id);
        } catch (error) {
          // 404 は、ほかの端末ですでにやり直したか破棄したもの。
          if (error instanceof ApiError && error.status === 404) continue;
          message =
            error instanceof ApiError && error.status === 410
              ? RETRY_GONE
              : RETRY_ERROR;
        }
      }
      if (message) setNotice({ message, tone: "error" });
      await loadFailures();
      void loadFirstPage(selectionRef.current, false);
      void loadMailboxes();
      setFailureBusy(false);
    })();
  }

  function handleDismissFailures(targets: FailedOperation[]) {
    const ids = new Set(targets.map((failure) => failure.id));
    setFailureBusy(true);
    setFailures((current) => current.filter((item) => !ids.has(item.id)));
    void Promise.all(
      targets.map((failure) => dismissFailure(failure.id).catch(() => {})),
    )
      .then(loadFailures)
      .finally(() => setFailureBusy(false));
  }

  // 下書きをサーバーへ保存する係を用意する。前回この端末で保存し終えていなかった
  // 下書きがあれば、ここで保存する (保存できると下書きの一覧に出る)。
  useEffect(() => {
    const saver = new DraftSaver({
      save: saveDraftOnce,
      onEvent: (event) => {
        const openId = draftRef.current?.idempotencyKey;
        if (event.type === "saved") {
          if (event.settled) removeUnsavedDraft(event.id);
          if (event.id === openId) {
            setDraftSavedAt(new Date());
            setDraftSaveProblem(null);
          }
          void loadDrafts();
        } else if (event.type === "moved") {
          removeUnsavedDraft(event.from);
          const moved = saver.pendingDraft(event.to);
          if (moved) storeUnsavedDraft({ draft: moved, baseRevision: null });
          if (event.from === openId) {
            setDraft((current) =>
              current?.idempotencyKey === event.from
                ? { ...current, idempotencyKey: event.to }
                : current,
            );
            setComposeNotice(
              event.reason === "conflict"
                ? DRAFT_CONFLICT_NOTICE
                : DRAFT_GONE_NOTICE,
            );
          }
        } else if (event.id === openId) {
          setDraftSaveProblem(event.retrying ? "offline" : "rejected");
        }
      },
    });
    saverRef.current = saver;
    for (const { draft: unsaved, baseRevision } of loadUnsavedDrafts()) {
      saver.track(unsaved.idempotencyKey, baseRevision);
      saver.schedule(unsaved);
    }
    void saver.flush();
    return () => {
      saver.stop();
      saverRef.current = null;
    };
  }, [loadDrafts]);

  // サーバーへ保存し終えるまでの間、書きかけの内容をこの端末にも置いておく。
  useEffect(() => {
    if (!draft || !draftDirty) return;
    const keep = () => {
      const saver = saverRef.current;
      // 保存し終えた内容を置き直すと、次に開いたときに古い内容で上書きしかねない。
      if (!saver?.isBusy(draft.idempotencyKey)) return;
      storeUnsavedDraft({
        draft,
        baseRevision: saver.revisionOf(draft.idempotencyKey),
      });
    };
    const timer = setTimeout(keep, LOCAL_COPY_DELAY_MS);
    // 保存を待っている間にページを閉じたり再読み込みしたりしても、内容を失わない。
    window.addEventListener("pagehide", keep);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", keep);
    };
  }, [draft, draftDirty]);

  useEffect(() => {
    const share = createPendingShare();
    const overlay = new PendingOverlay(share);
    overlayRef.current = overlay;
    const queue = createActionQueue();
    queueRef.current = queue;
    setPendingActions(queue.pending().length);
    const unsubscribeSent = queue.onSent((action) => overlay.sent(action));
    const unsubscribeCount = queue.onChange((count) => {
      setPendingActions(count);
      setPendingVersion((version) => version + 1);
      // ほかのウィンドウにも、送信待ちの操作を知らせる。
      overlay.publish(queue.pending());
    });
    const unsubscribe = queue.onRejected(() => {
      // 画面に先に反映した内容を取り消すため、サーバーの状態を取り直す。
      setNotice({ message: ACTION_ERROR, tone: "error" });
      void loadFirstPage(selectionRef.current, false);
      void loadMailboxes();
      void loadUnified();
      setRefreshKey((key) => key + 1);
      share.requestReload();
    });
    /** ほかのウィンドウから届いた操作のうち、もう一覧に重ねたもの。 */
    const applied = new Set<string>();
    const unsubscribeShare = share.subscribe((event) => {
      if (event.type === "reload") {
        // ほかのウィンドウで操作を取り消した。先に重ねた分を戻すため、取り直す。
        void loadFirstPage(selectionRef.current, false);
        void loadMailboxes();
        void loadUnified();
        setRefreshKey((key) => key + 1);
        setPendingVersion((version) => version + 1);
        return;
      }
      overlay.remoteSent(event.sent);
      const fresh = share
        .actions()
        .map((item) => item.action)
        .filter((action) => !applied.has(action.idempotencyKey));
      for (const action of fresh) applied.add(action.idempotencyKey);
      // ほかのウィンドウの操作を、取り直すのを待たずに一覧と開いている会話へ重ねる。
      setMessages(
        (current) => current && overlayPending(current, selectionRef.current),
      );
      for (const action of fresh) {
        setThreadRows((current) => applyActionToThreads(current, action));
      }
      setPendingVersion((version) => version + 1);
    });
    return () => {
      unsubscribe();
      unsubscribeSent();
      unsubscribeCount();
      unsubscribeShare();
      queue.stop();
      queueRef.current = null;
      overlay.close();
    };
  }, [loadFirstPage, loadMailboxes, loadUnified, overlayPending]);

  // 削除や移動の「元に戻す」。操作は画面にすぐ反映するが、知らせを出している間は
  // サーバーへ送らずに待ち、「元に戻す」を押されたら送らずに取り消す。
  const undoRef = useRef<{
    id: number;
    actions: MessageAction[];
    /** 操作の前の行 (会話)。元に戻すときに一覧へ入れ直す。 */
    rows: MessageSummary[];
    selection: Selection;
    /** 操作の前に開いていたメール。 */
    openId: string | null;
    /** 同じ操作のまとまり (複数選択など) を受け付けている間は true。 */
    open: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const undoSeq = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const mailboxesRef = useRef(mailboxes);
  mailboxesRef.current = mailboxes;
  const selectedMessageIdRef = useRef(selectedMessageId);
  selectedMessageIdRef.current = selectedMessageId;

  /**
   * 「元に戻す」の受け付けを終えて、待たせていた操作をサーバーへ送る。
   * only を渡すと、その知らせの操作をまだ受け付けているときだけ行う。
   */
  const commitUndo = useCallback((only?: number) => {
    const group = undoRef.current;
    if (!group || (only !== undefined && group.id !== only)) return;
    undoRef.current = null;
    clearTimeout(group.timer);
    for (const action of group.actions) {
      queueRef.current?.release(action.idempotencyKey);
      // オフラインで開き直しても操作後の状態で出るよう、端末に保存した内容にも反映する。
      applyActionLocally(action);
    }
    hideUndo(group.id);
  }, []);
  // 画面を離れるときは、待たせていた操作をそのまま送る。
  useEffect(() => () => commitUndo(), [commitUndo]);

  /** 知らせの「元に戻す」から呼ぶ処理 (下で定義する handleUndo)。 */
  const handleUndoRef = useRef<() => void>(() => {});

  /**
   * 既読やスターを変えた行を、一覧に残す行として覚える。条件で絞り込んだ一覧
   * (検索結果、スター付き、統合フォルダ) でだけ覚える。通常のフォルダの一覧から
   * 無くなった行は、ほかの端末で移動や削除をされたものなので、残さない。
   */
  const keepAffectedRows = useCallback((rows: readonly MessageSummary[]) => {
    const filtered =
      searchRef.current !== null ||
      starredRef.current ||
      selectionRef.current.unifiedId !== null;
    if (!filtered) return;
    for (const row of rows) keptRowsRef.current.add(row.id);
  }, []);

  /** 操作を画面にすぐ反映し、サーバーへは待ち行列から送る。 */
  const performAction = useCallback(
    (messageIds: string[], input: MessageActionInput) => {
      const action: MessageAction = {
        idempotencyKey: randomUuid(),
        messageIds,
        ...input,
      };
      const undoable = isUndoable(input);
      if (undoable) {
        let group = undoRef.current;
        // 続けて行った別の操作は、前の操作を確定してから受け付ける。
        // 複数選択の操作 (同じ処理の中で続けて呼ばれる) は、1 つにまとめる。
        if (!group?.open) {
          commitUndo();
          const created = {
            id: ++undoSeq.current,
            actions: [],
            rows: [],
            selection: selectionRef.current,
            openId: selectedMessageIdRef.current,
            open: true,
            timer: setTimeout(() => commitUndo(), UNDO_MS),
          };
          group = created;
          undoRef.current = created;
          queueMicrotask(() => {
            created.open = false;
          });
        }
        group.actions.push(action);
        group.rows.push(
          ...affectedRows(messagesRef.current ?? [], messageIds).filter(
            (row) => !group.rows.some((saved) => saved.id === row.id),
          ),
        );
        const id = group.id;
        showUndo(
          id,
          undoMessage(
            input,
            mailboxesRef.current ?? [],
            Math.max(group.rows.length, group.actions.length),
          ),
          () => handleUndoRef.current(),
          // 利用者が知らせを閉じたら、その時点で確定する。
          () => commitUndo(id),
        );
      }
      if (input.action === "set_flags") {
        keepAffectedRows(affectedRows(messagesRef.current ?? [], messageIds));
      }
      // 移動先の一覧や未読数に、サーバーへ届く前から反映できるよう控えておく。
      overlayRef.current.record(
        action.idempotencyKey,
        affectedRows(messagesRef.current ?? [], messageIds),
        selectionRef.current.unifiedId,
      );
      setMessages((current) => current && applyActions(current, [action]));
      setThreadRows((current) => applyActionToThreads(current, action));
      // 既読にした (または移動・削除した) メールの通知は、通知センターから消す。
      if (input.action !== "set_flags" || input.seen === true) {
        void dismissNotifications(messageIds);
      }
      if (input.action !== "set_flags") {
        setSelectedMessageId((current) =>
          current && messageIds.includes(current) ? null : current,
        );
      }
      queueRef.current?.enqueue(action, { hold: undoable });
      // オフラインで開き直しても操作後の状態で出るよう、端末に保存した内容にも反映する。
      // 元に戻せる操作は、確定したとき (commitUndo) に反映する。
      if (!undoable) applyActionLocally(action);
    },
    [commitUndo, keepAffectedRows],
  );

  /** 直前の削除や移動を元に戻す。まだサーバーへ送っていないので、送らずに取り消す。 */
  const handleUndo = useCallback(() => {
    const group = undoRef.current;
    if (!group) return;
    undoRef.current = null;
    clearTimeout(group.timer);
    hideUndo(group.id);
    const cancelled = group.actions.filter((action) =>
      queueRef.current?.cancel(action.idempotencyKey),
    );
    if (cancelled.length < group.actions.length) {
      setNotice({ message: UNDO_ERROR, tone: "error" });
    }
    if (cancelled.length === 0) return;
    // ほかのウィンドウにも、先に重ねた分を戻してもらう。
    overlayRef.current.publish(queueRef.current?.pending() ?? []);
    overlayRef.current.requestReload();
    const now = selectionRef.current;
    if (
      now.accountId === group.selection.accountId &&
      now.mailboxId === group.selection.mailboxId &&
      now.unifiedId === group.selection.unifiedId
    ) {
      // 一覧を取得し直すのを待たずに、控えておいた行を戻す。
      setMessages(
        (current) =>
          current &&
          restoreRows(current, group.rows, compareMessagesRef.current),
      );
      // 開いていたメールを操作で閉じていたら、開き直す。
      // (操作のあとに隣のメールへ移っていた場合も、元のメールへ戻る。)
      if (group.openId) setSelectedMessageId(group.openId);
    }
    void loadFirstPage(selectionRef.current, false);
    setRefreshKey((key) => key + 1);
  }, [loadFirstPage]);
  handleUndoRef.current = handleUndo;

  /**
   * 一覧を引っ張って更新する。開いているアカウント (すべての受信トレイなどでは全アカウント) を
   * メールサーバーへ確認させ、いまの一覧を取得し直す。新しく届いたメールは、同期が済みしだい一覧に出る。
   */
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const handlePullRefresh = useCallback(async () => {
    const selection = selectionRef.current;
    // 利用者が自分で更新したので、条件から外れた行はここで一覧から外す。
    keptRowsRef.current = new Set();
    const ids = selection.accountId
      ? [selection.accountId]
      : (accountsRef.current ?? []).map((account) => account.id);
    if (!onlineRef.current) {
      setNotice({ message: PULL_OFFLINE, tone: "error" });
      return;
    }
    const synced = await Promise.allSettled(
      ids.map((id) => syncAccountNow(id)),
    );
    if (synced.length > 0 && synced.every((r) => r.status === "rejected")) {
      setNotice({ message: SYNC_NOW_ERROR, tone: "error" });
    }
    await Promise.allSettled([
      loadFirstPage(selection, false),
      loadMailboxes(),
      loadDrafts(),
      loadOutgoing(),
    ]);
    setRefreshKey((key) => key + 1);
  }, [loadFirstPage, loadMailboxes, loadDrafts, loadOutgoing]);

  /**
   * フォルダの更新 (デスクトップ版の F5 / Ctrl+R)。表示中のフォルダをメールサーバーへすぐに確認させ、
   * いまの一覧を取得し直す。アカウント全体を確認させるのは、アカウントの更新 (handlePullRefresh)。
   */
  const handleFolderRefresh = useCallback(async () => {
    const selection = selectionRef.current;
    keptRowsRef.current = new Set();
    if (!onlineRef.current) {
      setNotice({ message: PULL_OFFLINE, tone: "error" });
      return;
    }
    await Promise.allSettled([
      sendFocus(selection.accountId, selection.mailboxId, true).catch(() =>
        setNotice({ message: SYNC_NOW_ERROR, tone: "error" }),
      ),
      loadFirstPage(selection, false),
      loadMailboxes(),
      loadDrafts(),
      loadOutgoing(),
    ]);
    setRefreshKey((key) => key + 1);
  }, [loadFirstPage, loadMailboxes, loadDrafts, loadOutgoing]);

  // 一覧の行のスワイプ。何をするかは設定で選び、移動先はそのメールのアカウントの
  // フォルダの役割 (アプリ内で上書きした役割を含む) から決める。
  const swipeSettings = useSwipeSettings();
  const mailboxesByAccount = useMemo(() => {
    const map = new Map<string, MailboxSummary[]>();
    for (const mailbox of mailboxes ?? []) {
      const list = map.get(mailbox.accountId);
      if (list) list.push(mailbox);
      else map.set(mailbox.accountId, [mailbox]);
    }
    return map;
  }, [mailboxes]);
  const swipeFor = useCallback(
    (message: MessageSummary) => {
      const list = mailboxesByAccount.get(message.accountId) ?? [];
      return {
        left: resolveSwipe(swipeSettings.left, message, list),
        right: resolveSwipe(swipeSettings.right, message, list),
      };
    },
    [swipeSettings, mailboxesByAccount],
  );
  /** スワイプで「フォルダを選んで移動」をした行。移動先を選ぶ画面を出す。 */
  const [moveTarget, setMoveTarget] = useState<MessageSummary | null>(null);

  /** メールを開く。既読にするのは、会話を読み込んだ本文側が行う。 */
  function handleSelectMessage(id: string) {
    // 下書きフォルダにある、このアプリの下書きの控えは、作成画面で続きを書く。
    const draftId = messages?.find((item) => item.id === id)?.draftId;
    const own = draftId ? drafts?.find((item) => item.id === draftId) : null;
    if (own) {
      handleOpenDraft(own);
      return;
    }
    setSelectedMessageId(id);
    setSingle(null);
    anchorRef.current = id;
    // 検索結果から開いたら、その検索を「最近の検索」に残す。
    if (search) rememberSearch(search.text);
  }

  /** 一覧で広げた会話の中の 1 通だけを開く。 */
  function handleSelectChild(rowId: string, childId: string) {
    setSelectedMessageId(childId);
    setSingle({ messageId: childId, rowId });
  }

  /** 一覧の会話の行を広げる / 閉じる。 */
  function handleToggleExpand(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    // 閉じたら、次に広げたときに中身を取得し直す (取得に失敗していた場合のやり直しにもなる)。
    threadFetches.current.delete(id);
  }

  // 広げた会話の中身を取得する。同期で一覧が変わったら (refreshKey)、取得し直す。
  const threadFetches = useRef(new Map<string, number>());
  useEffect(() => {
    if (!messages || expandedIds.size === 0) return;
    for (const id of expandedIds) {
      if (threadFetches.current.get(id) === refreshKey) continue;
      const row = messages.find((item) => item.id === id);
      if (!row || row.threadCount <= 1) continue;
      threadFetches.current.set(id, refreshKey);
      getThread(id, row.mailboxId)
        .then((thread) =>
          setThreadRows((current) => new Map(current).set(id, thread)),
        )
        .catch(() =>
          // 取得し直しの失敗では、表示中の中身を消さない。
          setThreadRows((current) =>
            Array.isArray(current.get(id))
              ? current
              : new Map(current).set(id, "error"),
          ),
        );
    }
  }, [messages, expandedIds, refreshKey]);

  function clearSelection() {
    setCheckedIds(new Set());
    setSelectMode(false);
  }

  /** 行のチェックを切り替える。range が true なら、起点からその行までをまとめて選ぶ。 */
  function handleToggleCheck(id: string, range: boolean) {
    const order = (messages ?? []).map((message) => message.id);
    const anchor = anchorRef.current;
    setCheckedIds((current) =>
      range
        ? selectRange(order, current, anchor, id)
        : toggleSelection(current, id),
    );
    anchorRef.current = id;
  }

  /** ドラッグで範囲を選んだとき。 */
  function handleBandSelect(next: Set<string>, anchor: string | null) {
    setCheckedIds(next);
    if (anchor !== null) anchorRef.current = anchor;
  }

  /** 選択した行 (会話) にまとめて操作する。 */
  function performBulk(rows: MessageSummary[], input: MessageActionInput) {
    // スターは 1 通表示と同じく、付けるときは会話の最新の 1 通にだけ付ける
    // (外すときは会話のすべてから外す)。
    const targets =
      input.action === "set_flags" && input.flagged === true
        ? rows.map((row) => ({ ...row, threadMessageIds: [row.id] }))
        : rows;
    for (const ids of actionBatches(targets)) performAction(ids, input);
    // 移動や削除で一覧から無くなるので、選択も終える。
    if (input.action !== "set_flags") clearSelection();
  }

  /** 完全な削除の確認で待っている操作。 */
  const [deleteConfirm, setDeleteConfirm] =
    useState<PermanentDeleteRequest | null>(null);

  /**
   * 完全な削除は、Shift を押しながらの操作でなければ確認してから行う。
   * それ以外の操作は、そのまま行う。
   */
  const requestAction = useCallback<ActionHandler>(
    (messageIds, input, options) => {
      const run = () => {
        performAction(messageIds, input);
        options?.onDone?.();
      };
      if (input.action === "delete" && !options?.skipConfirm) {
        setDeleteConfirm({ count: messageIds.length, run });
        return;
      }
      run();
    },
    [performAction],
  );

  /**
   * 選んだメールを削除する。ごみ箱にあるものは完全に削除し (確認してから)、
   * ほかのフォルダのものはごみ箱へ移す。検索結果や統合フォルダでは両方が混ざる。
   */
  function deleteRows(rows: MessageSummary[], skipConfirm: boolean) {
    const { toTrash, permanent } = splitForDelete(rows, mailboxes ?? []);
    const run = () => {
      if (toTrash.length > 0) {
        performBulk(toTrash, { action: "move", destination: "trash" });
      }
      if (permanent.length > 0) performBulk(permanent, { action: "delete" });
    };
    if (permanent.length > 0 && !skipConfirm) {
      setDeleteConfirm({
        count: permanent.reduce(
          (sum, row) => sum + row.threadMessageIds.length,
          0,
        ),
        run,
      });
      return;
    }
    run();
  }
  /**
   * 複数選択した行の上の右クリックメニューからの操作。メニューは右クリックした行に
   * 合わせて作られるので、移動先のフォルダは役割に置き換え、選んだすべての行に行う。
   */
  function handleSelectionMenuAction(
    input: MessageActionInput,
    options?: ActionOptions,
  ) {
    const rows = checkedRows;
    if (rows.length === 0) return;
    if (input.action === "set_flags") {
      performBulk(rows, input);
      return;
    }
    const target =
      input.action === "move" && "mailboxId" in input
        ? mailboxes?.find((mailbox) => mailbox.id === input.mailboxId)
        : undefined;
    // 削除 (ごみ箱へ移す・完全に削除) は、行ごとの所在で分ける。
    if (input.action === "delete" || target?.specialUse === "trash") {
      deleteRows(rows, options?.skipConfirm ?? false);
      return;
    }
    if (input.action !== "move") return;
    if (!("mailboxId" in input)) {
      performBulk(rows, input);
      return;
    }
    const role = target?.specialUse;
    if (role === "inbox" || role === "junk") {
      performBulk(rows, { action: "move", destination: role });
    } else if (role === "archive" || role === "all") {
      // Gmail のアーカイブは「すべてのメール」。サーバーがアカウントごとに選ぶ。
      performBulk(rows, { action: "move", destination: "archive" });
    } else if (target) {
      // ほかのフォルダはアカウントごとにあるので、そのアカウントの行だけを移す。
      const own = rows.filter((row) => row.accountId === target.accountId);
      if (own.length > 0) performBulk(own, input);
    }
  }

  // 検索欄の入力が止まったら検索する。入力も条件も無くなったら、すぐに通常の一覧へ戻す。
  useEffect(() => {
    const next = { ...searchInput, text: completeQuery(searchInput.text) };
    if (!isSearchActive(next)) {
      setSearch(null);
      return;
    }
    // 入力の途中で語が変わらなければ (演算子を入れただけなど)、検索し直さない。
    const timer = setTimeout(
      () =>
        setSearch((current) => (sameSearch(current, next) ? current : next)),
      SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [searchInput]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: search と starred は読み込み直すきっかけとして使う (中身は ref から読む)
  useEffect(() => {
    void loadFirstPage(
      {
        accountId: selectedAccountId,
        mailboxId: selectedMailboxId,
        unifiedId,
      },
      true,
    );
  }, [
    selectedAccountId,
    selectedMailboxId,
    unifiedId,
    search,
    starred,
    listSortKey,
    loadFirstPage,
  ]);

  // 画面を開いている間、表示中のフォルダをサーバーへ知らせ続ける。サーバーはその間、
  // 表示中のフォルダを短い間隔で同期する。画面が隠れている間は知らせない (通常の間隔に戻る)。
  useEffect(() => {
    const send = () => {
      if (document.visibilityState !== "visible") return;
      sendFocus(selectedAccountId, selectedMailboxId).catch(() => {
        // 届かなくても通常の間隔で同期されるので、次の機会に送り直すだけでよい。
      });
    };
    send();
    const timer = setInterval(send, FOCUS_INTERVAL_MS);
    document.addEventListener("visibilitychange", send);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", send);
    };
  }, [selectedAccountId, selectedMailboxId]);

  // 表示中のフォルダがサーバーから無くなったら、受信トレイに戻す。
  useEffect(() => {
    if (
      selectedMailboxId &&
      mailboxes &&
      !mailboxes.some((mailbox) => mailbox.id === selectedMailboxId)
    ) {
      replaceNextRef.current = true;
      setSelectedMailboxId(null);
      setSelectedMessageId(null);
    }
  }, [mailboxes, selectedMailboxId]);

  // 表示中の統合フォルダが無くなったら (ほかの端末で削除した場合など)、すべての受信トレイに戻す。
  useEffect(() => {
    if (
      unifiedId &&
      unifiedLoaded &&
      !unified.folders.some((folder) => folder.id === unifiedId)
    ) {
      replaceNextRef.current = true;
      setUnifiedId(null);
      setSelectedMessageId(null);
    }
  }, [unified, unifiedLoaded, unifiedId]);

  // スマホアプリでは、通知の分類 (Android の通知チャンネル) をアカウントごとに用意する。
  const channelKey = accounts
    ?.map((account) => `${account.id}\n${account.displayName || account.email}`)
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 名前か顔ぶれが変わったときだけそろえる
  useEffect(() => {
    if (!accounts || !isNativeApp()) return;
    void import("@/lib/native/push").then(({ syncAccountChannels }) =>
      syncAccountChannels(accounts),
    );
  }, [channelKey]);

  // 表示中のアカウントが無くなったら (古い URL を開いた場合など)、全アカウントの表示に戻す。
  useEffect(() => {
    if (
      selectedAccountId &&
      accounts &&
      !accounts.some((account) => account.id === selectedAccountId)
    ) {
      replaceNextRef.current = true;
      setSelectedAccountId(null);
      setSelectedMailboxId(null);
      setSelectedMessageId(null);
    }
  }, [accounts, selectedAccountId]);

  // 一覧で既読になっているメールの通知は消す (ほかの端末で既読にしたものも含む)。
  useEffect(() => {
    if (!messages) return;
    let cancelled = false;
    void notifiedMessageIds().then((ids) => {
      if (cancelled || ids.length === 0) return;
      const notified = new Set(ids);
      void dismissNotifications(
        messages.flatMap((row) =>
          row.seen ? row.threadMessageIds.filter((id) => notified.has(id)) : [],
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [messages]);

  // サーバーからの変更通知で、アカウントとフォルダの一覧、表示中の一覧を取得し直す。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const handleEvent = (event: ServerEvent) => {
      if (event.event === "devices") {
        try {
          const count: unknown = (JSON.parse(event.data) as { count?: unknown })
            .count;
          if (typeof count === "number") setDevices(count);
        } catch {
          // 形式の違う知らせは無視する。
        }
        return;
      }
      if (event.event === "mail") {
        // Web Push が使えるときは、サービスワーカーが通知を出す。
        if (notificationStatusRef.current !== "page") return;
        for (const notification of parseMailEvent(event.data)) {
          void showPageNotification(notification, openFromNotification);
        }
        return;
      }
      if (event.event !== "ready" && event.event !== "change") return;
      // 最初の ready は、直前に行った初回の読み込みと重なるので何もしない。
      if (first && event.event === "ready") {
        first = false;
        return;
      }
      first = false;
      // 同期中は通知が続けて届くので、少し待ってまとめて反映する。
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void dismissReadNotifications();
        void loadAccounts();
        void loadMailboxes();
        void loadOutgoing();
        void loadFailures();
        void loadDrafts();
        void loadUnified();
        void refreshSwipeSettings();
        void refreshDateStyle();
        void refreshSenderIconSettings();
        void refreshComposeFormat();
        void loadSignatureRules();
        void loadFirstPage(selectionRef.current, false);
        setRefreshKey((key) => key + 1);
      }, 300);
    };
    const unsubscribe = subscribeEvents(handleEvent, {
      deviceId: deviceId(),
      onState: setConnected,
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [
    loadAccounts,
    loadMailboxes,
    loadFirstPage,
    loadOutgoing,
    loadFailures,
    loadDrafts,
    loadUnified,
    loadSignatureRules,
    openFromNotification,
  ]);

  // サーバーに届くようになったら、表示を最新の状態にする。届かない間は、届くかを時々確かめる。
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) {
      void loadAccounts();
      void loadMailboxes();
      void loadOutgoing();
      void loadFailures();
      void loadDrafts();
      void loadUnified();
      void refreshSwipeSettings();
      void refreshDateStyle();
      void refreshSenderIconSettings();
      void refreshComposeFormat();
      void loadSignatureRules();
      void loadFirstPage(selectionRef.current, false);
      void saverRef.current?.flush();
      setRefreshKey((key) => key + 1);
    }
    wasOnline.current = online;
    if (online) return;
    const probe = () => {
      if (navigator.onLine !== false) void loadAccounts();
    };
    const timer = setInterval(probe, RECONNECT_INTERVAL_MS);
    window.addEventListener("online", probe);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", probe);
    };
  }, [
    online,
    loadAccounts,
    loadMailboxes,
    loadOutgoing,
    loadFailures,
    loadDrafts,
    loadUnified,
    loadSignatureRules,
    loadFirstPage,
  ]);

  // 端末で預かっていたメールをサーバーへ渡せたら、送信中の一覧と下書きを取得し直す。
  useEffect(
    () =>
      onQueuedSendDelivered(() => {
        void loadOutgoing();
        void loadDrafts();
      }),
    [loadOutgoing, loadDrafts],
  );

  /** 署名の決まりを画面に反映する (サーバーへの保存は済んでいる)。 */
  const updateSignatureRules = (
    update: (current: SignatureRule[]) => SignatureRule[],
  ) =>
    setSignatureRules((current) => {
      const next = update(current);
      storeCachedSignatureRules(next);
      return next;
    });
  /** 連絡先や会話の署名をまだ決めていないときに、書き始めの内容にするアカウントの署名。 */
  const accountSignature = (accountId: string) =>
    accounts?.find((item) => item.id === accountId)?.signatureHtml ?? null;

  /**
   * 作成画面でメールを開く。それまで開いていたメールは、下書きとしてサーバーに残る。
   * dirty は、開いた時点でまだ保存していない内容があること。
   */
  function showInCompose(next: ComposeDraft, dirty: boolean) {
    if (composeInNewWindow) {
      void openComposeWindow(next, dirty);
      return;
    }
    showComposeHere(next, dirty);
  }

  /** 作成画面を、このウィンドウの中で開く。 */
  function showComposeHere(next: ComposeDraft, dirty: boolean) {
    // 入力が止まるのを待たずに、開いていたメールを保存する。
    if (draft && draftDirty) void saverRef.current?.flush();
    setDraft(next);
    setDraftDirty(dirty);
    setDraftVersion((version) => version + 1);
    setDraftSavedAt(null);
    setDraftSaveProblem(null);
    setComposeNotice(null);
    setComposeOpen(true);
    if (dirty) saverRef.current?.schedule(next);
  }

  /**
   * 作成画面を新しいウィンドウで開く (デスクトップ版)。書き始めの内容は下書きとしてサーバーに保存し、
   * 新しいウィンドウがその下書きを開く。何も入っていない新規作成は保存せず、アカウントだけを渡す。
   * 保存できない (通信できない) か、ウィンドウを開けなければ、このウィンドウの中で開く。
   */
  async function openComposeWindow(next: ComposeDraft, dirty: boolean) {
    const saver = saverRef.current;
    const id = next.idempotencyKey;
    const saved = saver?.revisionOf(id) != null;
    if (next.mode === "new" && !dirty && !saved) {
      const path = buildRoute({
        ...emptyRoute,
        accountId: next.accountId,
        composeId: NEW_COMPOSE,
      });
      if (!(await openWindow(windowModePath(path, "compose")))) {
        showComposeHere(next, dirty);
      }
      return;
    }
    if (saver && (dirty || !saved)) {
      saver.schedule(next);
      await saver.flush();
    }
    if (
      saver?.revisionOf(id) != null &&
      (await openWindow(
        windowModePath(
          buildRoute({ ...emptyRoute, composeId: id }),
          "compose",
          // 返信・転送の書き始めなど、移すためだけに保存した下書き。
          !dirty && !saved,
        ),
      ))
    ) {
      void loadDrafts();
      return;
    }
    showComposeHere(next, true);
  }

  /** 作成専用・メール専用のウィンドウを閉じる。保存や削除が終わるのを待ってから閉じる。 */
  async function closeStandaloneWindow(pending?: Promise<unknown>) {
    await pending?.catch(() => {});
    if (isDesktopApp()) await desktopWindow.close();
    else window.close();
  }

  // 作成専用のウィンドウを閉じるとき (タイトルバーの閉じるボタン、Alt+F4 など) の後始末。
  // 書きかけは保存し終えてから、移すためだけに保存した下書きは消してから閉じる。
  const beforeWindowCloseRef = useRef<() => Promise<void>>(async () => {});
  beforeWindowCloseRef.current = async () => {
    const current = draftRef.current;
    if (!current) return;
    if (composeWindow.fresh && !draftDirty) {
      await handleDiscardDraft(current.idempotencyKey);
      return;
    }
    await closeCompose();
  };
  useEffect(() => {
    if (!standaloneCompose || !isDesktopApp()) return;
    return desktopWindow.onCloseRequested(() => beforeWindowCloseRef.current());
  }, [standaloneCompose]);

  // メール専用のウィンドウで、メールを削除・アーカイブした (または無くなっていた) ら閉じる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 閉じる処理は毎回の描画で作り直すので、きっかけになる値だけを見る
  useEffect(() => {
    if (standaloneMessage && selectedMessageId === null) {
      void closeStandaloneWindow();
    }
  }, [standaloneMessage, selectedMessageId]);

  /**
   * 新しいメールを書き始める。from を省くと、いま選んでいるアカウント (無ければ先頭) から。
   * そのアカウントが受信専用なら、送信できるアカウントのうち先頭のものから送る。
   * 送信できるアカウントが無ければ、そのまま開く (作成画面で送れないことを知らせる)。
   */
  function handleNewMail(from?: string) {
    const preferred = from ?? selectedAccountId ?? accounts?.[0]?.id;
    const accountId = senderAccount(accounts ?? [], preferred)?.id ?? preferred;
    if (!accountId) return;
    const account = accounts?.find((item) => item.id === accountId);
    showInCompose(
      draftAsFormat(
        newDraft(accountId, account?.signatureHtml),
        composeFormatFor(account),
      ),
      false,
    );
  }

  /** プロフィールカードから、そのアドレス宛ての新しいメールを書き始める。 */
  function handleComposeTo(address: Address, accountId: string) {
    // 開いているメールのアカウントが受信専用なら、送信できるほかのアカウントから送る。
    const account =
      senderAccount(accounts ?? [], accountId) ??
      accounts?.find((item) => item.id === accountId);
    if (!account) return;
    const to = { list: [address], text: "" };
    // この相手に署名を決めてあれば、アカウントの署名の代わりに使う。
    const signature = draftSignature(
      { accountId: account.id, to },
      accounts ?? [],
      signatureRules,
    );
    const next = draftAsFormat(
      newDraft(account.id, signature.html),
      composeFormatFor(account),
    );
    showInCompose(
      { ...next, to },
      // 宛先を入れてあるので、下書きとして保存する。
      true,
    );
  }

  /** スマホの検索画面を開く。「戻る」で閉じられるよう、履歴に積む。 */
  function openSearchScreen() {
    setSelectedMessageId(null);
    setSearchScreen(true);
    const url = `${window.location.pathname}${window.location.search}`;
    window.history.pushState({ mailFrom: url, mailSearch: true }, "", url);
  }

  /** スマホの検索画面を閉じて、検索を終える。 */
  function closeSearchScreen() {
    if (window.history.state?.mailSearch === true) {
      // 開く前の表示が 1 つ前の履歴にある。戻ると、検索も終わる (popstate で反映)。
      window.history.back();
      // Android の WebView では戻れないことがある。そのときは、ここで閉じる。
      window.setTimeout(() => {
        if (window.history.state?.mailSearch !== true) return;
        window.history.replaceState(
          { ...window.history.state, mailSearch: undefined },
          "",
        );
        setSearchScreen(false);
        setSearchInput(emptySearch);
        setSearch(null);
      }, BACK_PENDING_TIMEOUT_MS);
      return;
    }
    setSearchScreen(false);
    setSearchInput(emptySearch);
    setSearch(null);
  }

  /** プロフィールカードから、そのアドレスとやり取りしたメールをすべてのフォルダから検索する。 */
  function handleSearchAddress(address: Address) {
    const next: SearchParams = { ...emptySearch, text: address.address };
    setSearchInput(next);
    setSearch(next);
    // 一覧とメールを同時に出せない幅では、検索結果が見えるようにメールを閉じる。
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      setSelectedMessageId(null);
    }
  }

  /** 下書きの一覧から選んだ下書きを、作成画面で開く。 */
  function handleOpenDraft(item: ServerDraft) {
    if (draft?.idempotencyKey === item.id) {
      setComposeOpen(true);
      return;
    }
    const saver = saverRef.current;
    // この端末に保存していない変更が残っていれば、そちらが新しい。
    const pending = saver?.pendingDraft(item.id);
    if (!pending && !saver?.isBusy(item.id))
      saver?.track(item.id, item.revision);
    showInCompose(pending ?? draftFromServer(item), false);
    setDraftSavedAt(new Date(item.updatedAt));
  }

  const handleCompose = (
    mode: Exclude<ComposeMode, "new">,
    message: MessageDetail,
    /** 本文の下の返信欄に書いてあった文章。あれば本文の先頭に入れる。 */
    text = "",
  ) => {
    const built = withReplyText(
      buildDraftFrom(mode, message, accounts ?? [], signatureRules),
      text,
    );
    // 書くアカウントの設定がテキストなら、テキストで書き始める (引用は行頭の > になる)。
    const format = composeFormatFor(
      accounts?.find((item) => item.id === built.accountId),
    );
    showInCompose(draftAsFormat(built, format), text.trim() !== "");
  };

  /** 本文の下の返信欄から、差出人へそのまま返信する。署名と引用は、作成画面と同じように付く。 */
  async function handleQuickReply(
    message: MessageDetail,
    text: string,
  ): Promise<boolean> {
    const reply = withReplyText(
      buildDraftFrom("reply", message, accounts ?? [], signatureRules),
      text,
    );
    if (reply.to.list.length === 0) {
      setNotice({ message: QUICK_REPLY_NO_RECIPIENT, tone: "error" });
      return false;
    }
    // 送信できるアカウントが無いと、受信専用のアカウントのままになり送れない。
    if (!senderAccount(accounts ?? [], reply.accountId)) {
      setNotice({ message: NO_SENDABLE_ACCOUNT, tone: "error" });
      return false;
    }
    const html = sanitizeHtml(reply.html, { rich: true });
    // テキストで書く設定のアカウントでは、HTML を付けずに送る。
    const plain =
      composeFormatFor(
        accounts?.find((item) => item.id === reply.accountId),
      ) === "text";
    let result: "sent" | "queued";
    try {
      // サーバーに届かなければ端末で預かり、接続後に自動で送る。
      result = await sendMailOrQueue(
        {
          idempotencyKey: reply.idempotencyKey,
          accountId: reply.accountId,
          to: reply.to.list,
          cc: [],
          bcc: [],
          subject: reply.subject,
          text: htmlToText(html),
          ...(plain ? {} : { html }),
          mode: "reply",
          sourceMessageId: message.id,
        },
        [],
      );
    } catch (cause) {
      setNotice({
        message:
          cause instanceof ApiError && cause.code === "receive_only"
            ? RECEIVE_ONLY_SEND_ERROR
            : QUICK_REPLY_ERROR,
        tone: "error",
      });
      return false;
    }
    setNotice({
      message: result === "queued" ? QUICK_REPLY_QUEUED : QUICK_REPLY_SENT,
      tone: "info",
    });
    void loadOutgoing();
    return true;
  }

  /**
   * 通知の返信欄から返信する (デスクトップ版の Windows)。ウィンドウを出さずに、
   * 本文の下の返信欄と同じ内容 (署名と引用付き) で送る。送れなければ OS の通知で知らせる
   * (ウィンドウが隠れていると、画面の知らせには気付けないため)。
   */
  async function replyFromNotification(messageId: string, text: string) {
    let sent = false;
    try {
      sent = await handleQuickReply(await getMessage(messageId), text);
    } catch {
      sent = false;
    }
    if (!sent) {
      void notifyNewMail({
        title: "返信を送れませんでした",
        body: text,
        messageId,
      });
    }
  }

  // 通知のボタンと返信欄 (デスクトップ版の Windows) からの操作。最新の状態で処理するため、
  // 受け口は 1 度だけ登録し、処理そのものは描画のたびに差し替える。
  const notificationActionRef = useRef<
    (request: NotificationActionRequest) => void
  >(() => {});
  notificationActionRef.current = (request) => {
    if (request.action === "reply") {
      void replyFromNotification(request.messageId, request.text);
      return;
    }
    performAction([request.messageId], notificationActionInput(request.action));
  };
  useEffect(() => {
    if (!isDesktopApp()) return;
    // 通知に付けるボタンは設定画面で選ぶ。ほかの端末で変えた分も取り込んでおく。
    void refreshNotificationActions();
    return onNotificationAction((request) =>
      notificationActionRef.current(request),
    );
  }, []);

  /** 一覧のメールを、新しいウィンドウで開く (いまの表示と同じフォルダの中で開く)。 */
  function openMessageWindow(message: MessageSummary) {
    void openWindow(
      windowModePath(
        buildRoute({
          ...emptyRoute,
          accountId: selectedAccountId,
          mailboxId: selectedMailboxId,
          unifiedId,
          special: special === "starred" ? special : null,
          messageId: message.id,
        }),
        "message",
      ),
    ).then((opened) => {
      if (!opened) showNotice("新しいウィンドウを開けませんでした。");
    });
  }

  /**
   * 作成画面を新しいウィンドウへ移す。書きかけの内容は下書きとしてサーバーに保存し、
   * 新しいウィンドウがその下書きを開く。保存できなければ移さない (内容を失わないため)。
   */
  async function popOutCompose() {
    const saver = saverRef.current;
    if (!draft || !saver) return;
    saver.schedule(draft);
    await saver.flush();
    const id = draft.idempotencyKey;
    if (saver.revisionOf(id) == null) {
      showNotice(
        "下書きを保存できないため、新しいウィンドウへ移せませんでした。通信の状態を確認してください。",
      );
      return;
    }
    if (
      !(await openWindow(
        windowModePath(buildRoute({ ...emptyRoute, composeId: id }), "compose"),
      ))
    ) {
      showNotice("新しいウィンドウを開けませんでした。");
      return;
    }
    setDraft(null);
    setDraftDirty(false);
    setComposeNotice(null);
    setComposeOpen(false);
  }

  /** 作成画面を閉じる。内容を変えていれば、下書きとしてサーバーに残る。 */
  function closeCompose(): Promise<void> | undefined {
    const flushed = draft && draftDirty ? saverRef.current?.flush() : undefined;
    setDraft(null);
    setDraftDirty(false);
    setComposeNotice(null);
    setComposeOpen(false);
    return flushed;
  }

  /** 送信または破棄した下書きを、画面とこの端末から消す。 */
  function dropDraft(id: string) {
    removeUnsavedDraft(id);
    setDrafts(
      (current) => current?.filter((item) => item.id !== id) ?? current,
    );
    if (draftRef.current?.idempotencyKey !== id) return;
    setDraft(null);
    setDraftDirty(false);
    setDraftSavedAt(null);
    setComposeNotice(null);
    setComposeOpen(false);
  }

  /** 下書きを破棄する。サーバーからも、付けていたファイルごと消える。 */
  function handleDiscardDraft(id: string): Promise<void> {
    dropDraft(id);
    const done = (async () => {
      // 保存の途中なら終わるのを待つ (あとから保存が届いて作り直されないように)。
      await saverRef.current?.forget(id);
      await deleteDraft(id).catch(() => {});
      void loadDrafts();
    })();
    return done;
  }

  function handleEditOutgoing(mail: OutgoingMail) {
    // 内容は下書きに移すので、すぐに保存の対象にする。
    showInCompose(draftFromOutgoing(mail), true);
    handleRemoveOutgoing(mail);
  }

  /** 予約送信の日時を変える。at が null なら今すぐ送る。 */
  function handleRescheduleOutgoing(mail: OutgoingMail, at: Date | null) {
    const scheduledAt = at?.toISOString() ?? null;
    setOutgoing((current) =>
      current.map((item) =>
        item.id === mail.id ? { ...item, scheduledAt } : item,
      ),
    );
    rescheduleOutgoing(mail.id, scheduledAt)
      .then(() => {
        setNotice({
          message: scheduledAt
            ? `${formatFullDate(scheduledAt, currentDateStyle())} に送信するよう変更しました。`
            : "送信を始めました。",
          tone: "info",
        });
      })
      .catch(() => {
        setNotice({
          message:
            "予約を変更できませんでした。すでに送信が始まっているか、通信できませんでした。",
          tone: "error",
        });
      })
      .finally(() => void loadOutgoing());
  }

  function handleRemoveOutgoing(mail: OutgoingMail) {
    setOutgoing((current) => current.filter((item) => item.id !== mail.id));
    // 送信が始まっていて取り消せなかった場合などは、取得し直して実際の状態を出す。
    deleteOutgoing(mail.id)
      .catch(() => {})
      .finally(() => void loadOutgoing());
  }

  /** 端末で預かっているメールを、送らずに作成画面へ戻す。 */
  function handleEditQueued(item: QueuedSend) {
    void removeQueuedSend(item.id).then((removed) => {
      // ちょうど送っている最中なら、戻せない。
      if (!removed) return;
      const { input } = item;
      const restored: ComposeDraft = {
        ...draftFromOutgoing({
          id: item.id,
          accountId: input.accountId,
          status: "failed",
          attempts: 0,
          lastError: null,
          createdAt: item.createdAt,
          mode: input.mode,
          sourceMessageId: input.sourceMessageId ?? null,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html ?? null,
          attachments: item.attachments,
        }),
        // サーバーには届いていないので、同じ ID のまま続きを書く (下書きが残っていれば、その続きになる)。
        idempotencyKey: item.id,
      };
      const remote = drafts?.find((draft) => draft.id === item.id);
      if (remote) saverRef.current?.track(item.id, remote.revision);
      showInCompose(restored, true);
    });
  }

  /** 端末で預かっているメールの送信を取り消す。 */
  function handleRemoveQueued(item: QueuedSend) {
    void removeQueuedSend(item.id).then((removed) => {
      // サーバーに下書きが残っていれば、それも消す (届かなければ、下書きとして残る)。
      if (removed) handleDiscardDraft(item.id);
    });
  }

  /** 再ログインが必要な Google / Microsoft のアカウントで、ログイン画面へ移る。 */
  function handleReauth(account: Account) {
    const provider = oauthProviderOf(account);
    if (!provider) return;
    startOAuthLogin(provider, account.id)
      .then((url) => window.location.assign(url))
      .catch(() => {
        // 失敗しても表示はそのままなので、もう一度押せる。
      });
  }

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  // Android の戻るボタン: 画面左上の「←」と同じく、開いている表示を 1 つ閉じる
  // (lib/native/app.ts の setAppBackHandler)。閉じるものが無ければ false。
  const appBackRef = useRef<() => boolean>(() => false);
  appBackRef.current = () => {
    if (standaloneCompose || standaloneMessage) return false;
    if (draft && composeOpen) {
      void closeCompose();
      return true;
    }
    if (selectedMessageId) {
      setSelectedMessageId(null);
      return true;
    }
    if (special === "settings" && settingsCategory) {
      setSettingsCategory(null);
      return true;
    }
    if (special === "settings") {
      // 設定の一覧からは、すべての受信トレイへ戻る (アプリを裏へ回さない)。
      handleSelectFolder(null, null);
      return true;
    }
    if (searchScreen) {
      closeSearchScreen();
      return true;
    }
    return false;
  };
  useEffect(() => setAppBackHandler(() => appBackRef.current()), []);

  // スマホ幅で引き出したサイドバーは、戻る操作 (Android の戻るボタンなど) で閉じる。
  // 開いたままだと、後ろの画面が戻ってしまう。
  useEffect(() => {
    if (!sidebarOpen || !window.matchMedia(DRAWER_QUERY).matches) return;
    return registerSheetBack(
      () => setSidebarOpen(false),
      !isNativeApp(),
      undefined,
      "sidebar",
    );
  }, [sidebarOpen]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    const request = listRequest.current;
    setLoadingMore(true);
    try {
      const { page } = await fetchPage(selectionRef.current, nextCursor);
      if (request !== listRequest.current) return;
      const fetched = applyActions(
        page.messages,
        overlayRef.current.sources(queueRef.current?.pending() ?? [], "list")
          .actions,
      );
      setMessages((current) => {
        const ids = new Set((current ?? []).map((message) => message.id));
        return [
          ...(current ?? []),
          ...fetched.filter((message) => !ids.has(message.id)),
        ];
      });
      setNextCursor(page.nextCursor);
      setListError(null);
    } catch {
      if (request === listRequest.current) {
        setListError(searchRef.current ? SEARCH_ERROR : LIST_ERROR);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSelectFolder(
    accountId: string | null,
    mailboxId: string | null,
  ) {
    setSidebarOpen(false);
    setSelectedMessageId(null);
    setDraftsSelected(false);
    setSpecial(null);
    setUnifiedId(null);
    // フォルダを選んだら検索を終えて、そのフォルダの一覧を表示する。
    setSearchInput(emptySearch);
    setSearchScreen(false);
    setSearch(null);
    clearSelection();
    anchorRef.current = null;
    setSelectedAccountId(accountId);
    setSelectedMailboxId(mailboxId);
  }

  /** 統合フォルダを表示する。アカウントやフォルダには結び付かない。 */
  function handleSelectUnified(id: string) {
    setSidebarOpen(false);
    setSelectedMessageId(null);
    setDraftsSelected(false);
    setSpecial(null);
    setSearchInput(emptySearch);
    setSearchScreen(false);
    setSearch(null);
    clearSelection();
    anchorRef.current = null;
    setSelectedAccountId(null);
    setSelectedMailboxId(null);
    setUnifiedId(id);
  }

  function handleSelectDrafts() {
    setSidebarOpen(false);
    setSelectedMessageId(null);
    // 下書きの一覧は検索の対象ではないので、検索は終える。
    setSearchInput(emptySearch);
    setSearchScreen(false);
    setSearch(null);
    clearSelection();
    anchorRef.current = null;
    setSpecial(null);
    setUnifiedId(null);
    setDraftsSelected(true);
  }

  /** スター付き、送信待ち、設定を表示する。どれもフォルダには結び付かない。 */
  function handleSelectSpecial(view: SpecialView) {
    setSidebarOpen(false);
    setSelectedMessageId(null);
    setSearchInput(emptySearch);
    setSearchScreen(false);
    setSearch(null);
    clearSelection();
    anchorRef.current = null;
    setDraftsSelected(false);
    setUnifiedId(null);
    setSelectedAccountId(null);
    setSelectedMailboxId(null);
    setSpecial(view);
    setSettingsCategory(null);
  }

  const handleMissing = useCallback(() => {
    // 無くなったメールの URL は、履歴に残さない。
    replaceNextRef.current = true;
    setSelectedMessageId(null);
  }, []);

  /** 作成画面で開いているメールの、URL での表し方。 */
  const openComposeId =
    draft && composeOpen
      ? draft.mode === "new" &&
        !draftDirty &&
        saverRef.current?.revisionOf(draft.idempotencyKey) == null
        ? NEW_COMPOSE
        : draft.idempotencyKey
      : null;
  /** いまの表示を表す URL (パスと ? 以降)。 */
  const routeUrl = buildRoute({
    accountId: selectedAccountId,
    mailboxId: selectedMailboxId,
    unifiedId,
    drafts: draftsSelected,
    special,
    messageId: selectedMessageId,
    settings: settingsCategory,
    single: single !== null && single.messageId === selectedMessageId,
    composeId: openComposeId ?? composeTarget,
    search,
  });

  // 表示が変わったら URL に反映する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeSync は照らし合わせ直すきっかけとして使う
  useEffect(() => {
    if (backPendingRef.current !== null) return;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const forceReplace = replaceNextRef.current;
    replaceNextRef.current = false;
    if (routeUrl === currentUrl) return;
    const from: unknown = window.history.state?.mailFrom;
    let mode = forceReplace
      ? "replace"
      : historyMode(parseRoute(currentUrl), parseRoute(routeUrl));
    if (mode === "close") {
      if (from === routeUrl) {
        // 開く前の表示が 1 つ前の履歴にあるので、そこへ戻る。
        backPendingRef.current = routeUrl;
        backLog(`表示を閉じたので履歴を戻す → ${routeUrl}`);
        window.history.back();
        // 戻り終えた知らせ (popstate) が来なければ、待つのをやめて照らし合わせ直す。
        // 待ったままだと URL が更新されず、次に戻るボタンを押しても戻れなくなる。
        window.setTimeout(() => {
          if (backPendingRef.current !== routeUrl) return;
          backLog("履歴を戻した知らせが来ないので、待つのをやめる");
          backPendingRef.current = null;
          // 戻れなかったので、いまの履歴を閉じた後の URL に書き換える (もう一度戻ろうとしない)。
          replaceNextRef.current = true;
          setRouteSync((count) => count + 1);
        }, BACK_PENDING_TIMEOUT_MS);
        return;
      }
      mode = "replace";
    }
    backLog(`URL を${mode === "push" ? "積む" : "書き換える"} ${routeUrl}`);
    if (mode === "push") {
      window.history.pushState({ mailFrom: currentUrl }, "", routeUrl);
    } else {
      // 検索画面を開いた履歴は、検索の語が変わっても検索画面の履歴のままにする。
      window.history.replaceState(
        { mailFrom: from, mailSearch: window.history.state?.mailSearch },
        "",
        routeUrl,
      );
    }
  }, [routeUrl, routeSync]);

  /** URL が指す表示に切り替える (ブラウザーの「戻る」「進む」)。 */
  const applyRouteRef = useRef<(route: MailRoute) => void>(() => {});
  applyRouteRef.current = (route) => {
    setSidebarOpen(false);
    setSearchScreen(window.history.state?.mailSearch === true);
    if (
      route.accountId !== selectedAccountId ||
      route.mailboxId !== selectedMailboxId ||
      route.unifiedId !== unifiedId ||
      route.drafts !== draftsSelected ||
      route.special !== special
    ) {
      clearSelection();
      anchorRef.current = null;
    }
    setSelectedAccountId(route.accountId);
    setSelectedMailboxId(route.mailboxId);
    setUnifiedId(route.unifiedId);
    setDraftsSelected(route.drafts);
    setSpecial(route.special);
    setSettingsCategory(route.settings);
    setSelectedMessageId(route.messageId);
    setSingle((current) =>
      route.single && route.messageId
        ? current?.messageId === route.messageId
          ? current
          : { messageId: route.messageId, rowId: null }
        : null,
    );
    // 検索の内容が同じなら、一覧を読み込み直さない (スクロールの位置も保つ)。
    if (!sameSearch(route.search, search)) {
      setSearchInput(route.search ?? emptySearch);
      setSearch(route.search);
    }
    if (!route.composeId) {
      setComposeTarget(null);
      if (draft) closeCompose();
    } else if (route.composeId !== openComposeId) {
      setComposeTarget(route.composeId);
    }
  };
  useEffect(() => {
    const onPopState = () => {
      const url = `${window.location.pathname}${window.location.search}`;
      const pending = backPendingRef.current;
      backPendingRef.current = null;
      backLog(
        pending === null
          ? "popstate を表示に反映"
          : pending === url
            ? "自分で戻した分の popstate"
            : `戻り先と違う popstate (待っていたのは ${pending})`,
      );
      if (pending === url) {
        // 自分で戻した分。表示はすでに変えてあるので、URL と合っているかだけ確かめる。
        setRouteSync((count) => count + 1);
        return;
      }
      applyRouteRef.current(parseRoute(url));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // URL が指す作成画面を開く。下書きが見つからなければ、URL から外すだけにする。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開く処理は毎回の描画で作り直すので、きっかけになる値だけを見る
  useEffect(() => {
    if (!composeTarget || accounts === null || drafts === null) return;
    setComposeTarget(null);
    if (composeTarget === openComposeId) return;
    if (composeTarget === NEW_COMPOSE) {
      if (draft) return;
      if (accounts.length > 0) handleNewMail();
      else replaceNextRef.current = true;
      return;
    }
    const saved = drafts.find((item) => item.id === composeTarget);
    // サーバーへ保存し終える前に閉じた下書きは、この端末にだけ残っている。
    const unsaved = saverRef.current?.pendingDraft(composeTarget);
    if (saved) handleOpenDraft(saved);
    else if (unsaved) showInCompose(unsaved, true);
    else replaceNextRef.current = true;
  }, [composeTarget, accounts, drafts]);

  // 接続後に送るメールの下書きは、送信したものとして一覧に出さない。
  const queuedIds = new Set(queuedSends.map((item) => item.id));
  const visibleDrafts =
    drafts && queuedIds.size > 0
      ? drafts.filter((item) => !queuedIds.has(item.id))
      : drafts;

  const selectedAccount =
    accounts?.find((account) => account.id === selectedAccountId) ?? null;
  const selectedMailbox =
    mailboxes?.find((mailbox) => mailbox.id === selectedMailboxId) ?? null;
  const selectedUnified =
    (unifiedId && unified.folders.find((folder) => folder.id === unifiedId)) ||
    null;
  /** 統合フォルダが集めるのが、自分が差出人のフォルダ (送信済み、下書き) だけか。 */
  const unifiedShowsRecipients = (() => {
    if (!selectedUnified || selectedUnified.scope.all) return false;
    const sources = scopeMailboxes(selectedUnified.scope, mailboxes ?? []);
    return sources.length > 0 && sources.every(showsRecipients);
  })();
  const openUnifiedSettings = () => {
    handleSelectSpecial("settings");
    setSettingsCategory("sidebar");
  };
  // トレイの「更新を確認」と、アプリ本体の更新の知らせの「詳細」で、設定の「バージョン情報」を開く。
  const openAboutRef = useRef<() => void>(() => {});
  openAboutRef.current = () => {
    handleSelectSpecial("settings");
    setSettingsCategory("about");
  };
  useEffect(() => onOpenAppUpdateSettings(() => openAboutRef.current()), []);
  const openUnifiedDialog = (target: UnifiedDialogTarget) => {
    setSidebarOpen(false);
    setUnifiedDialog(target);
  };
  /** サイドバーの項目 (初めからある項目、統合フォルダ、アカウント) の表示名。 */
  const sidebarItemLabel = (key: string): string | undefined => {
    if ((BUILTIN_VIEWS as readonly string[]).includes(key)) {
      return builtinLabel(unified, key as BuiltinView);
    }
    const folder = unified.folders.find((item) => item.id === key);
    if (folder) return folder.name;
    const account = accounts?.find((item) => item.id === key);
    return account ? account.displayName || account.email : undefined;
  };
  const openCategoryDialog = (target: CategoryDialogTarget) => {
    if (
      target.kind === "create" &&
      unified.categories.length >= MAX_CATEGORIES
    ) {
      setNotice({
        message: `カテゴリは ${MAX_CATEGORIES} 個まで作れます。`,
        tone: "error",
      });
      return;
    }
    setSidebarOpen(false);
    setCategoryDialog(target);
  };
  /** サイドバーのカテゴリの操作 (サイドバーと設定画面から呼ぶ)。 */
  const categoryActions: CategoryActions = {
    onCreate: (key) =>
      openCategoryDialog(
        key === undefined
          ? { kind: "create" }
          : { kind: "create", key, label: sidebarItemLabel(key) },
      ),
    onRename: (category) => openCategoryDialog({ kind: "rename", category }),
    onDelete: (category) => {
      changeCategories((list) => removeCategory(list, category.id));
      setNotice({
        message: `カテゴリ「${category.name}」を削除しました。中の項目はカテゴリなしに戻ります。`,
        tone: "info",
      });
    },
    onAssign: (key, categoryId, sectionOrder) =>
      changeCategories(
        (list) => assignCategory(list, key, categoryId),
        sectionOrder,
      ),
    onReorder: (ids) =>
      changeCategories((list) => reorderCategories(list, ids)),
    onReorderSections: (keys) =>
      changeCategories(
        (list) =>
          reorderCategories(
            list,
            keys.filter((key) => list.some((category) => category.id === key)),
          ),
        keys,
      ),
  };
  const openBuiltinDialog = (view: BuiltinView) =>
    openUnifiedDialog({
      kind: "builtin",
      view,
      style: builtinStyle(unified, view),
    });
  /** フォルダの未読をすべて既読にする。画面にはすぐ反映し、失敗したらサーバーの状態に戻す。 */
  const handleMarkAllRead = (target: MailboxSummary) => {
    // 統合フォルダの未読数とほかのウィンドウにも、応答を待たずに反映する。
    const before =
      countedMailboxes?.find((mailbox) => mailbox.id === target.id)
        ?.unreadCount ?? target.unreadCount;
    overlayRef.current.startMarkRead({ mailboxId: target.id, unread: before });
    overlayRef.current.publish(queueRef.current?.pending() ?? []);
    setPendingVersion((version) => version + 1);
    setMailboxes(
      (current) =>
        current?.map((mailbox) =>
          mailbox.id === target.id ? { ...mailbox, unreadCount: 0 } : mailbox,
        ) ?? null,
    );
    keepAffectedRows(
      (messagesRef.current ?? []).filter(
        (message) => message.mailboxId === target.id && !message.seen,
      ),
    );
    setMessages(
      (current) =>
        current?.map((message) =>
          message.mailboxId === target.id && !message.seen
            ? { ...message, seen: true }
            : message,
        ) ?? null,
    );
    markMailboxRead(target.id).then(
      () => {
        overlayRef.current.finishMarkRead(target.id, true);
        overlayRef.current.publish(queueRef.current?.pending() ?? []);
        setPendingVersion((version) => version + 1);
      },
      () => {
        overlayRef.current.finishMarkRead(target.id, false);
        overlayRef.current.publish(queueRef.current?.pending() ?? []);
        overlayRef.current.requestReload();
        setPendingVersion((version) => version + 1);
        setNotice({ message: MARK_READ_ERROR, tone: "error" });
        void loadMailboxes();
        void loadUnified();
        void loadFirstPage(selectionRef.current, false);
      },
    );
  };
  /** メールのアカウントすべてに迷惑メールのフォルダがある (迷惑メールとして扱える)。 */
  const junkAvailable = (rows: MessageSummary[]) =>
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.mailboxId !== null &&
        mailboxes?.some(
          (mailbox) =>
            mailbox.accountId === row.accountId &&
            mailbox.specialUse === "junk" &&
            mailbox.id !== row.mailboxId,
        ),
    );
  const accountName = selectedAccount
    ? selectedAccount.displayName || selectedAccount.email
    : null;
  const title = draftsSelected
    ? builtinLabel(unified, "drafts")
    : starred
      ? builtinLabel(unified, "starred")
      : special === "outgoing"
        ? builtinLabel(unified, "outgoing")
        : selectedUnified
          ? selectedUnified.name
          : selectedMailbox
            ? mailboxLabel(selectedMailbox)
            : (accountName ?? builtinLabel(unified, "inbox"));
  /** フォルダを表示している間は、どのアカウントのフォルダかを添える (統合フォルダでは、その内容)。 */
  const subtitle = selectedUnified
    ? describeUnified(selectedUnified, mailboxes ?? [])
    : !draftsSelected && selectedMailbox
      ? accountName
      : null;
  const noAccounts = accounts !== null && accounts.length === 0;
  const searching = search !== null;
  /**
   * 一覧の見出し。検索中は、ほかのフォルダのメールも並ぶので、フォルダ名ではなく
   * 「検索結果」とし、探している範囲を添える。
   */
  const heading = search !== null ? "検索結果" : title;
  const headingNote =
    search === null
      ? subtitle
      : search.scope === "folder"
        ? title
        : (accountName ?? "すべてのアカウント");
  /** 新しいメールを書き始められる (アカウントがある)。 */
  const canCompose = accounts !== null && accounts.length > 0;
  /** 検索欄を出す一覧 (フォルダの一覧) を表示している。 */
  const showSearch = canCompose && !draftsSelected && special === null;
  const syncStatus = syncStatusOf({
    online,
    connected,
    pendingActions,
    // 端末で預かっている、接続後に送るメールも数える (サーバーに断られたものは除く)。
    pendingMails:
      outgoing.filter((mail) => mail.status !== "failed").length +
      queuedSends.filter((item) => item.error === null).length,
    accounts,
    devices,
  });
  /**
   * 複数のアカウントのメールが並ぶ一覧 (すべての受信トレイ、スター付き、全体の検索) で、
   * どのアカウントのメールかを、アカウントのマーク (設定したアイコンか色の点) で示す。
   */
  // 一覧の行は、渡した値が変わったときだけ描き直す。関数も、もとの値が変わるまで同じものを渡す。
  const accountMark = useMemo(
    () =>
      selectedAccountId === null && (accounts?.length ?? 0) > 1
        ? (message: MessageSummary) => {
            const account = accounts?.find(
              (item) => item.id === message.accountId,
            );
            return account
              ? {
                  mark: (
                    <AccountListMark
                      accounts={accounts ?? []}
                      account={account}
                      dotClass="size-1.5"
                    />
                  ),
                  name: account.displayName || account.email,
                }
              : null;
          }
        : undefined,
    [selectedAccountId, accounts],
  );
  const settingsOpen = special === "settings";
  /** 狭い画面でサイドバーを開くボタン。 */
  const menuButton = (className: string) => (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="メニューを開く"
      aria-controls="mail-sidebar"
      aria-expanded={sidebarOpen}
      onClick={() => setSidebarOpen(true)}
      className={cn("md:hidden", className)}
    >
      <MenuIcon />
    </Button>
  );
  /** 検索欄。広い画面では右上 (メールの表示の上) に、スマホでは検索画面のアプリバーに置く。 */
  const searchBox = (variant: "popup" | "screen") => (
    <SearchBox
      key={variant}
      variant={variant}
      folders={mailboxes && accounts ? { mailboxes, accounts } : undefined}
      value={searchInput}
      onChange={setSearchInput}
      onSubmit={(text) => {
        setSearchInput({ ...searchInput, text });
        const next = { ...searchInput, text: completeQuery(text) };
        setSearch(isSearchActive(next) ? next : null);
      }}
      placeholder={
        variant === "popup"
          ? "検索"
          : accountName
            ? `${accountName} から検索`
            : "すべてのアカウントから検索"
      }
      onFindInMessage={
        selectedMessageId
          ? (text) =>
              setFindRequest((current) => ({
                text,
                nonce: (current?.nonce ?? 0) + 1,
              }))
          : undefined
      }
      onClose={closeSearchScreen}
      autoFocus={variant === "screen" && searchScreen && !searching}
      className={variant === "screen" ? "h-full flex-1" : undefined}
    />
  );
  /** 検索結果の各行に出す、メールのある場所。アカウントを選んでいなければアカウント名も添える。 */
  const locationLabel = useCallback(
    (message: MessageSummary): string | null => {
      const mailbox = mailboxes?.find((item) => item.id === message.mailboxId);
      if (!mailbox) return null;
      const account = selectedAccountId
        ? null
        : accounts?.find((item) => item.id === message.accountId);
      const name = account ? account.displayName || account.email : null;
      return name
        ? `${name} · ${mailboxLabel(mailbox)}`
        : mailboxLabel(mailbox);
    },
    [mailboxes, selectedAccountId, accounts],
  );

  // 開いているメールを含む行。会話に新しいメールが届いて行の代表が替わっても、同じ行を指す。
  // 会話の中の 1 通だけを開いているときは、その会話の行。
  /** 一覧の見出しに、表示を選ぶ「…」のメニューを出すか (選べる項目がある幅だけ)。 */
  // 一覧の見出しに検索欄を置くか (一覧だけを出す幅と、メールを下に表示するとき)。
  const headerSearch =
    showSearch && medium && (messageBelow || (!wide && !selectedMessageId));
  const layoutMenu = medium && !draftsSelected && special !== "outgoing";
  const isSingle = single !== null && single.messageId === selectedMessageId;
  const selectedMessage =
    (selectedMessageId &&
      ((isSingle &&
        single.rowId &&
        messages?.find((message) => message.id === single.rowId)) ||
        messages?.find(
          (message) =>
            message.id === selectedMessageId ||
            message.threadMessageIds.includes(selectedMessageId),
        ))) ||
    null;
  const checkedRows = (messages ?? []).filter((message) =>
    checkedIds.has(message.id),
  );
  const selecting = selectMode || checkedRows.length > 0;

  // 開いたメールの前後の行も用意しておく (J / K やスワイプで次へ移ったときに、すぐ表示できる)。
  const openRowId = selectedMessage?.id ?? null;
  useEffect(() => {
    if (!openRowId) return;
    const timer = setTimeout(() => {
      const list = messagesRef.current ?? [];
      const index = list.findIndex((message) => message.id === openRowId);
      if (index === -1) return;
      for (const neighbor of [list[index + 1], list[index - 1]]) {
        if (neighbor) handleWarm(neighbor);
      }
    }, WARM_NEIGHBORS_MS);
    return () => clearTimeout(timer);
  }, [openRowId]);

  /** 広げた会話の中の 1 通の、既読とスター。中身をまだ取得していなければ空。 */
  const childFlags = (rowId: string, childId: string) => {
    const thread = threadRows.get(rowId);
    const child = Array.isArray(thread)
      ? thread.find((item) => item.id === childId)
      : undefined;
    return child ? { seen: child.seen, flagged: child.flagged } : {};
  };

  /** 検索欄へ移る。検索欄が無ければ何もしない。移ったら (検索画面を開いたら) true。 */
  const focusSearch = () => {
    const input = document.getElementById(SEARCH_INPUT_ID);
    if (!(input instanceof HTMLInputElement)) {
      // スマホ幅では、検索画面を開く。
      if (showSearch && !medium) {
        openSearchScreen();
        return true;
      }
      return false;
    }
    const focus = () => {
      input.focus();
      input.select();
    };
    if (input.offsetParent !== null) {
      focus();
    } else {
      // スマホ幅でメールを開いているときは一覧が隠れているので、一覧へ戻ってから移動する。
      setSelectedMessageId(null);
      requestAnimationFrame(focus);
    }
    return true;
  };

  /**
   * デスクトップ版で、ブラウザーのキーに割り当てたアプリの操作を行う。
   * 再読み込みと強制再読み込みは、どの画面でも lib/desktop/browser-keys.ts が行う。
   */
  const runDesktopCommand = (command: DesktopKeyCommand | "block") => {
    // ダイアログやメニューを開いている間は、後ろの画面を操作しない。
    if (document.querySelector('[role="dialog"], [role="menu"]')) return;
    /** メールを表示しているか (メールだけのウィンドウを含む)。 */
    const showingMessage =
      standaloneMessage || (selectedMessageId !== null && !settingsOpen);
    const findInMessage = () => {
      if (!showingMessage) return;
      setFindRequest((current) => ({
        text: "",
        nonce: (current?.nonce ?? 0) + 1,
      }));
    };
    switch (command) {
      case "print":
        // 印刷できるのは、メールを表示しているときだけ。
        if (showingMessage) setPrintRequest((count) => count + 1);
        break;
      case "findInMessage":
        findInMessage();
        break;
      case "focusSearch":
        // メールだけのウィンドウには検索欄が無いので、メールの中を探す。
        if (standaloneMessage) findInMessage();
        else if (!standaloneCompose) focusSearch();
        break;
      case "refreshFolder":
      case "refreshAccount":
        if (standaloneCompose) break;
        if (standaloneMessage) {
          // メールだけのウィンドウでは、表示しているメールを取得し直す。
          setRefreshKey((key) => key + 1);
        } else if (command === "refreshFolder") {
          void handleFolderRefresh();
        } else {
          void handlePullRefresh();
        }
        break;
    }
  };

  // ショートカットキー。処理は毎回の描画で作り直し、最新の一覧と選択を使う。
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (event) => {
    // デスクトップ版では、ブラウザーのキー (Ctrl+R、Ctrl+F、Ctrl+P など) にアプリの操作を割り当てている
    // (lib/desktop/browser-keys.ts)。ブラウザー標準の動きは、そちらで止めている。
    if (isDesktopApp()) {
      const command = resolveDesktopKey(event, {
        mac: desktopPlatform() === "macos",
        editable: isEditableTarget(event.target),
      });
      if (command) {
        runDesktopCommand(command);
        return;
      }
    }
    // 作成専用のウィンドウでは、一覧の操作のキーは使わない (一覧を出していない)。
    if (standaloneCompose || standaloneMessage) return;
    // Ctrl+A (⌘+A) で、一覧に読み込んだメールをすべて選ぶ。ブラウザーや OS と同じキーなので、
    // ショートカットキーの設定を止めていても効かせる。入力欄やメールの本文では文字の全選択のまま。
    if (isSelectAllKey(event)) {
      if (!selectAllTargetsList(event.target, lastPointerRef.current)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (draftsSelected || special === "outgoing" || special === "settings") {
        return;
      }
      const list = messages ?? [];
      if (list.length === 0) return;
      event.preventDefault();
      setCheckedIds(new Set(list.map((message) => message.id)));
      return;
    }
    // 設定でショートカットキーを止めていても、Esc で閉じる操作は残す。
    if (!preferences.shortcuts && event.key !== "Escape") return;
    const command = resolveShortcut(event);
    if (!command || isTypingTarget(event.target)) return;
    // ダイアログやメニューを開いている間は、そちらのキー操作を優先する。
    if (document.querySelector('[role="dialog"], [role="menu"]')) return;
    if (command === "compose") {
      event.preventDefault();
      handleNewMail();
      return;
    }
    if (command === "toggleSidebar") {
      event.preventDefault();
      toggleSidebarFolded();
      return;
    }
    if (command === "undo") {
      if (!undoRef.current) return;
      event.preventDefault();
      handleUndo();
      return;
    }
    if (command === "search") {
      if (focusSearch()) event.preventDefault();
      return;
    }
    // 下書きの一覧を表示している間は、メールの一覧への操作は受け付けない。
    if (draftsSelected || special === "outgoing" || special === "settings") {
      return;
    }
    const list = messages ?? [];
    const index = selectedMessage ? list.indexOf(selectedMessage) : -1;

    if (command === "select") {
      // 開いているメール (無ければ最後に操作した行) のチェックを切り替える。
      const id = selectedMessage?.id ?? anchorRef.current;
      if (!id || !list.some((item) => item.id === id)) return;
      event.preventDefault();
      handleToggleCheck(id, false);
      return;
    }
    // チェックを付けたメールがあれば、操作はそれらが対象になる。
    if (checkedRows.length > 0 || selectMode) {
      const flags = (input: { seen?: boolean; flagged?: boolean }) =>
        performBulk(checkedRows, { action: "set_flags", ...input });
      const inJunk = selectedMailbox?.specialUse === "junk";
      let handled = true;
      switch (command) {
        case "close":
          clearSelection();
          break;
        case "markRead":
          flags({ seen: true });
          break;
        case "markUnread":
          flags({ seen: false });
          break;
        case "toggleRead":
          flags({ seen: !checkedRows.every((row) => row.seen) });
          break;
        case "toggleStar":
          flags({ flagged: !checkedRows.every((row) => row.flagged) });
          break;
        case "archive":
          performBulk(checkedRows, { action: "move", destination: "archive" });
          break;
        case "delete":
          deleteRows(checkedRows, skipsDeleteConfirm(event));
          break;
        case "move":
          setBulkMoveRequest((count) => count + 1);
          break;
        case "junk":
          if (inJunk) {
            performBulk(checkedRows, { action: "move", destination: "inbox" });
          } else if (junkAvailable(checkedRows)) {
            performBulk(checkedRows, { action: "move", destination: "junk" });
          }
          break;
        default:
          handled = false;
      }
      if (handled) {
        event.preventDefault();
        return;
      }
    }
    const open = (message: MessageSummary | undefined) => {
      if (!message) return;
      handleSelectMessage(message.id);
      messageListRef.current?.scrollToMessage(message.id);
    };
    /** 一覧に並んでいる行 (会話、または広げた会話の中の 1 通) を開く。 */
    const openItem = (item: ListItem | null) => {
      if (!item || item.kind === "status") return;
      if (item.kind === "row") open(item.message);
      else {
        handleSelectChild(item.parent.id, item.child.id);
        messageListRef.current?.scrollToMessage(item.parent.id, item.child.id);
      }
    };
    // 画面に並んでいる順 (広げた会話の中のメールを含む)。
    const items = flattenRows(list, expandedIds, threadRows);
    const rowAt = selectedMessage
      ? indexOfOpen(items, { rowId: selectedMessage.id, childId: null })
      : -1;
    const childAt =
      selectedMessage && isSingle
        ? indexOfOpen(items, {
            rowId: selectedMessage.id,
            childId: selectedMessageId,
          })
        : -1;
    const at = childAt !== -1 ? childAt : rowAt;

    if (command === "next" || command === "previous") {
      if (list.length === 0) return;
      event.preventDefault();
      openItem(stepItem(items, at, command === "next" ? 1 : -1));
      return;
    }
    const message = list[index];
    if (command === "expandThread" || command === "collapseThread") {
      if (!message || message.threadCount <= 1) return;
      event.preventDefault();
      const expanded = expandedIds.has(message.id);
      if (command === "expandThread") {
        if (!expanded) handleToggleExpand(message.id);
      } else {
        // 中の 1 通を開いていたら、会話の行へ戻ってから閉じる。
        if (isSingle) open(message);
        if (expanded) handleToggleExpand(message.id);
      }
      return;
    }
    if (!message) return;
    event.preventDefault();
    // 一覧の 1 行は会話 1 つ。会話のうち、このフォルダにある分をまとめて操作する。
    // 会話の中の 1 通だけを開いているときは、その 1 通が対象。
    const openChild =
      isSingle && selectedMessageId
        ? {
            id: selectedMessageId,
            ...childFlags(message.id, selectedMessageId),
          }
        : null;
    const id = openChild ? [openChild.id] : message.threadMessageIds;
    const seen = openChild?.seen ?? message.seen;
    const flagged = openChild?.flagged ?? message.flagged;
    // 移動や削除のあとは、続けて操作できるよう隣のメールを開く。
    const neighbor = list[index + 1] ?? list[index - 1];
    const openNeighbor = () => {
      if (openChild) {
        openItem(stepItem(items, at, 1) ?? stepItem(items, at, -1));
      } else open(neighbor);
    };
    switch (command) {
      case "close":
        setSelectedMessageId(null);
        break;
      case "markRead":
        performAction(id, { action: "set_flags", seen: true });
        break;
      case "markUnread":
        performAction(id, { action: "set_flags", seen: false });
        break;
      case "toggleRead":
        performAction(id, { action: "set_flags", seen: !seen });
        break;
      case "toggleStar":
        // 付けるときは最新の 1 通に、外すときは会話のすべてから外す。
        performAction(flagged ? id : [openChild?.id ?? message.id], {
          action: "set_flags",
          flagged: !flagged,
        });
        break;
      case "archive":
        performAction(id, { action: "move", destination: "archive" });
        openNeighbor();
        break;
      case "delete":
        // ごみ箱の中では完全に削除する (Shift+Delete でなければ確認してから)。
        if (isInTrash(message, mailboxes ?? [])) {
          requestAction(
            id,
            { action: "delete" },
            { skipConfirm: skipsDeleteConfirm(event), onDone: openNeighbor },
          );
        } else {
          performAction(id, { action: "move", destination: "trash" });
          openNeighbor();
        }
        break;
      case "move":
        setMoveRequest((count) => count + 1);
        break;
      case "junk":
        if (selectedMailbox?.specialUse === "junk") {
          performAction(id, { action: "move", destination: "inbox" });
          openNeighbor();
        } else if (junkAvailable([message])) {
          performAction(id, { action: "move", destination: "junk" });
          openNeighbor();
        }
        break;
      case "reply":
      case "replyAll":
      case "forward":
        setComposeRequest((current) => ({
          count: (current?.count ?? 0) + 1,
          mode: command,
        }));
        break;
    }
  };
  // 開いているメールの、一覧での前後 (メール表示のスワイプで移る先)。
  // 画面に並んでいる順 (広げた会話の中のメールを含む) で数える。
  const stepItems = useMemo(
    () => flattenRows(messages ?? [], expandedIds, threadRows),
    [messages, expandedIds, threadRows],
  );
  const stepAt = !selectedMessage
    ? -1
    : indexOfOpen(stepItems, {
        rowId: selectedMessage.id,
        childId: isSingle ? selectedMessageId : null,
      });
  const stepTo = (step: 1 | -1) =>
    stepAt === -1 ? null : stepItem(stepItems, stepAt, step);
  const canStep = {
    previous: stepTo(-1) !== null,
    next: stepTo(1) !== null,
  };
  const handleStep = (step: 1 | -1) => {
    const item = stepTo(step);
    if (!item || item.kind === "status") return;
    if (item.kind === "row") {
      handleSelectMessage(item.message.id);
      messageListRef.current?.scrollToMessage(item.message.id);
    } else {
      handleSelectChild(item.parent.id, item.child.id);
      messageListRef.current?.scrollToMessage(item.parent.id, item.child.id);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    // 高さは画面に固定し、一覧と本文をそれぞれの枠の中でスクロールさせる。
    // body は縦並びの flex なので、ここに flex-1 を付けると高さの指定が効かず、
    // メールの件数に合わせてページ全体が伸びてしまう。
    <div className="flex h-[calc(100dvh-var(--titlebar-height))] shrink-0 overflow-hidden">
      {/* 閉じている間も置いておく (スワイプで開く途中に、開き具合に合わせて暗くするため)。 */}
      <button
        ref={backdropRef}
        type="button"
        aria-label="メニューを閉じる"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
        className={cn(
          "fixed inset-0 top-(--titlebar-height) z-30 bg-black/30 md:hidden",
          (!sidebarOpen || standaloneMessage) && "hidden",
        )}
      />
      <aside
        ref={asideRef}
        id="mail-sidebar"
        className={cn(
          "fixed inset-y-0 top-(--titlebar-height) left-0 z-40 w-72 max-w-[85vw] transition-transform md:translate-x-0",
          // 折りたたみ中は細い帯の幅だけを確保し、サイドバーは一覧の上に重ねて出す。
          sidebarFolded
            ? // relative では top がずらす量になるので、タイトルバーの分を 0 に戻す (デスクトップ版で帯が下がっていた)。
              "md:relative md:top-0 md:w-12 md:max-w-none md:shrink-0"
            : "md:static md:z-auto md:w-64",
          sidebarOpen
            ? "translate-x-0"
            : "invisible -translate-x-full md:visible",
          // メール専用のウィンドウでは、サイドバーと一覧を出さない。
          standaloneMessage && "hidden!",
        )}
      >
        {sidebarFolded && (
          <SidebarRail
            className="hidden md:flex"
            accounts={accounts}
            mailboxes={countedMailboxes}
            selectedAccountId={selectedAccountId}
            selectedMailboxId={selectedMailboxId}
            folderView={
              !draftsSelected && special === null && unifiedId === null
            }
            draftCount={visibleDrafts?.length ?? 0}
            draftsSelected={draftsSelected}
            special={special}
            unified={countedUnified}
            selectedUnifiedId={unifiedId}
            onSelectUnified={handleSelectUnified}
            outgoingCount={outgoing.length + queuedSends.length}
            outgoingFailed={
              outgoing.some((mail) => mail.status === "failed") ||
              queuedSends.some((item) => item.error !== null)
            }
            onSelect={handleSelectFolder}
            onSelectDrafts={handleSelectDrafts}
            onSelectSpecial={handleSelectSpecial}
            onCompose={canCompose ? handleNewMail : null}
            onToggleFold={toggleSidebarFolded}
            inert={sidebarPeek}
          />
        )}
        <div
          className={cn(
            "h-full border-r",
            sidebarFolded &&
              "md:absolute md:inset-y-0 md:left-0 md:w-64 md:shadow-xl md:transition-[opacity,translate,visibility] md:duration-150",
            sidebarFolded &&
              !sidebarPeek &&
              "md:pointer-events-none md:invisible md:-translate-x-2 md:opacity-0",
          )}
        >
          <AccountSidebar
            headerStart={
              <SidebarFoldButton
                folded={sidebarFolded}
                onToggle={toggleSidebarFolded}
                className="-ml-2 hidden md:inline-flex"
              />
            }
            user={user}
            accounts={accounts}
            mailboxes={countedMailboxes}
            selectedAccountId={selectedAccountId}
            selectedMailboxId={selectedMailboxId}
            onSelect={handleSelectFolder}
            onReorderAccounts={(ids) => {
              setAccounts(
                (current) =>
                  current && sortAccounts(withSortOrder(current, ids)),
              );
              saveOrder(() => saveAccountOrder(ids));
            }}
            onReorderMailboxes={(ids) => {
              setMailboxes((current) => current && withSortOrder(current, ids));
              saveOrder(() => saveMailboxOrder(ids));
            }}
            menuActions={{
              onMarkAllRead: handleMarkAllRead,
              onResetOrder: (ids) => {
                const reset = new Set(ids);
                setMailboxes(
                  (current) =>
                    current?.map((mailbox) =>
                      reset.has(mailbox.id)
                        ? { ...mailbox, sortOrder: null }
                        : mailbox,
                    ) ?? null,
                );
                saveOrder(() => resetMailboxOrder(ids));
              },
              onSyncNow: (account) => {
                syncAccountNow(account.id).catch(() =>
                  setNotice({ message: SYNC_NOW_ERROR, tone: "error" }),
                );
              },
              onEditSignature: (account) => {
                setSidebarOpen(false);
                setSignatureTarget({ kind: "account", account });
              },
              onDeleteAccount: (account) => {
                setSidebarOpen(false);
                setDeleteTarget(account);
              },
              onOpenSettings: () => handleSelectSpecial("settings"),
              onReauth: handleReauth,
              onCreateFolder: (account, parent) =>
                openFolderDialog({ kind: "create", account, parent }),
              onRenameFolder: (mailbox) =>
                openFolderDialog({ kind: "rename", mailbox }),
              onDeleteFolder: (mailbox) =>
                openFolderDialog({ kind: "delete", mailbox }),
              onCustomizeFolder: (mailbox) => {
                setSidebarOpen(false);
                setCustomizeTarget(mailbox);
              },
            }}
            draftCount={visibleDrafts?.length ?? 0}
            draftsSelected={draftsSelected}
            onSelectDrafts={handleSelectDrafts}
            special={special}
            onSelectSpecial={handleSelectSpecial}
            unified={countedUnified}
            selectedUnifiedId={unifiedId}
            onSelectUnified={handleSelectUnified}
            onReorderViews={(keys) =>
              changeLayout(reorderLayout(unified, keys))
            }
            viewActions={{
              onCreate: () => openUnifiedDialog({ kind: "create" }),
              onEdit: (folder) => openUnifiedDialog({ kind: "edit", folder }),
              onEditBuiltin: openBuiltinDialog,
              onDelete: (folder) =>
                openUnifiedDialog({ kind: "delete", folder }),
              onHide: (key) => changeLayout(setEntryHidden(unified, key, true)),
              onManage: openUnifiedSettings,
            }}
            categoryActions={categoryActions}
            outgoingCount={outgoing.length + queuedSends.length}
            outgoingFailed={
              outgoing.some((mail) => mail.status === "failed") ||
              queuedSends.some((item) => item.error !== null)
            }
            onCompose={
              canCompose
                ? (accountId) => {
                    setSidebarOpen(false);
                    handleNewMail(accountId);
                  }
                : null
            }
            onAdd={() => {
              setSidebarOpen(false);
              setAddOpen(true);
            }}
            onReauth={handleReauth}
            syncStatus={syncStatus}
          />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1">
        {settingsOpen && (
          <SettingsView
            user={user}
            accounts={accounts}
            category={settingsCategory}
            onCategoryChange={setSettingsCategory}
            onMenu={() => setSidebarOpen(true)}
            notificationStatus={notificationStatus}
            notificationBusy={notificationBusy}
            onNotificationChange={handleNotificationChange}
            syncStatus={syncStatus}
            devices={devices}
            onAdd={() => setAddOpen(true)}
            onDelete={setDeleteTarget}
            onEditSignature={(account) =>
              setSignatureTarget({ kind: "account", account })
            }
            onReauth={handleReauth}
            onAccountUpdated={(account) =>
              setAccounts(
                (current) =>
                  current?.map((item) =>
                    item.id === account.id ? account : item,
                  ) ?? null,
              )
            }
            onSignOut={() => {
              // ログアウトしたあとに別の利用者がログインしても、この表示には戻さない。
              window.history.replaceState(null, "", "/");
              void signOut();
            }}
            signatureRules={
              <SignatureRulesSettings
                rules={signatureRules}
                accounts={accounts ?? []}
                onEdit={(rule) => {
                  if (rule.kind === "contact") {
                    setSignatureTarget({
                      kind: "contact",
                      address: {
                        name: rule.label ?? undefined,
                        address: rule.key,
                      },
                      rule,
                      fallbackHtml: null,
                    });
                  } else if (rule.accountId) {
                    setSignatureTarget({
                      kind: "thread",
                      accountId: rule.accountId,
                      threadKey: rule.key,
                      subject: rule.label ?? "",
                      rule,
                      fallbackHtml: null,
                    });
                  }
                }}
                onDelete={(rule) => {
                  deleteSignatureRule(rule.id)
                    .then(() =>
                      updateSignatureRules((current) =>
                        current.filter((item) => item.id !== rule.id),
                      ),
                    )
                    .catch(() =>
                      setNotice({
                        message: SIGNATURE_RULE_DELETE_ERROR,
                        tone: "error",
                      }),
                    );
                }}
              />
            }
            sidebarItems={
              <>
                <UnifiedSettings
                  unified={unified}
                  mailboxes={mailboxes ?? []}
                  onLayoutChange={changeLayout}
                  onCreate={() => openUnifiedDialog({ kind: "create" })}
                  onEdit={(folder) =>
                    openUnifiedDialog({ kind: "edit", folder })
                  }
                  onEditBuiltin={openBuiltinDialog}
                  onDelete={(folder) =>
                    openUnifiedDialog({ kind: "delete", folder })
                  }
                />
                <CategorySettings
                  unified={unified}
                  accounts={accounts ?? []}
                  onCreate={categoryActions.onCreate}
                  onRename={categoryActions.onRename}
                  onDelete={categoryActions.onDelete}
                  onReorder={categoryActions.onReorder}
                />
              </>
            }
          />
        )}
        {/* 一覧とメールの表示。広い画面では横に並べるか、設定で上下に並べる。 */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1",
            messageBelow && "flex-col",
            settingsOpen && "hidden",
          )}
        >
          <section
            aria-label="メール一覧"
            {...{ [SELECT_ALL_SCOPE_ATTRIBUTE]: "" }}
            className={cn(
              "@container/pane relative min-h-0 min-w-0 flex-1 flex-col lg:flex lg:flex-none",
              messageBelow ? "lg:border-b" : "lg:w-96 lg:border-r",
              selectedMessageId ? "hidden" : "flex",
              (settingsOpen || standaloneMessage) && "hidden!",
            )}
            // 一覧の大きさは、メールの表示との境目のつまみで変えられる。右に並べるときは
            // テーブル表示のときだけ幅を、下に並べるときは高さを変える。
            style={
              messageBelow
                ? {
                    height: tableView.paneHeight,
                    minHeight: MIN_PANE_HEIGHT,
                    maxHeight: "calc(100% - 10rem)",
                  }
                : tableShown && wide
                  ? {
                      width: tableView.paneWidth,
                      minWidth: MIN_PANE_WIDTH,
                      maxWidth: "calc(100vw - 40rem)",
                    }
                  : undefined
            }
          >
            {messageBelow ? (
              <PaneResizer
                direction="vertical"
                size={tableView.paneHeight}
                min={MIN_PANE_HEIGHT}
                onChange={(paneHeight) => updateTableView({ paneHeight })}
              />
            ) : (
              tableShown &&
              wide && (
                <PaneResizer
                  direction="horizontal"
                  size={tableView.paneWidth}
                  min={MIN_PANE_WIDTH}
                  onChange={(paneWidth) => updateTableView({ paneWidth })}
                />
              )
            )}
            <div className="flex shrink-0 flex-col">
              {selecting ? (
                <SelectionToolbar
                  rows={checkedRows}
                  total={messages?.length ?? 0}
                  mailbox={selectedMailbox}
                  junkAvailable={junkAvailable(checkedRows)}
                  moveRequest={bulkMoveRequest}
                  onAction={performBulk}
                  permanentDelete={
                    checkedRows.length > 0 &&
                    splitForDelete(checkedRows, mailboxes ?? []).toTrash
                      .length === 0
                  }
                  onDelete={(skipConfirm) =>
                    deleteRows(checkedRows, skipConfirm)
                  }
                  onSelectAll={(checked) =>
                    setCheckedIds(
                      new Set(
                        checked
                          ? (messages ?? []).map((message) => message.id)
                          : [],
                      ),
                    )
                  }
                  onClose={clearSelection}
                />
              ) : showSearch && !medium && (searchScreen || searching) ? (
                // スマホの検索画面。アプリバーを検索欄にする。
                <header className="flex h-14 shrink-0 items-center border-b px-4">
                  {searchBox("screen")}
                </header>
              ) : (
                <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                  {menuButton("-ml-2 pointer-coarse:-ml-2.5")}
                  <h1 className="min-w-0 shrink truncate font-semibold text-lg">
                    {heading}
                  </h1>
                  <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                    {headingNote}
                  </p>
                  <SyncIndicator
                    status={syncStatus}
                    short
                    className="shrink-0 md:hidden"
                  />
                  {!draftsSelected &&
                    special !== "outgoing" &&
                    (messages?.length ?? 0) > 0 && (
                      <Hint label="メールを選択" shortcut="X">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="メールを選択"
                          onClick={() => setSelectMode(true)}
                          // タッチ操作ではボタンが大きくなるので、アイコンの右端が一覧の右端に揃うよう寄せる。
                          className={cn(
                            !(showSearch && !medium) &&
                              !layoutMenu &&
                              !headerSearch &&
                              "-mr-2 pointer-coarse:-mr-2.5",
                          )}
                        >
                          <ListChecksIcon />
                        </Button>
                      </Hint>
                    )}
                  {/* 一覧の表示とメールを表示する場所を選ぶメニュー。 */}
                  {layoutMenu && (
                    <ListLayoutMenu
                      listLayout={preferences.listLayout}
                      readingPane={preferences.readingPane}
                      showReadingPane={wide}
                      className={cn(
                        !headerSearch && "-mr-2 pointer-coarse:-mr-2.5",
                      )}
                    />
                  )}
                  {/* 一覧だけを出す幅では、検索欄を一覧の見出しの右端に置く。 */}
                  {/* メールを下に表示するときも、検索欄は一覧の見出しの右端に置く。 */}
                  {headerSearch && searchBox("popup")}
                  {/* スマホでは、検索は別の画面で行う。 */}
                  {showSearch && !medium && (
                    <Hint label="検索" shortcut="/">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="検索"
                        onClick={openSearchScreen}
                        className="-mr-2 pointer-coarse:-mr-2.5"
                      >
                        <SearchIcon />
                      </Button>
                    </Hint>
                  )}
                </header>
              )}
              {showSearch && searching && search && (
                <SearchScope
                  value={search}
                  onChange={(next) => {
                    setSearchInput(next);
                    setSearch(next);
                  }}
                  folderLabel={
                    selectedMailbox || selectedUnified ? title : "受信トレイ"
                  }
                  className="border-b px-4 py-2"
                />
              )}
            </div>
            {/* 送信できなかったメールは、どの一覧を見ていても知らせる。送信中のものは「送信待ち」に出す。 */}
            {special !== "outgoing" && (
              <OutgoingList
                outgoing={outgoing.filter((mail) => mail.status === "failed")}
                queued={queuedSends.filter((item) => item.error !== null)}
                online={online}
                onEdit={handleEditOutgoing}
                onRemove={handleRemoveOutgoing}
                onEditQueued={handleEditQueued}
                onRemoveQueued={handleRemoveQueued}
              />
            )}
            {/* relative: 読み上げ専用の文言 (sr-only) は絶対配置なので、基準をこの枠にしないと
              枠の外にはみ出した扱いになり、ページ全体がスクロールできてしまう。 */}
            {/* 外側の枠は、引っ張って更新する印 (PullToRefresh) をスクロールさせずに置くためのもの。 */}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <PullToRefresh
                scrollRef={listScrollRef}
                onRefresh={handlePullRefresh}
                disabled={noAccounts || selecting}
              />
              <div
                ref={listScrollRef}
                className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain"
              >
                {noAccounts ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                    <InboxIcon
                      className="size-10 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="flex flex-col gap-1">
                      <h2 className="font-semibold text-lg">
                        メールアカウントを追加しましょう
                      </h2>
                      <p className="text-muted-foreground text-sm">
                        アカウントを追加すると、ここに受信トレイが表示されます。
                      </p>
                    </div>
                    <Button onClick={() => setAddOpen(true)}>
                      <PlusIcon />
                      アカウントを追加
                    </Button>
                  </div>
                ) : special === "outgoing" ? (
                  <OutgoingList
                    full
                    outgoing={outgoing}
                    queued={queuedSends}
                    online={online}
                    onEdit={handleEditOutgoing}
                    onRemove={handleRemoveOutgoing}
                    onReschedule={handleRescheduleOutgoing}
                    onEditQueued={handleEditQueued}
                    onRemoveQueued={handleRemoveQueued}
                  />
                ) : draftsSelected ? (
                  <DraftList
                    drafts={visibleDrafts}
                    accounts={accounts ?? []}
                    openId={draft?.idempotencyKey ?? null}
                    onOpen={handleOpenDraft}
                    onDiscard={(item) => handleDiscardDraft(item.id)}
                  />
                ) : (
                  <MessageList
                    ref={messageListRef}
                    layout={tableShown ? "table" : "cards"}
                    sort={listSort}
                    scrollRef={listScrollRef}
                    onPrefetch={handlePrefetch}
                    onWarm={handleWarm}
                    messages={messages}
                    error={listError}
                    selectedId={
                      isSingle
                        ? null
                        : (selectedMessage?.id ?? selectedMessageId)
                    }
                    selectedChild={
                      isSingle && selectedMessage && selectedMessageId
                        ? { rowId: selectedMessage.id, id: selectedMessageId }
                        : null
                    }
                    expandedIds={expandedIds}
                    threadRows={threadRows}
                    onToggleExpand={handleToggleExpand}
                    onSelectChild={handleSelectChild}
                    checkedIds={checkedIds}
                    selecting={selecting}
                    onToggleCheck={handleToggleCheck}
                    onBandSelect={handleBandSelect}
                    swipeFor={swipeFor}
                    onSwipeMove={setMoveTarget}
                    hasMore={nextCursor !== null}
                    loadingMore={loadingMore}
                    showRecipients={
                      !searching &&
                      (selectedUnified
                        ? unifiedShowsRecipients
                        : showsRecipients(selectedMailbox))
                    }
                    {...(accountMark ? { accountMark } : {})}
                    // テーブル表示では、複数のフォルダのメールが並ぶ一覧 (すべての受信トレイ、
                    // スター付き、検索結果、統合フォルダ) で「場所」の列を使える。
                    {...(starred ||
                    searching ||
                    selectedUnified ||
                    (!selectedAccountId && !selectedMailboxId)
                      ? { tableLocationLabel: locationLabel }
                      : {})}
                    {...(starred
                      ? {
                          emptyText:
                            "スターを付けたメールはありません。スターを付けたメールは、どのフォルダにあってもここに表示されます。",
                          locationLabel,
                        }
                      : searching
                        ? {
                            emptyText:
                              "条件に合うメールは見つかりませんでした。",
                            highlightTerms: searchTerms,
                            locationLabel,
                          }
                        : selectedUnified
                          ? {
                              emptyText:
                                "この統合フォルダの条件に当てはまるメールはありません。",
                              locationLabel,
                            }
                          : selectedMailbox?.lastSyncedAt
                            ? {
                                emptyText: "このフォルダにメールはありません。",
                              }
                            : {})}
                    onSelect={handleSelectMessage}
                    onAction={requestAction}
                    onSelectionAction={handleSelectionMenuAction}
                    onOpenWindow={
                      canOpenWindows() ? openMessageWindow : undefined
                    }
                    onLoadMore={() => void handleLoadMore()}
                    onRetry={() =>
                      void loadFirstPage(selectionRef.current, true)
                    }
                  />
                )}
              </div>
            </div>
            {canCompose && !composeOpen && !selecting && (
              <Button
                onClick={() => handleNewMail()}
                className="absolute right-4 bottom-4 z-10 h-14 gap-2 rounded-2xl px-5 text-base shadow-lg md:hidden [&_svg]:size-5"
              >
                <PenSquareIcon />
                作成
              </Button>
            )}
          </section>

          <section
            aria-label="メールの内容"
            className={cn(
              "@container/pane relative min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex",
              selectedMessageId ? "flex" : "hidden",
              settingsOpen && "hidden!",
            )}
          >
            {selectedMessageId ? (
              <MessageView
                standalone={standaloneMessage}
                messageId={selectedMessageId}
                refreshKey={refreshKey}
                single={isSingle}
                onShowThread={() =>
                  handleSelectMessage(selectedMessage?.id ?? selectedMessageId)
                }
                summary={selectedMessage}
                accounts={accounts ?? []}
                mailboxes={mailboxes ?? []}
                onAction={requestAction}
                moveRequest={moveRequest}
                composeRequest={composeRequest}
                onCompose={handleCompose}
                onQuickReply={handleQuickReply}
                onSearchAddress={handleSearchAddress}
                onComposeTo={handleComposeTo}
                signatureRules={signatureRules}
                onContactSignature={(address, accountId) =>
                  setSignatureTarget({
                    kind: "contact",
                    address,
                    rule: findContactRule(signatureRules, address.address),
                    fallbackHtml: accountSignature(accountId),
                  })
                }
                onThreadSignature={(thread) =>
                  setSignatureTarget({
                    kind: "thread",
                    ...thread,
                    rule: findThreadRule(
                      signatureRules,
                      thread.accountId,
                      thread.threadKey,
                    ),
                    fallbackHtml: accountSignature(thread.accountId),
                  })
                }
                onBack={() => setSelectedMessageId(null)}
                onStep={handleStep}
                // メール専用のウィンドウでは、ほかのメールへは移らない (消したら閉じる)。
                canStep={
                  standaloneMessage ? { previous: false, next: false } : canStep
                }
                onMissing={handleMissing}
                toolbarEnd={
                  showSearch && medium && !standaloneMessage && !messageBelow
                    ? searchBox("popup")
                    : undefined
                }
                findRequest={findRequest}
                printRequest={printRequest}
              />
            ) : (
              <>
                {showSearch && wide && !messageBelow && (
                  <div className="flex h-14 shrink-0 items-center justify-end border-b px-4">
                    {searchBox("popup")}
                  </div>
                )}
                <div className="flex flex-1 items-center justify-center p-8">
                  <p className="text-muted-foreground text-sm">
                    メールを選ぶと、ここに内容が表示されます。
                  </p>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      <AddAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(account) => {
          setAccounts((current) =>
            current?.some((item) => item.id === account.id)
              ? current
              : [...(current ?? []), account],
          );
          void loadMailboxes();
        }}
      />
      <ComposeWindow
        draft={draft}
        open={composeOpen}
        accounts={accounts ?? []}
        signatureRules={signatureRules}
        notice={composeNotice}
        savedAt={draftSavedAt}
        saveProblem={draftSaveProblem}
        contentVersion={draftVersion}
        standalone={standaloneCompose}
        onOpenChange={(open) => {
          if (open) {
            setComposeOpen(true);
            return;
          }
          if (!standaloneCompose) {
            void closeCompose();
            return;
          }
          // 移すためだけに保存した下書きを、何も書かずに閉じたら消す。
          if (composeWindow.fresh && !draftDirty && draft) {
            void closeStandaloneWindow(
              handleDiscardDraft(draft.idempotencyKey),
            );
            return;
          }
          void closeStandaloneWindow(closeCompose());
        }}
        onPopOut={
          canOpenWindows() && !standaloneCompose
            ? () => void popOutCompose()
            : undefined
        }
        onChange={(next) => {
          setDraft(next);
          setDraftDirty(true);
          saverRef.current?.schedule(next);
        }}
        onBeforeSend={async () => {
          if (draft) await saverRef.current?.cancel(draft.idempotencyKey);
        }}
        onSendFailed={() => {
          // 送信の前に止めた保存をやり直す。
          if (draftRef.current) saverRef.current?.schedule(draftRef.current);
        }}
        onSent={(scheduledAt) => {
          if (scheduledAt) {
            setNotice({
              message: `${formatFullDate(scheduledAt, currentDateStyle())} に送信するよう予約しました。送信待ちから変更・取り消しができます。`,
              tone: "info",
            });
          }
          // 送信したメールの下書きは、サーバーが消している。
          if (draft) {
            void saverRef.current?.forget(draft.idempotencyKey);
            dropDraft(draft.idempotencyKey);
          }
          void loadOutgoing();
          if (standaloneCompose) void closeStandaloneWindow();
        }}
        onDiscard={() => {
          if (!draft) return;
          const discarded = handleDiscardDraft(draft.idempotencyKey);
          if (standaloneCompose) void closeStandaloneWindow(discarded);
        }}
      />
      <FailureToast
        failures={failures}
        accounts={accounts ?? []}
        mailboxes={mailboxes ?? []}
        busy={failureBusy}
        onRetry={handleRetryFailures}
        onDismiss={handleDismissFailures}
      />
      <SignatureDialog
        target={signatureTarget}
        onClose={() => setSignatureTarget(null)}
        onRuleSaved={(rule) =>
          updateSignatureRules((current) => [
            ...current.filter((item) => item.id !== rule.id),
            rule,
          ])
        }
        onRuleDeleted={(id) =>
          updateSignatureRules((current) =>
            current.filter((item) => item.id !== id),
          )
        }
        onAccountSaved={(account) =>
          setAccounts(
            (current) =>
              current?.map((item) =>
                item.id === account.id ? account : item,
              ) ?? null,
          )
        }
      />
      <CategoryDialog
        target={categoryDialog}
        onClose={() => setCategoryDialog(null)}
        onSubmit={(target, name) => {
          if (target.kind === "rename") {
            changeCategories((list) =>
              renameCategory(list, target.category.id, name),
            );
          } else {
            const id = randomUuid();
            changeCategories((list) =>
              addCategory(list, { id, name }, target.key),
            );
          }
        }}
      />
      <FolderDialogs
        target={folderDialog}
        onClose={() => setFolderDialog(null)}
        onAccepted={(target) => {
          setNotice({ message: FOLDER_NOTICES[target.kind], tone: "info" });
          // 開いているフォルダを消したら、そのアカウントの受信トレイへ移る。
          if (
            target.kind === "delete" &&
            selectionRef.current.mailboxId === target.mailbox.id
          ) {
            handleSelectFolder(target.mailbox.accountId, null);
          }
        }}
      />
      <MailboxOverridesDialog
        mailbox={customizeTarget}
        mailboxes={mailboxes ?? []}
        onClose={() => setCustomizeTarget(null)}
        onSaved={(mailbox, overrides) => {
          // 名前とアイコンはすぐ反映する。役割は、ほかのフォルダにも関わるので取得し直す。
          setMailboxes(
            (current) =>
              current?.map((item) =>
                item.id === mailbox.id
                  ? {
                      ...item,
                      displayName: overrides.displayName,
                      icon: overrides.icon,
                      color: overrides.color,
                    }
                  : item,
              ) ?? null,
          );
          void loadMailboxes();
        }}
      />
      <PermanentDeleteDialog
        request={deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
      />
      <MoveDialog
        message={moveTarget}
        onMove={(message, mailboxId) =>
          performAction(message.threadMessageIds, { action: "move", mailboxId })
        }
        onClose={() => setMoveTarget(null)}
      />
      <UnifiedDialog
        target={unifiedDialog}
        accounts={accounts ?? []}
        mailboxes={mailboxes ?? []}
        onClose={() => setUnifiedDialog(null)}
        onRequestDelete={(folder) =>
          setUnifiedDialog({ kind: "delete", folder })
        }
        onBuiltinsSaved={(builtins) => {
          setUnified((current) => {
            const next = { ...current, builtins };
            storeCachedUnified(next);
            return next;
          });
        }}
        onSaved={(created) => {
          void loadUnified();
          if (created) {
            // 作ったフォルダは、すぐ開いて中身を確かめられるようにする。
            setUnified((current) => ({
              ...current,
              folders: [...current.folders, created],
            }));
            handleSelectUnified(created.id);
          } else if (selectionRef.current.unifiedId) {
            void loadFirstPage(selectionRef.current, true);
          }
        }}
        onDeleted={(folder) => {
          setUnified((current) => ({
            ...current,
            folders: current.folders.filter((item) => item.id !== folder.id),
          }));
          if (selectionRef.current.unifiedId === folder.id) {
            handleSelectFolder(null, null);
          }
          void loadUnified();
        }}
      />
      <DeleteAccountDialog
        account={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(id) => {
          setAccounts(
            (current) => current?.filter((item) => item.id !== id) ?? null,
          );
          setMailboxes(
            (current) =>
              current?.filter((mailbox) => mailbox.accountId !== id) ?? null,
          );
          if (selectedMessageId || selectedAccountId === id) {
            replaceNextRef.current = true;
          }
          setSelectedMessageId(null);
          if (selectedAccountId === id) {
            setSelectedAccountId(null);
            setSelectedMailboxId(null);
          } else {
            void loadFirstPage(selectionRef.current, true);
          }
        }}
      />
    </div>
  );
});
