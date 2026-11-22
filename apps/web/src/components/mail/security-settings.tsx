"use client";

import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { renderSVG } from "uqr";
import { useAuth } from "@/components/auth-provider";
import { MIN_PASSWORD_LENGTH } from "@/components/auth-shell";
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
import { Checkbox } from "@/components/ui/checkbox";
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
  ApiError,
  changePassword,
  confirmTwoFactor,
  deletePasskey,
  disableTwoFactor,
  fetchSecurity,
  listPasskeys,
  NetworkError,
  type Passkey,
  regenerateBackupCodes,
  renamePasskey,
  requestEmailChange,
  type SecurityStatus,
  startTwoFactor,
  type TwoFactorSetup,
  type User,
} from "@/lib/api";
import {
  PasskeyAlreadyRegistered,
  PasskeyCancelled,
  passkeySupported,
  registerPasskey,
} from "@/lib/passkey";
import { isBundledApp } from "@/lib/server-url";

/** サーバーの応答を、画面に出す文にする。null は「何も出さない」(利用者が取りやめた)。 */
function messageOf(error: unknown): string | null {
  if (error instanceof PasskeyCancelled) return null;
  if (error instanceof PasskeyAlreadyRegistered) {
    return "この端末 (または鍵) には、もうこのアカウントのパスキーがあります。";
  }
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "INVALID_PASSWORD":
      case "invalid_password":
        return "パスワードが正しくありません。";
      case "PASSWORD_TOO_SHORT":
        return `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。`;
      case "PASSWORD_TOO_LONG":
        return "パスワードが長すぎます。";
      case "INVALID_CODE":
        return "コードが正しくありません。認証アプリに表示されている、いまのコードを入力してください。";
      case "same_email":
        return "いまのメールアドレスと同じです。";
      case "mail_disabled":
        return "このサーバーはメールを送れないため、変更できません。";
      case "SESSION_NOT_FRESH":
        return "安全のため、ログインしてから 1 日以上経った端末では登録できません。いちどログアウトして、ログインし直してからお試しください。";
      case "SESSION_EXPIRED":
      case "UNAUTHORIZED":
        return "ログインの有効期限が切れました。ログインし直してください。";
    }
    if (error.status === 429) {
      return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
    }
  }
  return "うまくいきませんでした。時間をおいてもう一度お試しください。";
}

type Props = {
  user: User;
};

/**
 * 設定画面の「ログインとセキュリティ」のページ。
 * Orbit へのログインに使うメールアドレス、パスワード、2 段階認証、パスキーを扱う。
 */
