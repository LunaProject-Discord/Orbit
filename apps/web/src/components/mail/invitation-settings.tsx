"use client";

import { CheckIcon, CopyIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { showNotice } from "@/components/mail/toasts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ApiError,
  createInvitation,
  deleteInvitation,
  type Invitation,
  listInvitations,
  type Member,
  NetworkError,
  type User,
} from "@/lib/api";
import { useDateStyle } from "@/lib/date-format-settings";
import { type DateStyle, formatFullDate, formatShortDate } from "@/lib/format";

/** 有効期限の選択肢 (日数)。 */
const EXPIRY_OPTIONS = [
  { value: "1", label: "1 日" },
  { value: "3", label: "3 日" },
  { value: "7", label: "7 日" },
  { value: "14", label: "14 日" },
  { value: "30", label: "30 日" },
];

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    if (error.code === "email_taken") {
      return "このメールアドレスは、すでに登録されています。";
    }
    if (error.code === "too_many") {
      return "未使用の招待が多すぎます。不要な招待を取り消してください。";
    }
    if (error.status === 403) {
      return "この機能は管理者だけが使えます。";
    }
  }
  return "処理できませんでした。時間をおいてもう一度お試しください。";
}

export type InvitationState = "pending" | "used" | "expired";

/** 招待の状態。now は現在の時刻 (ミリ秒)。 */
export function invitationState(
  invitation: Pick<Invitation, "usedAt" | "expiresAt">,
  now: number,
): InvitationState {
  if (invitation.usedAt) return "used";
  return new Date(invitation.expiresAt).getTime() <= now
    ? "expired"
    : "pending";
}

/** 一覧での招待の呼び名。 */
function titleOf(invitation: Invitation): string {
  return invitation.label || invitation.email || "名前のない招待";
}

function detailOf(
  invitation: Invitation,
  state: InvitationState,
  style: DateStyle,
): string {
  if (state === "used") {
    const who = invitation.usedByEmail
      ? `${invitation.usedByName ?? ""} (${invitation.usedByEmail})`.trim()
      : "削除された利用者";
    return `${who} が登録 ・ ${formatFullDate(invitation.usedAt ?? invitation.createdAt, style)}`;
  }
  const limit = formatFullDate(invitation.expiresAt, style);
  const only = invitation.email ? ` ・ ${invitation.email} 専用` : "";
  return state === "expired"
    ? `${limit} に期限切れ${only}`
    : `${limit} まで有効${only}`;
}

