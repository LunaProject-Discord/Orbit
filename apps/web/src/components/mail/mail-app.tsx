"use client";

import { cn } from "cn";
import {
  InboxIcon,
  ListChecksIcon,
  MenuIcon,
  PenSquareIcon,
  PlusIcon,
} from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/components/auth-provider";
import { Hint } from "@/components/hint";
import { AccountSidebar } from "@/components/mail/account-sidebar";
import { AddAccountDialog } from "@/components/mail/add-account-dialog";
import { ComposeWindow } from "@/components/mail/compose-window";
import { DeleteAccountDialog } from "@/components/mail/delete-account-dialog";
import { DraftList } from "@/components/mail/draft-list";
import { FailureToast } from "@/components/mail/failure-toast";
import {
  FolderDialogs,
  type FolderDialogTarget,
} from "@/components/mail/folder-dialogs";
import { MailboxOverridesDialog } from "@/components/mail/mailbox-overrides-dialog";
import {
  MessageList,
  type MessageListHandle,
} from "@/components/mail/message-list";
import { MessageView } from "@/components/mail/message-view";
import { MoveDialog } from "@/components/mail/move-dialog";
import { OutgoingList } from "@/components/mail/outgoing-list";
import { SEARCH_INPUT_ID, SearchBar } from "@/components/mail/search-bar";
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
import {
  UNIFIED_SETTINGS_ID,
  UnifiedSettings,
} from "@/components/mail/unified-settings";
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
  resetMailboxOrder,
  retryFailure,
  type SearchParams,
  type ServerDraft,
  type SidebarLayout,
  type SignatureRule,
  saveAccountOrder,
  saveDraft,
  saveMailboxOrder,
  saveSidebarLayout,
  sendFocus,
  startOAuthLogin,
  syncAccountNow,
  type UnifiedState,
  type User,
} from "@/lib/api";
import {
  buildDraftFrom,
  type ComposeDraft,
  type ComposeMode,
  draftFromOutgoing,
  draftFromServer,
  draftSaveInput,
  draftSignature,
  htmlToText,
  loadUnsavedDrafts,
  newDraft,
  removeUnsavedDraft,
  sanitizeHtml,
  storeUnsavedDraft,
  withReplyText,
} from "@/lib/compose";
import { type DraftSaveResult, DraftSaver } from "@/lib/draft-saver";
import { type ServerEvent, subscribeEvents } from "@/lib/events";
import {
  mailboxLabel,
  refreshMailboxes,
  showsRecipients,
  sortAccounts,
  withSortOrder,
} from "@/lib/mailboxes";
import {
  disableNotifications,
  enableNotifications,
  inboxUnreadCount,
  type NotificationStatus,
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
} from "@/lib/offline";
import { usePreferences } from "@/lib/preferences";
import {
  buildRoute,
  historyMode,
  type MailRoute,
  NEW_COMPOSE,
  parseRoute,
  type SpecialView,
  sameSearch,
} from "@/lib/route";
import { emptyFilters, isSearchActive } from "@/lib/search";
import { actionBatches, selectRange, toggleSelection } from "@/lib/selection";
import { isTypingTarget, resolveShortcut } from "@/lib/shortcuts";
import { loadSidebarFolded, storeSidebarFolded } from "@/lib/sidebar-fold";
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
import { randomUuid } from "@/lib/uuid";

const PAGE_SIZE = 50;
/** 表示中のフォルダをサーバーへ知らせる間隔。 */
const FOCUS_INTERVAL_MS = 30_000;
/** 検索欄の入力が止まってから検索を始めるまでの時間。 */
const SEARCH_DELAY_MS = 300;
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
const RETRY_GONE = "対象のメールがすでに無いため、やり直せませんでした。";
const RETRY_ERROR =
  "やり直せませんでした。時間をおいて、もう一度お試しください。";
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

