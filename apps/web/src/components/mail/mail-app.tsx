"use client";

import { cn } from "cn";
import { InboxIcon, MenuIcon, PenLineIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { AccountSidebar } from "@/components/mail/account-sidebar";
import { AddAccountDialog } from "@/components/mail/add-account-dialog";
import { ComposeDialog } from "@/components/mail/compose-dialog";
import { DeleteAccountDialog } from "@/components/mail/delete-account-dialog";
import { MessageList } from "@/components/mail/message-list";
import { MessageView } from "@/components/mail/message-view";
import { OutgoingList } from "@/components/mail/outgoing-list";
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
  listMessages,
  listOutgoing,
  type MessageAction,
  type MessageDetail,
  type MessageSummary,
  type OutgoingMail,
  startMicrosoftLogin,
  type User,
} from "@/lib/api";
import {
  bodyTextOf,
  buildDraftFrom,
  type ComposeDraft,
  type ComposeMode,
  draftFromOutgoing,
  newDraft,
} from "@/lib/compose";
import { subscribeEvents } from "@/lib/events";
import { isTypingTarget, resolveShortcut } from "@/lib/shortcuts";

const PAGE_SIZE = 50;
const LIST_ERROR = "メールを読み込めませんでした。";
const ACTION_ERROR =
  "操作を反映できませんでした。一覧を最新の状態に戻しました。";
const DRAFT_NOTICE =
  "書きかけのメールがあります。送信するか破棄すると、新しいメールを作成できます。";

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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /** 一覧の取得ごとに増やし、古い応答で新しい表示を上書きしないようにする。 */
  const listRequest = useRef(0);
  const selectedAccountRef = useRef(selectedAccountId);
  selectedAccountRef.current = selectedAccountId;
  /** サーバーへ送る操作の待ち行列。通信できない間の操作もここに残る。 */
  const queueRef = useRef<ActionQueue | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 増やすと、表示中のメールの移動先メニューが開く (ショートカットキー用)。 */
  const [moveRequest, setMoveRequest] = useState(0);
  /** 作成中のメール。作成画面を閉じても、送信するか破棄するまで残す。 */
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeNotice, setComposeNotice] = useState<string | null>(null);
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

  const loadOutgoing = useCallback(async () => {
    try {
      setOutgoing(await listOutgoing());
    } catch {
      // 次の通知や操作でまた取得する。
    }
  }, []);

  /** 先頭ページを取得する。reset が true なら一覧を空にしてから読み込む。 */
  const loadFirstPage = useCallback(
    async (accountId: string | null, reset: boolean) => {
      const request = ++listRequest.current;
      if (reset) {
        setMessages(null);
        setNextCursor(null);
        setListError(null);
      }
      try {
        const page = await listMessages({ accountId, limit: PAGE_SIZE });
        if (request !== listRequest.current) return;
        setListError(null);
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
        setListError(LIST_ERROR);
      }
    },
    [],
  );

  useEffect(() => {
    void loadAccounts();
    void loadOutgoing();
  }, [loadAccounts, loadOutgoing]);

  useEffect(() => {
    const queue = createActionQueue();
    queueRef.current = queue;
    const unsubscribe = queue.onRejected(() => {
      // 画面に先に反映した内容を取り消すため、サーバーの状態を取り直す。
      setActionError(ACTION_ERROR);
      void loadFirstPage(selectedAccountRef.current, false);
      setRefreshKey((key) => key + 1);
    });
    return () => {
      unsubscribe();
      queue.stop();
      queueRef.current = null;
    };
  }, [loadFirstPage]);

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

  /** メールを開く。未読なら既読にする。 */
  function handleSelectMessage(id: string) {
    setSelectedMessageId(id);
    const message = messages?.find((item) => item.id === id);
    if (message && !message.seen) {
      performAction([id], { action: "set_flags", seen: true });
    }
  }

  useEffect(() => {
    void loadFirstPage(selectedAccountId, true);
  }, [selectedAccountId, loadFirstPage]);

  // サーバーからの変更通知で、アカウント一覧と表示中の一覧を取得し直す。
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
        void loadOutgoing();
        void loadFirstPage(selectedAccountRef.current, false);
        setRefreshKey((key) => key + 1);
      }, 300);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [loadAccounts, loadFirstPage, loadOutgoing]);

  /** 作成画面を開く。書きかけのメールがあれば、上書きせずにそちらを開く。 */
  function openCompose(create: () => ComposeDraft | null) {
    if (draft && draftDirty) {
      setComposeNotice(DRAFT_NOTICE);
    } else {
      const next = create();
      if (!next) return;
      setDraft(next);
      setDraftDirty(false);
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
      return accountId ? newDraft(accountId) : null;
    });
  }

  const handleCompose = (
    mode: Exclude<ComposeMode, "new">,
    message: MessageDetail,
  ) => {
    openCompose(() =>
      buildDraftFrom(mode, message, bodyTextOf(message), accounts ?? []),
    );
  };

  function clearDraft() {
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
      const page = await listMessages({
        accountId: selectedAccountId,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
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
      if (request === listRequest.current) setListError(LIST_ERROR);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSelectAccount(accountId: string | null) {
    setSidebarOpen(false);
    setSelectedMessageId(null);
    setSelectedAccountId(accountId);
  }

  const handleMissing = useCallback(() => setSelectedMessageId(null), []);

  const selectedAccount =
    accounts?.find((account) => account.id === selectedAccountId) ?? null;
  const title = selectedAccount
    ? selectedAccount.displayName || selectedAccount.email
    : "すべての受信トレイ";
  const noAccounts = accounts !== null && accounts.length === 0;

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
    const list = messages ?? [];
    const index = list.findIndex((item) => item.id === selectedMessageId);
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
    const id = [message.id];
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
        performAction(id, { action: "set_flags", flagged: !message.flagged });
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
  const selectedMessage =
    messages?.find((message) => message.id === selectedMessageId) ?? null;

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
          selectedAccountId={selectedAccountId}
          onSelect={handleSelectAccount}
          onAdd={() => {
            setSidebarOpen(false);
            setAddOpen(true);
          }}
          onDelete={(account) => {
            setSidebarOpen(false);
            setDeleteTarget(account);
          }}
          onReauth={(account) => {
            startMicrosoftLogin(account.id)
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
            <h1 className="min-w-0 flex-1 truncate font-semibold text-lg">
              {title}
            </h1>
            {!noAccounts && accounts !== null && (
              <Button size="sm" onClick={handleNewMail}>
                <PenLineIcon />
                {draft ? "下書きを開く" : "作成"}
              </Button>
            )}
          </header>
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
                selectedId={selectedMessageId}
                hasMore={nextCursor !== null}
                loadingMore={loadingMore}
                onSelect={handleSelectMessage}
                onAction={performAction}
                onLoadMore={() => void handleLoadMore()}
                onRetry={() => void loadFirstPage(selectedAccountId, true)}
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
        }}
      />
      <ComposeDialog
        draft={draft}
        open={composeOpen}
        accounts={accounts ?? []}
        notice={composeNotice}
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
      <DeleteAccountDialog
        account={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(id) => {
          setAccounts(
            (current) => current?.filter((item) => item.id !== id) ?? null,
          );
          setSelectedMessageId(null);
          if (selectedAccountId === id) setSelectedAccountId(null);
          else void loadFirstPage(selectedAccountId, true);
        }}
      />
    </div>
  );
}