export function SecuritySettings({ user }: Props) {
  const { refreshUser } = useAuth();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialog, setDialog] = useState<
    | null
    | "email"
    | "password"
    | "two-factor-setup"
    | "two-factor-disable"
    | "backup-codes"
    | "passkey-add"
  >(null);
  const [renameTarget, setRenameTarget] = useState<Passkey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Passkey | null>(null);
  // パスキーを使える環境かは、読み込み後に決める (静的に書き出した HTML と食い違わせない)。
  const [canPasskey, setCanPasskey] = useState<boolean | null>(null);
  const [bundled, setBundled] = useState(false);
  useEffect(() => {
    setCanPasskey(passkeySupported());
    setBundled(isBundledApp());
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [nextStatus, nextPasskeys] = await Promise.all([
        fetchSecurity(signal),
        listPasskeys(signal),
      ]);
      setStatus(nextStatus);
      setPasskeys(nextPasskeys);
      setLoadError(false);
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 401) return;
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const close = () => setDialog(null);
  const twoFactorEnabled = status?.twoFactorEnabled ?? false;
  const mail = status?.mail ?? false;

  return (
    <section className="flex flex-col gap-3">
      {loadError && (
        <p role="alert" className="text-destructive text-sm">
          いまの設定を読み込めませんでした。{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => void load()}
          >
            再試行
          </button>
        </p>
      )}
      <div className="flex flex-col divide-y rounded-lg border">
        <Row
          label="メールアドレス"
          description={
            status && !mail
              ? `${user.email} (このサーバーはメールを送れないため、変更できません)`
              : user.email
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!mail}
            onClick={() => setDialog("email")}
          >
            変更
          </Button>
        </Row>
        <Row
          label="パスワード"
          description={`${MIN_PASSWORD_LENGTH} 文字以上。`}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog("password")}
          >
            変更
          </Button>
        </Row>
        <Row
          label="2 段階認証"
          badge={
            status ? (
              <Badge variant={twoFactorEnabled ? "default" : "secondary"}>
                {twoFactorEnabled ? "有効" : "無効"}
              </Badge>
            ) : null
          }
          description="パスワードに加えて、認証アプリ (Google Authenticator、1Password など) に表示される 6 桁のコードでログインします。"
        >
          {twoFactorEnabled ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialog("backup-codes")}
              >
                バックアップコードを作り直す
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialog("two-factor-disable")}
              >
                無効にする
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!status}
              onClick={() => setDialog("two-factor-setup")}
            >
              設定する
            </Button>
          )}
        </Row>
        <div className="flex flex-col gap-3 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-48">
              <span className="font-medium text-sm">パスキー</span>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {canPasskey === false
                  ? bundled
                    ? "指紋・顔・PIN などでログインできます。このアプリからは登録もログインもできません。ブラウザーで Orbit を開いて使ってください。"
                    : "このブラウザーはパスキーに対応していません。"
                  : "パスワードの代わりに、端末の指紋・顔・PIN やセキュリティキーでログインします。パスキーでのログインでは、2 段階認証のコードは尋ねません。"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!canPasskey}
              onClick={() => setDialog("passkey-add")}
            >
              <KeyRoundIcon />
              パスキーを追加
            </Button>
          </div>
          {passkeys && passkeys.length > 0 && (
            <ul className="flex flex-col divide-y rounded-md border">
              {passkeys.map((passkey) => (
                <li
                  key={passkey.id}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">
                      {passkey.name?.trim() || "名前のないパスキー"}
                    </p>
                    <p className="truncate text-muted-foreground text-xs">
                      {passkeyDetail(passkey)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${passkey.name?.trim() || "パスキー"} の名前を変更`}
                    onClick={() => setRenameTarget(passkey)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${passkey.name?.trim() || "パスキー"} を削除`}
                    onClick={() => setDeleteTarget(passkey)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <EmailDialog
        open={dialog === "email"}
        currentEmail={user.email}
        onClose={close}
      />
      <PasswordDialog open={dialog === "password"} onClose={close} />
      <TwoFactorSetupDialog
        open={dialog === "two-factor-setup"}
        onClose={close}
        onEnabled={() => {
          void load();
          void refreshUser().catch(() => {});
        }}
      />
      <PasswordConfirmDialog
        open={dialog === "two-factor-disable"}
        title="2 段階認証を無効にしますか？"
        description="無効にすると、パスワードだけでログインできるようになります。バックアップコードも使えなくなります。"
        actionLabel="無効にする"
        destructive
        onClose={close}
        onConfirm={async (password) => {
          await disableTwoFactor(password);
          await load();
          showNotice("2 段階認証を無効にしました。", "info");
        }}
      />
      <BackupCodesDialog open={dialog === "backup-codes"} onClose={close} />
      <PasskeyAddDialog
        open={dialog === "passkey-add"}
        onClose={close}
        onAdded={() => void load()}
      />
      <PasskeyRenameDialog
        passkey={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRenamed={() => void load()}
      />
      <PasskeyDeleteDialog
        passkey={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => void load()}
      />
    </section>
  );
}

function passkeyDetail(passkey: Passkey): string {
  const parts: string[] = [];
  if (passkey.createdAt) {
    const date = new Date(passkey.createdAt);
    if (!Number.isNaN(date.getTime())) {
      parts.push(`${date.toLocaleDateString("ja-JP")} に登録`);
    }
  }
  parts.push(
    passkey.deviceType === "multiDevice"
      ? "端末の間で同期されるパスキー"
      : "この端末 (または鍵) だけのパスキー",
  );
  return parts.join(" ・ ");
}

function Row(props: {
  label: string;
  badge?: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-48">
        <span className="flex items-center gap-2 font-medium text-sm">
          {props.label}
          {props.badge}
        </span>
        {props.description && (
          <p className="break-words text-muted-foreground text-xs leading-relaxed">
            {props.description}
          </p>
        )}
      </div>
      {props.children}
    </div>
  );
}

function Field(props: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{props.label}</Label>
      {props.children(id)}
      {props.hint && (
        <p className="text-muted-foreground text-xs">{props.hint}</p>
      )}
    </div>
  );
}

function ErrorText({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {children}
    </p>
  );
}

/** 開くたびに中身を作り直す (前に入力したパスワードなどを残さない) ダイアログの枠。 */
function FreshDialog(props: {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  // 閉じるアニメーションの間は中身を残し、次に開くときに作り直す。
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setGeneration((value) => value + 1);
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogContent key={generation}>{props.children}</DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// メールアドレス
// ---------------------------------------------------------------------------

function EmailDialog(props: {
  open: boolean;
  currentEmail: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <FreshDialog open={props.open} busy={busy} onClose={props.onClose}>
      <EmailForm {...props} onBusy={setBusy} />
    </FreshDialog>
  );
}

function EmailForm(props: {
  currentEmail: string;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    props.onBusy(true);
    try {
      await requestEmailChange(email.trim(), password);
      setSentTo(email.trim());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  }

  if (sentTo) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>確認のメールを送りました</DialogTitle>
          <DialogDescription>
            <span className="break-all font-medium text-foreground">
              {sentTo}
            </span>{" "}
            に届いたメールのリンクを開くと、変更が完了します (有効期限は 1
            時間)。リンクを開くまでは、いまのメールアドレス でログインします。
          </DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          ほかの利用者が使っているメールアドレスには、メールは届きません。
        </p>
        <DialogFooter>
          <Button onClick={props.onClose}>閉じる</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>メールアドレスを変更</DialogTitle>
        <DialogDescription>
          新しいメールアドレスへ確認のメールを送ります。メールのリンクを開くと変更が完了します。
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm">
        いまのメールアドレス:{" "}
        <span className="break-all font-medium">{props.currentEmail}</span>
      </p>
      <Field label="新しいメールアドレス">
        {(id) => (
          <Input
            id={id}
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <Field label="いまのパスワード">
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={props.onClose}
        >
          キャンセル
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "送信中…" : "確認のメールを送る"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// パスワード
// ---------------------------------------------------------------------------

function PasswordDialog(props: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <FreshDialog open={props.open} busy={busy} onClose={props.onClose}>
      <PasswordForm onClose={props.onClose} onBusy={setBusy} />
    </FreshDialog>
  );
}

function PasswordForm(props: {
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const revokeId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revoke, setRevoke] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next !== confirm) {
      setError("確認用のパスワードが一致しません。");
      return;
    }
    setError(null);
    setBusy(true);
    props.onBusy(true);
    try {
      await changePassword(current, next, revoke);
      showNotice(
        revoke
          ? "パスワードを変更し、ほかの端末をログアウトしました。"
          : "パスワードを変更しました。",
        "info",
      );
      props.onBusy(false);
      props.onClose();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === "INVALID_PASSWORD"
          ? "いまのパスワードが正しくありません。"
          : messageOf(cause),
      );
      setBusy(false);
      props.onBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>パスワードを変更</DialogTitle>
        <DialogDescription>
          いまのパスワードを確かめてから、新しいパスワードに変更します。
        </DialogDescription>
      </DialogHeader>
      <Field label="いまのパスワード">
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        )}
      </Field>
      <Field
        label="新しいパスワード"
        hint={`${MIN_PASSWORD_LENGTH} 文字以上にしてください。`}
      >
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        )}
      </Field>
      <Field label="新しいパスワード (確認)">
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id={revokeId}
          checked={revoke}
          onCheckedChange={(checked) => setRevoke(checked === true)}
        />
        <Label htmlFor={revokeId} className="font-normal">
          ほかの端末をログアウトする
        </Label>
      </div>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={props.onClose}
        >
          キャンセル
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "変更中…" : "変更"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 2 段階認証
// ---------------------------------------------------------------------------

/** バックアップコードの一覧と、コピーのボタン。 */
function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(codes.join("\n"))
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "コピーしました" : "すべてコピー"}
        </Button>
      </div>
    </div>
  );
}

const BACKUP_CODES_NOTE =
  "認証アプリを使えないとき (スマホの紛失や機種変更など) に、コードの代わりに使えます。1 つにつき 1 回だけ使えます。パスワード管理アプリなど、安全な場所に保存してください。この画面を閉じると、もう表示できません。";

function TwoFactorSetupDialog(props: {
  open: boolean;
  onClose: () => void;
  onEnabled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <FreshDialog open={props.open} busy={busy} onClose={props.onClose}>
      <TwoFactorSetupForm {...props} onBusy={setBusy} />
    </FreshDialog>
  );
}

function TwoFactorSetupForm(props: {
  onClose: () => void;
  onEnabled: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [step, setStep] = useState<"password" | "scan" | "codes">("password");
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    props.onBusy(true);
    try {
      await task();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  };

  /** 認証アプリへ手で入力するための鍵 (QR コードを読めないとき)。 */
  const secret = useMemo(() => {
    if (!setup) return "";
    try {
      return new URL(setup.totpURI).searchParams.get("secret") ?? "";
    } catch {
      return "";
    }
  }, [setup]);
  const qr = useMemo(() => {
    if (!setup) return null;
    // 暗い配色でも読めるよう、白地に黒で描く。
    const svg = renderSVG(setup.totpURI, {
      border: 2,
      blackColor: "#000000",
      whiteColor: "#ffffff",
    });
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }, [setup]);

  if (step === "password") {
    return (
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setSetup(await startTwoFactor(password));
            setStep("scan");
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>2 段階認証を設定</DialogTitle>
          <DialogDescription>
            認証アプリ (Google Authenticator、Microsoft Authenticator、1Password
            など) を用意してください。まず、いまのパスワードを確かめます。
          </DialogDescription>
        </DialogHeader>
        <Field label="いまのパスワード">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={props.onClose}
          >
            キャンセル
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "確認中…" : "次へ"}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  if (step === "scan") {
    return (
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await confirmTwoFactor(code.replace(/\s/g, ""));
            props.onEnabled();
            setStep("codes");
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>認証アプリに登録</DialogTitle>
          <DialogDescription>
            認証アプリで下の QR コードを読み取り、アプリに表示された 6
            桁のコードを入力してください。コードを確かめるまで、2
            段階認証は有効になりません。
          </DialogDescription>
        </DialogHeader>
        {qr && (
          // biome-ignore lint/performance/noImgElement: その場で作った QR コード (data URL) を出すだけなので、画像の最適化は要らない。
          <img
            src={qr}
            alt="認証アプリで読み取る QR コード"
            className="mx-auto size-48 rounded-md border"
          />
        )}
        {secret && (
          <p className="text-muted-foreground text-xs">
            読み取れないときは、この鍵を認証アプリに入力してください:{" "}
            <span className="select-all break-all font-mono text-foreground">
              {secret}
            </span>
          </p>
        )}
        <Field label="6 桁のコード">
          {(id) => (
            <Input
              id={id}
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={12}
              className="font-mono tracking-widest"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </Field>
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={props.onClose}
          >
            キャンセル
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "確認中…" : "有効にする"}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>2 段階認証を有効にしました</DialogTitle>
        <DialogDescription>
          次のバックアップコードを保存してください。{BACKUP_CODES_NOTE}
        </DialogDescription>
      </DialogHeader>
      <BackupCodes codes={setup?.backupCodes ?? []} />
      <DialogFooter>
        <Button onClick={props.onClose}>保存しました</Button>
      </DialogFooter>
    </>
  );
}

/** パスワードを確かめてから実行する操作の、確認のダイアログ。 */
function PasswordConfirmDialog(props: {
  open: boolean;
  title: string;
  description: string;
  actionLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <FreshDialog open={props.open} busy={busy} onClose={props.onClose}>
      <PasswordConfirmForm {...props} onBusy={setBusy} />
    </FreshDialog>
  );
}

function PasswordConfirmForm(props: {
  title: string;
  description: string;
  actionLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: (password: string) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    props.onBusy(true);
    try {
      await props.onConfirm(password);
      props.onBusy(false);
      props.onClose();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
      props.onBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.description}</DialogDescription>
      </DialogHeader>
      <Field label="いまのパスワード">
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={props.onClose}
        >
          キャンセル
        </Button>
        <Button
          type="submit"
          variant={props.destructive ? "destructive" : "default"}
          disabled={busy}
        >
          {busy ? "処理中…" : props.actionLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

function BackupCodesDialog(props: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <FreshDialog open={props.open} busy={busy} onClose={props.onClose}>
      <BackupCodesForm onClose={props.onClose} onBusy={setBusy} />
    </FreshDialog>
  );
}

function BackupCodesForm(props: {
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [codes, setCodes] = useState<string[] | null>(null);
  if (codes) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>新しいバックアップコード</DialogTitle>
          <DialogDescription>
            前のコードは使えなくなりました。{BACKUP_CODES_NOTE}
          </DialogDescription>
        </DialogHeader>
        <BackupCodes codes={codes} />
        <DialogFooter>
          <Button onClick={props.onClose}>保存しました</Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <PasswordConfirmForm
      title="バックアップコードを作り直しますか？"
      description="新しいコードを 10 個作ります。前のコードは、すべて使えなくなります。"
      actionLabel="作り直す"
      // 作り直したコードを見せるので、確認のあとも閉じない。
      onClose={() => {}}
      onConfirm={async (password) => {
        setCodes(await regenerateBackupCodes(password));
      }}
      onBusy={props.onBusy}
    />
  );
}

// ---------------------------------------------------------------------------
// パスキー
// ---------------------------------------------------------------------------

/** 登録するパスキーの名前の候補 (あとで見分けられるよう、端末の種類を入れる)。 */
function defaultPasskeyName(): string {
  const agent = navigator.userAgent;
  const device = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Windows/.test(agent)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(agent)
            ? "Mac"
            : /Linux/.test(agent)
              ? "Linux"
              : "";
  return device ? `${device} のパスキー` : "パスキー";
}

function PasskeyAddDialog(props: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <FreshDialog open={props.open} busy={busy} onClose={props.onClose}>
      <PasskeyAddForm {...props} onBusy={setBusy} />
    </FreshDialog>
  );
}

function PasskeyAddForm(props: {
  onClose: () => void;
  onAdded: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(defaultPasskeyName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    props.onBusy(true);
    try {
      await registerPasskey(name.trim() || defaultPasskeyName());
      props.onAdded();
      showNotice("パスキーを追加しました。", "info");
      props.onBusy(false);
      props.onClose();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
      props.onBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>パスキーを追加</DialogTitle>
        <DialogDescription>
          「追加」を押すと、ブラウザーや端末の画面が出ます。指紋・顔・PIN
          などで確かめると、この端末 (またはセキュリティキー)
          にパスキーが作られます。
        </DialogDescription>
      </DialogHeader>
      <Field
        label="名前"
        hint="あとで見分けられる名前にしてください (「自宅の PC」など)。"
      >
        {(id) => (
          <Input
            id={id}
            required
            autoFocus
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={props.onClose}
        >
          キャンセル
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "端末の画面で確かめてください…" : "追加"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PasskeyRenameDialog(props: {
  passkey: Passkey | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // 閉じるアニメーションの間も中身が消えないよう、最後のパスキーを覚えておく。
  const [shown, setShown] = useState<Passkey | null>(props.passkey);
  if (props.passkey && props.passkey !== shown) setShown(props.passkey);
  return (
    <FreshDialog
      open={props.passkey !== null}
      busy={busy}
      onClose={props.onClose}
    >
      {shown && (
        <PasskeyRenameForm
          passkey={shown}
          onClose={props.onClose}
          onRenamed={props.onRenamed}
          onBusy={setBusy}
        />
      )}
    </FreshDialog>
  );
}

function PasskeyRenameForm(props: {
  passkey: Passkey;
  onClose: () => void;
  onRenamed: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(props.passkey.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    props.onBusy(true);
    try {
      await renamePasskey(props.passkey.id, name.trim());
      props.onRenamed();
      props.onBusy(false);
      props.onClose();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
      props.onBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>パスキーの名前を変更</DialogTitle>
        <DialogDescription>
          この画面での呼び名だけが変わります。端末に保存されたパスキーは変わりません。
        </DialogDescription>
      </DialogHeader>
      <Field label="名前">
        {(id) => (
          <Input
            id={id}
            required
            autoFocus
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={props.onClose}
        >
          キャンセル
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PasskeyDeleteDialog(props: {
  passkey: Passkey | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Passkey | null>(props.passkey);
  if (props.passkey && props.passkey !== shown) setShown(props.passkey);

  async function handleDelete() {
    if (!props.passkey) return;
    setDeleting(true);
    setError(null);
    try {
      await deletePasskey(props.passkey.id);
      props.onDeleted();
      props.onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog
      open={props.passkey !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) {
          setError(null);
          props.onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>パスキーを削除しますか？</AlertDialogTitle>
          <AlertDialogDescription>
            「{shown?.name?.trim() || "名前のないパスキー"}
            」ではログインできなくなります。端末やパスワード管理アプリに残ったパスキーは、そちらで削除してください。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorText>{error}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={handleDelete}
          >
            {deleting ? "削除中…" : "削除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