/** 設定の「利用者と招待」のページ。管理者だけが使える。 */
export function InvitationSettings({ user }: { user: User }) {
  const dateStyle = useDateStyle();
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** 発行した直後のリンク。この画面を閉じると、もう表示できない。 */
  const [issued, setIssued] = useState<{ url: string; title: string } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<Invitation | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await listInvitations(signal);
      setInvitations(data.invitations);
      setMembers(data.users);
      setNow(Date.now());
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    if (!user.isAdmin) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, user.isAdmin]);

  if (!user.isAdmin) {
    return (
      <p className="rounded-lg border px-3 py-2.5 text-muted-foreground text-sm">
        このページは、管理者だけが使えます。利用者を追加したいときは、このサーバーの管理者に依頼してください。
      </p>
    );
  }

  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
            <h3 className="font-semibold text-base">招待リンク</h3>
            <p className="text-muted-foreground text-sm">
              リンクを開いた人は、自分で名前・メールアドレス・パスワードを決めて登録できます。1
              つのリンクで登録できるのは 1 人だけです。
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <UserPlusIcon />
            招待リンクを作成
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {invitations === null && !error && (
          <p className="text-muted-foreground text-sm">読み込み中…</p>
        )}
        {invitations && invitations.length === 0 && (
          <p className="rounded-lg border px-3 py-2.5 text-muted-foreground text-sm">
            まだ招待はありません。
          </p>
        )}
        {invitations && invitations.length > 0 && (
          <ul
            className="flex flex-col divide-y rounded-lg border"
            data-invitations
          >
            {invitations.map((invitation) => {
              const state = invitationState(invitation, now);
              return (
                <li
                  key={invitation.id}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium text-sm">
                      <span className="truncate">{titleOf(invitation)}</span>
                      <Badge
                        variant={state === "pending" ? "secondary" : "outline"}
                        className="shrink-0"
                      >
                        {state === "pending"
                          ? "未使用"
                          : state === "used"
                            ? "使用済み"
                            : "期限切れ"}
                      </Badge>
                    </p>
                    <p className="truncate text-muted-foreground text-xs">
                      {detailOf(invitation, state, dateStyle)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${titleOf(invitation)} を${state === "pending" ? "取り消す" : "一覧から削除"}`}
                    onClick={() => setDeleteTarget(invitation)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold text-base">利用者</h3>
          <p className="text-muted-foreground text-sm">
            このサーバーに登録している人です。メールやメールアカウントは利用者ごとに分かれていて、ほかの利用者からは見えません。
          </p>
        </div>
        {members.length > 0 && (
          <ul className="flex flex-col divide-y rounded-lg border" data-members>
            {members.map((member) => (
              <li key={member.id} className="px-3 py-2">
                <p className="flex items-center gap-2 font-medium text-sm">
                  <span className="truncate">{member.name}</span>
                  {member.isAdmin && (
                    <Badge variant="secondary" className="shrink-0">
                      管理者
                    </Badge>
                  )}
                  {member.id === user.id && (
                    <Badge variant="outline" className="shrink-0">
                      自分
                    </Badge>
                  )}
                </p>
                <p className="truncate text-muted-foreground text-xs">
                  {member.email} ・{" "}
                  {formatShortDate(member.createdAt, dateStyle)} に登録
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(invitation, url) => {
          setCreating(false);
          setIssued({ url, title: titleOf(invitation) });
          void load();
        }}
      />
      <IssuedDialog issued={issued} onClose={() => setIssued(null)} />
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget && invitationState(deleteTarget, now) === "pending"
                ? "この招待を取り消しますか？"
                : "この招待を一覧から削除しますか？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && invitationState(deleteTarget, now) === "pending"
                ? "渡したリンクは使えなくなります。"
                : "登録済みの利用者には影響しません。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = deleteTarget;
                if (!target) return;
                setDeleteTarget(null);
                deleteInvitation(target.id)
                  .catch((cause: unknown) => {
                    // ほかの端末で消してあれば、そのまま一覧を取り直す。
                    if (!(cause instanceof ApiError && cause.status === 404)) {
                      showNotice(messageOf(cause));
                    }
                  })
                  .finally(() => void load());
              }}
            >
              {deleteTarget && invitationState(deleteTarget, now) === "pending"
                ? "取り消す"
                : "削除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CreateDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (invitation: Invitation, url: string) => void;
}) {
  const labelId = useId();
  const emailId = useId();
  const expiryId = useId();
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("7");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 開くたびに、入力を空に戻す。
  useEffect(() => {
    if (!props.open) return;
    setLabel("");
    setEmail("");
    setDays("7");
    setError(null);
    setSubmitting(false);
  }, [props.open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { invitation, url } = await createInvitation({
        label: label.trim() || null,
        email: email.trim() || null,
        expiresInDays: Number(days),
      });
      props.onCreated(invitation, url);
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>招待リンクを作成</DialogTitle>
            <DialogDescription>
              作成したリンクを、招待する人に渡してください。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={labelId}>渡す相手 (メモ)</Label>
            <Input
              id={labelId}
              value={label}
              maxLength={100}
              placeholder="例: 山田さん"
              autoComplete="off"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={emailId}>登録できるメールアドレス (任意)</Label>
            <Input
              id={emailId}
              type="email"
              value={email}
              maxLength={320}
              autoComplete="off"
              onChange={(event) => setEmail(event.target.value)}
            />
            <p className="text-muted-foreground text-xs leading-relaxed">
              指定すると、このメールアドレスでしか登録できなくなります。リンクがほかの人に渡っても、悪用されにくくなります。
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={expiryId}>有効期限</Label>
            <Select
              items={EXPIRY_OPTIONS}
              value={days}
              onValueChange={(next) => {
                if (typeof next === "string") setDays(next);
              }}
            >
              <SelectTrigger id={expiryId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              キャンセル
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "作成中…" : "作成"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IssuedDialog(props: {
  issued: { url: string; title: string } | null;
  onClose: () => void;
}) {
  const urlId = useId();
  const [copied, setCopied] = useState(false);
  const url = props.issued?.url ?? "";

  // 別のリンクを出すたびに、コピー済みの表示を戻す。
  // biome-ignore lint/correctness/useExhaustiveDependencies: リンクが変わったときだけ戻す。
  useEffect(() => setCopied(false), [url]);

  return (
    <Dialog
      open={props.issued !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>招待リンクを作成しました</DialogTitle>
          <DialogDescription>
            このリンクをコピーして、招待する人に渡してください。この画面を閉じると、リンクは二度と表示できません
            (新しく作成することはできます)。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={urlId}>招待リンク</Label>
          <Input
            id={urlId}
            readOnly
            value={url}
            className="font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(url)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "コピーしました" : "リンクをコピー"}
          </Button>
          <Button type="button" onClick={props.onClose}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
