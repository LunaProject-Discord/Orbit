"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import { Editor } from "@/components/mail/compose-window";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  type Account,
  type Address,
  deleteSignatureRule,
  type SignatureRule,
  saveContactSignature,
  saveThreadSignature,
  updateAccountSignature,
} from "@/lib/api";
import { htmlHasContent, sanitizeHtml } from "@/lib/compose";

/** 署名を編集する対象。 */
export type SignatureTarget =
  | { kind: "account"; account: Account }
  | {
      kind: "contact";
      address: Address;
      /** いまの決まり。まだ決めていなければ null。 */
      rule: SignatureRule | null;
      /** まだ決めていないときに、書き始めの内容として入れる署名 (アカウントの署名)。 */
      fallbackHtml: string | null;
    }
  | {
      kind: "thread";
      accountId: string;
      threadKey: string;
      subject: string;
      rule: SignatureRule | null;
      fallbackHtml: string | null;
    };

type Props = {
  /** 署名を編集する対象。null なら閉じている。 */
  target: SignatureTarget | null;
  onClose: () => void;
  onAccountSaved: (account: Account) => void;
  onRuleSaved: (rule: SignatureRule) => void;
  onRuleDeleted: (id: string) => void;
};

function targetKey(target: SignatureTarget): string {
  if (target.kind === "account") {
    return `account:${target.account.id}:${target.account.signatureHtml ?? ""}`;
  }
  const id =
    target.kind === "contact"
      ? target.address.address.toLowerCase()
      : `${target.accountId}:${target.threadKey}`;
  return `${target.kind}:${id}:${target.rule?.updatedAt ?? ""}`;
}

function initialHtml(target: SignatureTarget): string {
  if (target.kind === "account") return target.account.signatureHtml ?? "";
  if (target.rule) return target.rule.signatureHtml ?? "";
  return target.fallbackHtml ?? "";
}

/**
 * 署名の編集。アカウントの署名に加えて、連絡先 (宛先のアドレス) ごと、会話ごとの署名も決められる。
 * 使われる順は、会話、連絡先、アカウント (lib/signatures.ts)。
 */
export function SignatureDialog({
  target,
  onClose,
  onAccountSaved,
  onRuleSaved,
  onRuleDeleted,
}: Props) {
  const id = useId();
  const editorRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 閉じるアニメーションの間も内容が消えないよう、最後の対象を覚えておく。
  const [shown, setShown] = useState<SignatureTarget | null>(target);
  /** 「署名を付けない」を選んでいる (連絡先と会話だけ)。 */
  const [none, setNone] = useState(false);
  if (target && target !== shown) {
    setShown(target);
    setNone(
      target.kind !== "account" &&
        target.rule !== null &&
        target.rule.signatureHtml === null,
    );
    setError(null);
  }

  const rule = shown && shown.kind !== "account" ? shown.rule : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || saving) return;
    const html = sanitizeHtml(editorRef.current?.innerHTML ?? "");
    const value = !none && htmlHasContent(html) ? html : null;
    if (target.kind !== "account" && !none && value === null) {
      setError(
        "署名を入力してください。署名を付けない場合は「署名を付けない」をオンにしてください。",
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (target.kind === "account") {
        onAccountSaved(await updateAccountSignature(target.account.id, value));
      } else if (target.kind === "contact") {
        onRuleSaved(
          await saveContactSignature({
            address: target.address.address,
            label: target.address.name?.trim() || null,
            signatureHtml: value,
          }),
        );
      } else {
        onRuleSaved(
          await saveThreadSignature({
            accountId: target.accountId,
            threadKey: target.threadKey,
            label: target.subject.trim() || null,
            signatureHtml: value,
          }),
        );
      }
      onClose();
    } catch {
      setError("署名を保存できませんでした。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!rule || saving) return;
    setSaving(true);
    setError(null);
    try {
      await deleteSignatureRule(rule.id);
      onRuleDeleted(rule.id);
      onClose();
    } catch {
      setError("設定を解除できませんでした。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  }

  const title =
    shown?.kind === "contact"
      ? "この相手への署名"
      : shown?.kind === "thread"
        ? "この会話の署名"
        : "署名";

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !saving) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {shown?.kind === "account" && (
              <>
                {shown.account.email}{" "}
                から送るメールの末尾に入ります。返信と転送では、元のメールの前に入ります。空にして保存すると、署名なしになります。
              </>
            )}
            {shown?.kind === "contact" && (
              <>
                <span className="break-all">{shown.address.address}</span>{" "}
                宛てのメールでは、アカウントの署名の代わりにこの署名を使います。宛先
                (To)
                にほかの相手もいる場合は、全員に同じ署名を設定しているときだけ使います。
              </>
            )}
            {shown?.kind === "thread" && (
              <>
                「{shown.subject || "(件名なし)"}
                」の会話への返信と転送では、連絡先やアカウントの署名の代わりにこの署名を使います。
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {shown && shown.kind !== "account" && (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`${id}-none`}>署名を付けない</Label>
              <Switch
                id={`${id}-none`}
                checked={none}
                disabled={saving}
                onCheckedChange={(checked) => {
                  setNone(checked);
                  setError(null);
                }}
              />
            </div>
          )}
          {shown && (
            <div
              className="flex max-h-80 flex-col overflow-hidden rounded-lg border"
              // 「署名を付けない」の間も、書いた内容は残しておく (オフに戻せば続きを書ける)。
              hidden={none}
            >
              <Editor
                // 別の対象を開いたら、その署名で作り直す。
                key={targetKey(shown)}
                editorRef={editorRef}
                initialHtml={initialHtml(shown)}
                disabled={saving}
                label="署名"
                onChange={() => setError(null)}
                toolbar={(format) => (
                  <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5">
                    {format}
                  </div>
                )}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            {rule && (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => void handleRemove()}
                className="text-destructive sm:mr-auto"
              >
                設定を解除
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              キャンセル
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