/** 一覧の並び順 (新しい順)。a が b より後ろなら正。 */
function compareMessages(a: MessageSummary, b: MessageSummary): number {
  if (a.receivedAt !== b.receivedAt) {
    return a.receivedAt < b.receivedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 一覧で見ているメールの本文を先に取得するよう頼む。頼めなくても (オフラインなど)
 * 困らないので、失敗は無視する。
 */
function handlePrefetch(ids: string[], reason: "hover" | "visible") {
  void prefetchBodies(ids, reason).catch(() => {});
}

/**
 * 取得し直した先頭ページを、読み込み済みの一覧に反映する。
 * 先頭ページの範囲は新しい内容で置き換え、それより古い読み込み済みの分は残す。
 */
function mergeFirstPage(
  current: MessageSummary[],
  firstPage: MessageSummary[],
  firstPageHasMore: boolean,
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
  const preferences = usePreferences();
  const { signOut } = useAuth();
  // 開いたときの URL が指す表示から始める (再読み込み、ブックマーク、通知から開いた場合)。
  // ログイン画面から移ってきた直後は window.location がまだ前の画面を指していることがあるので、
  // 描画中のページの URL を Next.js から受け取る。
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [initialRoute] = useState(() =>
    parseRoute(`${pathname}?${searchParams.toString()}`),
  );
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
  // 広い画面で左のサイドバーを折りたたんでいるか。スマホ幅では使わない (引き出し式のまま)。
  const [sidebarFolded, setSidebarFolded] = useState(false);
  useLayoutEffect(() => {
    setSidebarFolded(loadSidebarFolded());
  }, []);
  const toggleSidebarFolded = () => {
    storeSidebarFolded(!sidebarFolded);
    setSidebarFolded(!sidebarFolded);
  };
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
  /** 検索結果で目立たせる語 (サーバーが検索欄の入力から求める)。 */
  const [searchTerms, setSearchTerms] = useState<string[]>([]);

  /** 一覧の取得ごとに増やし、古い応答で新しい表示を上書きしないようにする。 */
  const listRequest = useRef(0);
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
  const starred = special === "starred";
  const starredRef = useRef(starred);
  starredRef.current = starred;
  /** 統合フォルダと、サイドバー上部の項目の並び順。 */
  const [unified, setUnified] = useState<UnifiedState>(emptyUnifiedState);
  /** サーバーから統合フォルダを取得し終えたか (無くなったフォルダの URL を見分けるのに使う)。 */
  const [unifiedLoaded, setUnifiedLoaded] = useState(false);
  const [unifiedDialog, setUnifiedDialog] =
    useState<UnifiedDialogTarget | null>(null);
  /** サーバーからの変更通知の接続。null は、まだ一度も繋がっていない。 */
  const [connected, setConnected] = useState<boolean | null>(null);
  /** いまサーバーに接続している端末の数 (この端末を含む)。 */
  const [devices, setDevices] = useState(0);
  /** まだサーバーへ送れていない操作の数。 */
  const [pendingActions, setPendingActions] = useState(0);
  /** 作成画面で開いているメール。閉じると、内容は下書きとしてサーバーに残る。 */
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  /** 開いてから内容を変えたか。変えていない新規のメールは、閉じたら残さない。 */
  const [draftDirty, setDraftDirty] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
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
  /** 履歴を 1 つ戻している途中。戻り終えるまで URL には触らない。 */
  const backPendingRef = useRef(false);
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
    try {
      setMailboxes(await listAllMailboxes());
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
    try {
      const state = await listUnified();
      setUnified(state);
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
      const params = { accountId, mailboxId, cursor, limit: PAGE_SIZE };
      if (starredRef.current) {
        const page = await searchMessages({
          ...starredSearch,
          cursor,
          limit: PAGE_SIZE,
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
          });
          return { page, terms: null };
        }
        const page = await searchMessages({
          ...active,
          unifiedId: unified,
          cursor,
          limit: PAGE_SIZE,
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
        setMessages(null);
        setNextCursor(null);
        setListError(null);
        // サーバーの応答を待たずに、端末に保存してある一覧を先に出す。
        if (!searchRef.current && !starredRef.current && !selection.unifiedId) {
          void cachedMessages(selection, PAGE_SIZE).then((saved) => {
            if (!saved || request !== listRequest.current) return;
            const rows = applyActions(
              saved.messages,
              queueRef.current?.pending() ?? [],
            );
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
        const fetched = applyActions(
          page.messages,
          queueRef.current?.pending() ?? [],
        );
        setMessages((current) =>
          current && !reset
            ? mergeFirstPage(current, fetched, page.nextCursor !== null)
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
    [fetchPage],
  );

  useEffect(() => {
    void loadAccounts();
    void loadMailboxes();
    void loadOutgoing();
    void loadFailures();
    void loadDrafts();
    void loadUnified();
    void refreshSwipeSettings();
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

  // タブの題名に、受信トレイの未読数を出す。
  useEffect(() => {
    showUnreadCount(inboxUnreadCount(mailboxes ?? []));
  }, [mailboxes]);
  useEffect(() => () => showUnreadCount(0), []);

  /** 通知から開く。受信トレイに切り替えて、そのメールを表示する。 */
  const openFromNotification = useCallback((messageId: string | null) => {
    setSidebarOpen(false);
    setDraftsSelected(false);
    setSpecial(null);
    setUnifiedId(null);
    setSearchInput(emptySearch);
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
    const queue = createActionQueue();
    queueRef.current = queue;
    setPendingActions(queue.pending().length);
    const unsubscribeCount = queue.onChange(setPendingActions);
    const unsubscribe = queue.onRejected(() => {
      // 画面に先に反映した内容を取り消すため、サーバーの状態を取り直す。
      setNotice({ message: ACTION_ERROR, tone: "error" });
      void loadFirstPage(selectionRef.current, false);
      void loadMailboxes();
      setRefreshKey((key) => key + 1);
    });
    return () => {
      unsubscribe();
      unsubscribeCount();
      queue.stop();
      queueRef.current = null;
    };
  }, [loadFirstPage, loadMailboxes]);

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
      setMessages((current) => current && applyActions(current, [action]));
      setThreadRows((current) => applyActionToThreads(current, action));
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
    [commitUndo],
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
    const now = selectionRef.current;
    if (
      now.accountId === group.selection.accountId &&
      now.mailboxId === group.selection.mailboxId &&
      now.unifiedId === group.selection.unifiedId
    ) {
      // 一覧を取得し直すのを待たずに、控えておいた行を戻す。
      setMessages(
        (current) =>
          current && restoreRows(current, group.rows, compareMessages),
      );
      // 開いていたメールを操作で閉じていたら、開き直す。
      // (操作のあとに隣のメールへ移っていた場合も、元のメールへ戻る。)
      if (group.openId) setSelectedMessageId(group.openId);
    }
    void loadFirstPage(selectionRef.current, false);
    setRefreshKey((key) => key + 1);
  }, [loadFirstPage]);
  handleUndoRef.current = handleUndo;

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

  /** 選択した行 (会話) にまとめて操作する。 */
  function performBulk(rows: MessageSummary[], input: MessageActionInput) {
    for (const ids of actionBatches(rows)) performAction(ids, input);
    // 移動や削除で一覧から無くなるので、選択も終える。
    if (input.action !== "set_flags") clearSelection();
  }

  // 検索欄の入力が止まったら検索する。入力も条件も無くなったら、すぐに通常の一覧へ戻す。
  useEffect(() => {
    if (!isSearchActive(searchInput)) {
      setSearch(null);
      return;
    }
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DELAY_MS);
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
        void loadAccounts();
        void loadMailboxes();
        void loadOutgoing();
        void loadFailures();
        void loadDrafts();
        void loadUnified();
        void refreshSwipeSettings();
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

  function handleNewMail() {
    const accountId = selectedAccountId ?? accounts?.[0]?.id;
    if (!accountId) return;
    const account = accounts?.find((item) => item.id === accountId);
    showInCompose(newDraft(accountId, account?.signatureHtml), false);
  }

  /** プロフィールカードから、そのアドレス宛ての新しいメールを書き始める。 */
  function handleComposeTo(address: Address, accountId: string) {
    const account = accounts?.find((item) => item.id === accountId);
    if (!account) return;
    const to = { list: [address], text: "" };
    // この相手に署名を決めてあれば、アカウントの署名の代わりに使う。
    const signature = draftSignature(
      { accountId: account.id, to },
      accounts ?? [],
      signatureRules,
    );
    const next = newDraft(account.id, signature.html);
    showInCompose(
      { ...next, to },
      // 宛先を入れてあるので、下書きとして保存する。
      true,
    );
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
    const built = buildDraftFrom(mode, message, accounts ?? [], signatureRules);
    showInCompose(withReplyText(built, text), text.trim() !== "");
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
    const html = sanitizeHtml(reply.html);
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
          html,
          mode: "reply",
          sourceMessageId: message.id,
        },
        [],
      );
    } catch {
      setNotice({ message: QUICK_REPLY_ERROR, tone: "error" });
      return false;
    }
    setNotice({
      message: result === "queued" ? QUICK_REPLY_QUEUED : QUICK_REPLY_SENT,
      tone: "info",
    });
    void loadOutgoing();
    return true;
  }

  /** 作成画面を閉じる。内容を変えていれば、下書きとしてサーバーに残る。 */
  function closeCompose() {
    if (draft && draftDirty) void saverRef.current?.flush();
    setDraft(null);
    setDraftDirty(false);
    setComposeNotice(null);
    setComposeOpen(false);
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
  function handleDiscardDraft(id: string) {
    dropDraft(id);
    void (async () => {
      // 保存の途中なら終わるのを待つ (あとから保存が届いて作り直されないように)。
      await saverRef.current?.forget(id);
      await deleteDraft(id).catch(() => {});
      void loadDrafts();
    })();
  }

  function handleEditOutgoing(mail: OutgoingMail) {
    // 内容は下書きに移すので、すぐに保存の対象にする。
    showInCompose(draftFromOutgoing(mail), true);
    handleRemoveOutgoing(mail);
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

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    const request = listRequest.current;
    setLoadingMore(true);
    try {
      const { page } = await fetchPage(selectionRef.current, nextCursor);
      if (request !== listRequest.current) return;
      const fetched = applyActions(
        page.messages,
        queueRef.current?.pending() ?? [],
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
    setSearch(null);
    clearSelection();
    anchorRef.current = null;
    setDraftsSelected(false);
    setUnifiedId(null);
    setSelectedAccountId(null);
    setSelectedMailboxId(null);
    setSpecial(view);
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
    single: single !== null && single.messageId === selectedMessageId,
    composeId: openComposeId ?? composeTarget,
    search,
  });

  // 表示が変わったら URL に反映する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeSync は照らし合わせ直すきっかけとして使う
  useEffect(() => {
    if (backPendingRef.current) return;
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
        backPendingRef.current = true;
        window.history.back();
        return;
      }
      mode = "replace";
    }
    if (mode === "push") {
      window.history.pushState({ mailFrom: currentUrl }, "", routeUrl);
    } else {
      window.history.replaceState({ mailFrom: from }, "", routeUrl);
    }
  }, [routeUrl, routeSync]);

  /** URL が指す表示に切り替える (ブラウザーの「戻る」「進む」)。 */
  const applyRouteRef = useRef<(route: MailRoute) => void>(() => {});
  applyRouteRef.current = (route) => {
    setSidebarOpen(false);
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
      if (backPendingRef.current) {
        // 自分で戻した分。表示はすでに変えてあるので、URL と合っているかだけ確かめる。
        backPendingRef.current = false;
        setRouteSync((count) => count + 1);
        return;
      }
      applyRouteRef.current(
        parseRoute(`${window.location.pathname}${window.location.search}`),
      );
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
    // 設定画面が出てから、統合フォルダの節までスクロールする。
    setTimeout(() => {
      document
        .getElementById(UNIFIED_SETTINGS_ID)
        ?.scrollIntoView({ block: "start" });
    }, 50);
  };
  const openUnifiedDialog = (target: UnifiedDialogTarget) => {
    setSidebarOpen(false);
    setUnifiedDialog(target);
  };
  const openBuiltinDialog = (view: BuiltinView) =>
    openUnifiedDialog({
      kind: "builtin",
      view,
      style: builtinStyle(unified, view),
    });
  /** フォルダの未読をすべて既読にする。画面にはすぐ反映し、失敗したらサーバーの状態に戻す。 */
  const handleMarkAllRead = (target: MailboxSummary) => {
    setMailboxes(
      (current) =>
        current?.map((mailbox) =>
          mailbox.id === target.id ? { ...mailbox, unreadCount: 0 } : mailbox,
        ) ?? null,
    );
    setMessages(
      (current) =>
        current?.map((message) =>
          message.mailboxId === target.id && !message.seen
            ? { ...message, seen: true }
            : message,
        ) ?? null,
    );
    markMailboxRead(target.id).catch(() => {
      setNotice({ message: MARK_READ_ERROR, tone: "error" });
      void loadMailboxes();
      void loadFirstPage(selectionRef.current, false);
    });
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
   * どのアカウントのメールかを、アカウントの印 (設定したアイコンか色の点) で示す。
   */
  const accountMark =
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
      : undefined;
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
  /** 検索結果の各行に出す、メールのある場所。アカウントを選んでいなければアカウント名も添える。 */
  const locationLabel = (message: MessageSummary): string | null => {
    const mailbox = mailboxes?.find((item) => item.id === message.mailboxId);
    if (!mailbox) return null;
    const account = selectedAccountId
      ? null
      : accounts?.find((item) => item.id === message.accountId);
    const name = account ? account.displayName || account.email : null;
    return name ? `${name} · ${mailboxLabel(mailbox)}` : mailboxLabel(mailbox);
  };

  // 開いているメールを含む行。会話に新しいメールが届いて行の代表が替わっても、同じ行を指す。
  // 会話の中の 1 通だけを開いているときは、その会話の行。
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

  /** 広げた会話の中の 1 通の、既読とスター。中身をまだ取得していなければ空。 */
  const childFlags = (rowId: string, childId: string) => {
    const thread = threadRows.get(rowId);
    const child = Array.isArray(thread)
      ? thread.find((item) => item.id === childId)
      : undefined;
    return child ? { seen: child.seen, flagged: child.flagged } : {};
  };

  // ショートカットキー。処理は毎回の描画で作り直し、最新の一覧と選択を使う。
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (event) => {
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
      const input = document.getElementById(SEARCH_INPUT_ID);
      if (!(input instanceof HTMLInputElement)) return;
      event.preventDefault();
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
      const inTrash = selectedMailbox?.specialUse === "trash";
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
          performBulk(
            checkedRows,
            inTrash
              ? { action: "delete" }
              : { action: "move", destination: "trash" },
          );
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
        performAction(id, { action: "move", destination: "trash" });
        openNeighbor();
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
    <div className="flex h-dvh shrink-0 overflow-hidden">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="メニューを閉じる"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}
      <aside
        ref={asideRef}
        id="mail-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transition-transform md:translate-x-0",
          // 折りたたみ中は細い帯の幅だけを確保し、サイドバーは一覧の上に重ねて出す。
          sidebarFolded
            ? "md:relative md:w-12 md:max-w-none md:shrink-0"
            : "md:static md:z-auto md:w-64",
          sidebarOpen
            ? "translate-x-0"
            : "invisible -translate-x-full md:visible",
        )}
      >
        {sidebarFolded && (
          <SidebarRail
            className="hidden md:flex"
            accounts={accounts}
            mailboxes={mailboxes}
            selectedAccountId={selectedAccountId}
            folderView={
              !draftsSelected && special === null && unifiedId === null
            }
            draftCount={visibleDrafts?.length ?? 0}
            draftsSelected={draftsSelected}
            special={special}
            unified={unified}
            selectedUnifiedId={unifiedId}
            onSelectUnified={handleSelectUnified}
            onCreateUnified={() => openUnifiedDialog({ kind: "create" })}
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
            mailboxes={mailboxes}
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
            unified={unified}
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
            outgoingCount={outgoing.length + queuedSends.length}
            outgoingFailed={
              outgoing.some((mail) => mail.status === "failed") ||
              queuedSends.some((item) => item.error !== null)
            }
            onCompose={
              canCompose
                ? () => {
                    setSidebarOpen(false);
                    handleNewMail();
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
              <UnifiedSettings
                unified={unified}
                mailboxes={mailboxes ?? []}
                onLayoutChange={changeLayout}
                onCreate={() => openUnifiedDialog({ kind: "create" })}
                onEdit={(folder) => openUnifiedDialog({ kind: "edit", folder })}
                onEditBuiltin={openBuiltinDialog}
                onDelete={(folder) =>
                  openUnifiedDialog({ kind: "delete", folder })
                }
              />
            }
          />
        )}
        <section
          aria-label="メール一覧"
          className={cn(
            "relative min-h-0 min-w-0 flex-1 flex-col lg:flex lg:w-96 lg:flex-none lg:border-r",
            selectedMessageId ? "hidden" : "flex",
            settingsOpen && "hidden!",
          )}
        >
          {/* 狭い画面では、検索欄を上、見出しを下に置く。 */}
          <div className="flex shrink-0 flex-col-reverse md:flex-col">
            {selecting ? (
              <SelectionToolbar
                rows={checkedRows}
                total={messages?.length ?? 0}
                mailbox={selectedMailbox}
                junkAvailable={junkAvailable(checkedRows)}
                moveRequest={bulkMoveRequest}
                onAction={performBulk}
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
            ) : (
              <header
                className={cn(
                  "flex h-14 shrink-0 items-center gap-2 border-b px-4",
                  showSearch && "max-md:h-11",
                )}
              >
                {/* 検索欄を出している間は、メニューのボタンは検索欄の横に置く。 */}
                {!showSearch && menuButton("-ml-2 pointer-coarse:-ml-2.5")}
                <h1 className="min-w-0 truncate font-semibold text-lg">
                  {title}
                </h1>
                <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                  {subtitle}
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
                        className="-mr-2 pointer-coarse:-mr-2.5"
                      >
                        <ListChecksIcon />
                      </Button>
                    </Hint>
                  )}
              </header>
            )}
            {showSearch && (
              <div className="flex items-start md:block">
                {menuButton("mt-3 ml-2 pointer-coarse:ml-1.5")}
                <SearchBar
                  value={searchInput}
                  onChange={setSearchInput}
                  placeholder={
                    accountName
                      ? `${accountName} から検索`
                      : "すべてのアカウントから検索"
                  }
                  folderLabel={
                    selectedMailbox || selectedUnified ? title : "受信トレイ"
                  }
                  className="min-w-0 flex-1 max-md:border-b-0 max-md:pb-1 max-md:pl-2 max-md:[&_input]:rounded-full"
                />
              </div>
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
          <div
            ref={listScrollRef}
            className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
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
                scrollRef={listScrollRef}
                onPrefetch={handlePrefetch}
                messages={messages}
                error={listError}
                selectedId={
                  isSingle ? null : (selectedMessage?.id ?? selectedMessageId)
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
                {...(starred
                  ? {
                      emptyText:
                        "スターを付けたメールはありません。スターを付けると、どのフォルダにあってもここに並びます。",
                      locationLabel,
                    }
                  : searching
                    ? {
                        emptyText: "条件に合うメールは見つかりませんでした。",
                        highlightTerms: searchTerms,
                        locationLabel,
                      }
                    : selectedUnified
                      ? {
                          emptyText:
                            "この統合フォルダに当てはまるメールはありません。",
                          locationLabel,
                        }
                      : selectedMailbox?.lastSyncedAt
                        ? { emptyText: "このフォルダにメールはありません。" }
                        : {})}
                onSelect={handleSelectMessage}
                onAction={performAction}
                onLoadMore={() => void handleLoadMore()}
                onRetry={() => void loadFirstPage(selectionRef.current, true)}
              />
            )}
          </div>
          {canCompose && !composeOpen && !selecting && (
            <Button
              onClick={handleNewMail}
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
            "relative min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex",
            selectedMessageId ? "flex" : "hidden",
            settingsOpen && "hidden!",
          )}
        >
          {selectedMessageId ? (
            <MessageView
              messageId={selectedMessageId}
              refreshKey={refreshKey}
              single={isSingle}
              onShowThread={() =>
                handleSelectMessage(selectedMessage?.id ?? selectedMessageId)
              }
              summary={selectedMessage}
              accounts={accounts ?? []}
              mailboxes={mailboxes ?? []}
              onAction={performAction}
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
              canStep={canStep}
              onMissing={handleMissing}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <p className="text-muted-foreground text-sm">
                メールを選ぶと、ここに内容が表示されます。
              </p>
            </div>
          )}
        </section>
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
        onOpenChange={(open) => {
          if (open) setComposeOpen(true);
          else closeCompose();
        }}
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
        onSent={() => {
          // 送信したメールの下書きは、サーバーが消している。
          if (draft) {
            void saverRef.current?.forget(draft.idempotencyKey);
            dropDraft(draft.idempotencyKey);
          }
          void loadOutgoing();
        }}
        onDiscard={() => {
          if (draft) handleDiscardDraft(draft.idempotencyKey);
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
}
