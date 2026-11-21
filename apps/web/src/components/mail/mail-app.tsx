"use client";

import { cn } from "cn";
import {
  InboxIcon,
  ListChecksIcon,
  MenuIcon,
  PenLineIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { AccountSidebar } from "@/components/mail/account-sidebar";
import { AddAccountDialog } from "@/components/mail/add-account-dialog";
import { ComposeWindow } from "@/components/mail/compose-window";
import { DeleteAccountDialog } from "@/components/mail/delete-account-dialog";
import { MessageList } from "@/components/mail/message-list";
import { MessageView } from "@/components/mail/message-view";
import { OutgoingList } from "@/components/mail/outgoing-list";
import { SEARCH_INPUT_ID, SearchBar } from "@/components/mail/search-bar";
import { SelectionToolbar } from "@/components/mail/selection-toolbar";
import { SignatureDialog } from "@/components/mail/signature-dialog";
import { Button } from "@/components/ui/button";
import {
  type ActionQueue,
  applyActions,
  createActionQueue,
  type MessageActionInput,
} from "@/lib/actions";
import {
  type Account,
  deleteOutgoing,
  listAccounts,
  listAllMailboxes,
  listMessages,
  listOutgoing,
  type MailboxSummary,
  type MessageAction,
  type MessageDetail,
  type MessageSummary,
  type OutgoingMail,
  oauthProviderOf,
  type SearchParams,
  saveAccountOrder,
  saveMailboxOrder,
  searchMessages,
  sendFocus,
  startOAuthLogin,
  type User,
} from "@/lib/api";
import {
  buildDraftFrom,
  type ComposeDraft,
  type ComposeMode,
  draftFromOutgoing,
  loadStoredDraft,
  newDraft,
  storeDraft,
} from "@/lib/compose";
import { subscribeEvents } from "@/lib/events";
import {
  mailboxLabel,
  showsRecipients,
  sortAccounts,
  withSortOrder,
} from "@/lib/mailboxes";
import { emptyFilters, isSearchActive } from "@/lib/search";
import { actionBatches, selectRange, toggleSelection } from "@/lib/selection";
import { isTypingTarget, resolveShortcut } from "@/lib/shortcuts";

const PAGE_SIZE = 50;
/** 表示中のフォルダをサーバーへ知らせる間隔。 */
const FOCUS_INTERVAL_MS = 30_000;
/** 検索欄の入力が止まってから検索を始めるまでの時間。 */
const SEARCH_DELAY_MS = 300;
const LIST_ERROR = "メールを読み込めませんでした。";
const SEARCH_ERROR = "検索できませんでした。";
const emptySearch: SearchParams = {
  text: "",
  filters: emptyFilters,
  scope: "all",
};
const ACTION_ERROR =
  "操作を反映できませんでした。一覧を最新の状態に戻しました。";
const ORDER_ERROR = "並び順を保存できませんでした。元の順番に戻しました。";
const DRAFT_NOTICE =
  "書きかけのメールがあります。送信するか破棄すると、新しいメールを作成できます。";

/** 表示する一覧。mailboxId が null なら受信トレイ (accountId も null なら全アカウント分)。 */
type Selection = { accountId: string | null; mailboxId: string | null };

/** 一覧の並び順 (新しい順)。a が b より後ろなら正。 */
function compareMessages(a: MessageSummary, b: MessageSummary): number {
  if (a.receivedAt !== b.receivedAt) {
    return a.receivedAt < b.receivedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
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

export function MailApp({ user }: { user: User }) {
  const { signOut } = useAuth();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null,
  );
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(
    null,
  );
  const [mailboxes, setMailboxes] = useState<MailboxSummary[] | null>(null);
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [signatureTarget, setSignatureTarget] = useState<Account | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /** 検索欄の内容。 */
  const [searchInput, setSearchInput] = useState<SearchParams>(emptySearch);
  /** 実行中の検索 (入力が止まってから反映する)。null なら通常の一覧を表示する。 */
  const [search, setSearch] = useState<SearchParams | null>(null);
  const searchRef = useRef<SearchParams | null>(null);
  searchRef.current = search;
  /** 検索結果で目立たせる語 (サーバーが検索欄の入力から求める)。 */
  const [searchTerms, setSearchTerms] = useState<string[]>([]);

  /** 一覧の取得ごとに増やし、古い応答で新しい表示を上書きしないようにする。 */
  const listRequest = useRef(0);
  const selectionRef = useRef<Selection>({ accountId: null, mailboxId: null });
  selectionRef.current = {
    accountId: selectedAccountId,
    mailboxId: selectedMailboxId,
  };
  /** サーバーへ送る操作の待ち行列。通信できない間の操作もここに残る。 */
  const queueRef = useRef<ActionQueue | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  /** 作成中のメール。作成画面を閉じても、送信するか破棄するまで残す。 */
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeNotice, setComposeNotice] = useState<string | null>(null);
  /** 下書きをこの端末に保存した時刻。 */
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  /** 表示中のメールへの返信・転送の依頼 (ショートカットキー用)。 */
  const [composeRequest, setComposeRequest] = useState<{
    count: number;
    mode: Exclude<ComposeMode, "new">;
  } | null>(null);
  /** まだ送り終えていないメール (送信中、やり直し待ち、失敗)。 */
  const [outgoing, setOutgoing] = useState<OutgoingMail[]>([]);

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
    } catch {
      // 一覧は次の通知や操作でまた取得する。
    }
  }, []);

  /** 並び順の保存は、操作した順に 1 つずつ送る。失敗したらサーバーの順に戻す。 */
  const orderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveOrder = (save: () => Promise<void>) => {
    setActionError(null);
    orderQueueRef.current = orderQueueRef.current.then(save).catch(() => {
      setActionError(ORDER_ERROR);
      void loadAccounts();
      void loadMailboxes();
    });
  };

  const loadOutgoing = useCallback(async () => {
    try {
      setOutgoing(await listOutgoing());
    } catch {
      // 次の通知や操作でまた取得する。
    }
  }, []);

  /** 一覧を 1 ページ取得する。検索中は検索結果、そうでなければ表示中のフォルダ。 */
  const fetchPage = useCallback(
    async ({ accountId, mailboxId }: Selection, cursor: string | null) => {
      const params = { accountId, mailboxId, cursor, limit: PAGE_SIZE };
      const active = searchRef.current;
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
        setListError(searchRef.current ? SEARCH_ERROR : LIST_ERROR);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void loadAccounts();
    void loadMailboxes();
    void loadOutgoing();
  }, [loadAccounts, loadMailboxes, loadOutgoing]);

  // 前回この端末で書きかけていたメールがあれば、続きから書けるようにする。
  useEffect(() => {
    const stored = loadStoredDraft();
    if (!stored) return;
    setDraft(stored);
    setDraftDirty(true);
  }, []);

  // 書きかけのメールを、入力が止まったらこの端末に保存する。
  useEffect(() => {
    if (!draft || !draftDirty) return;
    const timer = setTimeout(() => {
      if (storeDraft(draft)) setDraftSavedAt(new Date());
    }, 800);
    // 保存を待っている間にページを閉じたり再読み込みしたりしても、内容を失わない。
    const flush = () => storeDraft(draft);
    window.addEventListener("pagehide", flush);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [draft, draftDirty]);

  useEffect(() => {
    const queue = createActionQueue();
    queueRef.current = queue;
    const unsubscribe = queue.onRejected(() => {
      // 画面に先に反映した内容を取り消すため、サーバーの状態を取り直す。
      setActionError(ACTION_ERROR);
      void loadFirstPage(selectionRef.current, false);
      void loadMailboxes();
      setRefreshKey((key) => key + 1);
    });
    return () => {
      unsubscribe();
      queue.stop();
      queueRef.current = null;
    };
  }, [loadFirstPage, loadMailboxes]);

  /** 操作を画面にすぐ反映し、サーバーへは待ち行列から送る。 */
  const performAction = useCallback(
    (messageIds: string[], input: MessageActionInput) => {
      const action: MessageAction = {
        idempotencyKey: crypto.randomUUID(),
        messageIds,
        ...input,
      };
      setActionError(null);
      setMessages((current) => current && applyActions(current, [action]));
      if (input.action !== "set_flags") {
        setSelectedMessageId((current) =>
          current && messageIds.includes(current) ? null : current,
        );
      }
      queueRef.current?.enqueue(action);
    },
    [],
  );

  /** メールを開く。既読にするのは、会話を読み込んだ本文側が行う。 */
  function handleSelectMessage(id: string) {
    setSelectedMessageId(id);
    anchorRef.current = id;
  }

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: search は読み込み直すきっかけとして使う (中身は searchRef から読む)
  useEffect(() => {
    void loadFirstPage(
      { accountId: selectedAccountId, mailboxId: selectedMailboxId },
      true,
    );
  }, [selectedAccountId, selectedMailboxId, search, loadFirstPage]);

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
      setSelectedMailboxId(null);
      setSelectedMessageId(null);
    }
  }, [mailboxes, selectedMailboxId]);

  // サーバーからの変更通知で、アカウントとフォルダの一覧、表示中の一覧を取得し直す。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const unsubscribe = subscribeEvents((event) => {
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
        void loadFirstPage(selectionRef.current, false);
        setRefreshKey((key) => key + 1);
      }, 300);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [loadAccounts, loadMailboxes, loadFirstPage, loadOutgoing]);

  /** 作成画面を開く。書きかけのメールがあれば、上書きせずにそちらを開く。 */
  function openCompose(create: () => ComposeDraft | null) {
    if (draft && draftDirty) {
      setComposeNotice(DRAFT_NOTICE);
    } else {
      const next = create();
      if (!next) return;
      setDraft(next);
      setDraftDirty(false);
      setDraftSavedAt(null);
      setComposeNotice(null);
    }
    setComposeOpen(true);
  }

  function handleNewMail() {
    if (draft) {
      // 「作成」は、書きかけがあればその続きを開く。
      setComposeNotice(null);
      setComposeOpen(true);
      return;
    }
    openCompose(() => {
      const accountId = selectedAccountId ?? accounts?.[0]?.id;
      if (!accountId) return null;
      const account = accounts?.find((item) => item.id === accountId);
      return newDraft(accountId, account?.signatureHtml);
    });
  }

  const handleCompose = (
    mode: Exclude<ComposeMode, "new">,
    message: MessageDetail,
  ) => {
    openCompose(() => buildDraftFrom(mode, message, accounts ?? []));
  };

  function clearDraft() {
    storeDraft(null);
    setDraftSavedAt(null);
    setDraft(null);
    setDraftDirty(false);
    setComposeNotice(null);
    setComposeOpen(false);
  }

  function handleEditOutgoing(mail: OutgoingMail) {
    if (draft && draftDirty) {
      setComposeNotice(DRAFT_NOTICE);
      setComposeOpen(true);
      return;
    }
    setDraftSavedAt(null);
    setDraft(draftFromOutgoing(mail));
    // 内容は下書きに移したので、閉じただけで消えないよう書きかけとして扱う。
    setDraftDirty(true);
    setComposeNotice(null);
    setComposeOpen(true);
    handleRemoveOutgoing(mail);
  }

  function handleRemoveOutgoing(mail: OutgoingMail) {
    setOutgoing((current) => current.filter((item) => item.id !== mail.id));
    // 送信が始まっていて取り消せなかった場合などは、取得し直して実際の状態を出す。
    deleteOutgoing(mail.id)
      .catch(() => {})
      .finally(() => void loadOutgoing());
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
    // フォルダを選んだら検索を終えて、そのフォルダの一覧を表示する。
    setSearchInput(emptySearch);
    setSearch(null);
    clearSelection();
    anchorRef.current = null;
    setSelectedAccountId(accountId);
    setSelectedMailboxId(mailboxId);
  }

  const handleMissing = useCallback(() => setSelectedMessageId(null), []);

  const selectedAccount =
    accounts?.find((account) => account.id === selectedAccountId) ?? null;
  const selectedMailbox =
    mailboxes?.find((mailbox) => mailbox.id === selectedMailboxId) ?? null;
  const accountName = selectedAccount
    ? selectedAccount.displayName || selectedAccount.email
    : null;
  const title = selectedMailbox
    ? mailboxLabel(selectedMailbox)
    : (accountName ?? "すべての受信トレイ");
  /** フォルダを表示している間は、どのアカウントのフォルダかを添える。 */
  const subtitle = selectedMailbox ? accountName : null;
  const noAccounts = accounts !== null && accounts.length === 0;
  const searching = search !== null;
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
  const selectedMessage =
    (selectedMessageId &&
      messages?.find(
        (message) =>
          message.id === selectedMessageId ||
          message.threadMessageIds.includes(selectedMessageId),
      )) ||
    null;
  const checkedRows = (messages ?? []).filter((message) =>
    checkedIds.has(message.id),
  );
  const selecting = selectMode || checkedRows.length > 0;

  // ショートカットキー。処理は毎回の描画で作り直し、最新の一覧と選択を使う。
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (event) => {
    const command = resolveShortcut(event);
    if (!command || isTypingTarget(event.target)) return;
    // ダイアログやメニューを開いている間は、そちらのキー操作を優先する。
    if (document.querySelector('[role="dialog"], [role="menu"]')) return;
    if (command === "compose") {
      event.preventDefault();
      handleNewMail();
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
      document
        .querySelector(`[data-message-id="${message.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };

    if (command === "next" || command === "previous") {
      if (list.length === 0) return;
      event.preventDefault();
      if (index === -1) open(list[0]);
      else open(list[command === "next" ? index + 1 : index - 1]);
      return;
    }
    const message = list[index];
    if (!message) return;
    event.preventDefault();
    // 一覧の 1 行は会話 1 つ。会話のうち、このフォルダにある分をまとめて操作する。
    const id = message.threadMessageIds;
    // 移動や削除のあとは、続けて操作できるよう隣のメールを開く。
    const neighbor = list[index + 1] ?? list[index - 1];
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
        performAction(id, { action: "set_flags", seen: !message.seen });
        break;
      case "toggleStar":
        // 付けるときは最新の 1 通に、外すときは会話のすべてから外す。
        performAction(message.flagged ? id : [message.id], {
          action: "set_flags",
          flagged: !message.flagged,
        });
        break;
      case "archive":
        performAction(id, { action: "move", destination: "archive" });
        open(neighbor);
        break;
      case "delete":
        performAction(id, { action: "move", destination: "trash" });
        open(neighbor);
        break;
      case "move":
        setMoveRequest((count) => count + 1);
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
        id="mail-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] border-r transition-transform md:static md:z-auto md:w-64 md:translate-x-0",
          sidebarOpen
            ? "translate-x-0"
            : "invisible -translate-x-full md:visible",
        )}
      >
        <AccountSidebar
          user={user}
          accounts={accounts}
          mailboxes={mailboxes}
          selectedAccountId={selectedAccountId}
          selectedMailboxId={selectedMailboxId}
          onSelect={handleSelectFolder}
          onReorderAccounts={(ids) => {
            setAccounts(
              (current) => current && sortAccounts(withSortOrder(current, ids)),
            );
            saveOrder(() => saveAccountOrder(ids));
          }}
          onReorderMailboxes={(ids) => {
            setMailboxes((current) => current && withSortOrder(current, ids));
            saveOrder(() => saveMailboxOrder(ids));
          }}
          onAdd={() => {
            setSidebarOpen(false);
            setAddOpen(true);
          }}
          onDelete={(account) => {
            setSidebarOpen(false);
            setDeleteTarget(account);
          }}
          onEditSignature={(account) => {
            setSidebarOpen(false);
            setSignatureTarget(account);
          }}
          onReauth={(account) => {
            const provider = oauthProviderOf(account);
            if (!provider) return;
            startOAuthLogin(provider, account.id)
              .then((url) => window.location.assign(url))
              .catch(() => {
                // 失敗してもサイドバーの表示はそのままなので、もう一度押せる。
              });
          }}
          onSignOut={() => void signOut()}
        />
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1">
        <section
          aria-label="メール一覧"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col lg:flex lg:w-96 lg:flex-none lg:border-r",
            selectedMessageId ? "hidden" : "flex",
          )}
        >
          {selecting ? (
            <SelectionToolbar
              rows={checkedRows}
              total={messages?.length ?? 0}
              mailbox={selectedMailbox}
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
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="メニューを開く"
                aria-controls="mail-sidebar"
                aria-expanded={sidebarOpen}
                onClick={() => setSidebarOpen(true)}
                className="-ml-2 md:hidden"
              >
                <MenuIcon />
              </Button>
              <h1 className="min-w-0 truncate font-semibold text-lg">
                {title}
              </h1>
              <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                {subtitle}
              </p>
              {!noAccounts && accounts !== null && (
                <Button size="sm" onClick={handleNewMail}>
                  <PenLineIcon />
                  {draft ? "下書きを開く" : "作成"}
                </Button>
              )}
              {(messages?.length ?? 0) > 0 && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="メールを選択"
                  title="メールを選択 (X)"
                  onClick={() => setSelectMode(true)}
                  className="-mr-2"
                >
                  <ListChecksIcon />
                </Button>
              )}
            </header>
          )}
          {!noAccounts && accounts !== null && (
            <SearchBar
              value={searchInput}
              onChange={setSearchInput}
              placeholder={
                accountName
                  ? `${accountName} から検索`
                  : "すべてのアカウントから検索"
              }
              folderLabel={selectedMailbox ? title : "受信トレイ"}
            />
          )}
          <OutgoingList
            outgoing={outgoing}
            onEdit={handleEditOutgoing}
            onRemove={handleRemoveOutgoing}
          />
          {actionError && (
            <p
              role="alert"
              className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
            >
              {actionError}
            </p>
          )}
          {/* relative: 読み上げ専用の文言 (sr-only) は絶対配置なので、基準をこの枠にしないと
              枠の外にはみ出した扱いになり、ページ全体がスクロールできてしまう。 */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
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
            ) : (
              <MessageList
                messages={messages}
                error={listError}
                selectedId={selectedMessage?.id ?? selectedMessageId}
                checkedIds={checkedIds}
                selecting={selecting}
                onToggleCheck={handleToggleCheck}
                hasMore={nextCursor !== null}
                loadingMore={loadingMore}
                showRecipients={!searching && showsRecipients(selectedMailbox)}
                {...(searching
                  ? {
                      emptyText: "条件に合うメールは見つかりませんでした。",
                      highlightTerms: searchTerms,
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
        </section>

        <section
          aria-label="メールの内容"
          className={cn(
            "relative min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex",
            selectedMessageId ? "flex" : "hidden",
          )}
        >
          {selectedMessageId ? (
            <MessageView
              messageId={selectedMessageId}
              refreshKey={refreshKey}
              summary={selectedMessage}
              onAction={performAction}
              moveRequest={moveRequest}
              composeRequest={composeRequest}
              onCompose={handleCompose}
              onBack={() => setSelectedMessageId(null)}
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
        notice={composeNotice}
        savedAt={draftSavedAt}
        onOpenChange={(open) => {
          setComposeOpen(open);
          if (!open) {
            setComposeNotice(null);
            // 何も書いていない下書きは残さない。
            if (!draftDirty) setDraft(null);
          }
        }}
        onChange={(next) => {
          setDraft(next);
          setDraftDirty(true);
        }}
        onSent={() => {
          clearDraft();
          void loadOutgoing();
        }}
        onDiscard={clearDraft}
      />
      <SignatureDialog
        account={signatureTarget}
        onClose={() => setSignatureTarget(null)}
        onSaved={(account) =>
          setAccounts(
            (current) =>
              current?.map((item) =>
                item.id === account.id ? account : item,
              ) ?? null,
          )
        }
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
