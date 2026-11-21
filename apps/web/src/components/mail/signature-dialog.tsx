"use client";

import { type FormEvent, useRef, useState } from "react";
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
import { type Account, updateAccountSignature } from "@/lib/api";
import { htmlHasContent, sanitizeHtml } from "@/lib/compose";

type Props = {
  /** 署名を編集するアカウント。null なら閉じている。 */
  account: Account | null;
  onClose: () => void;
  onSaved: (account: Account) => void;
};

/** アカウントごとの署名の編集。保存した署名は、作成画面を開いたときに本文へ入る。 */
export function SignatureDialog({ account, onClose, onSaved }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 閉じるアニメーションの間も内容が消えないよう、最後のアカウントを覚えておく。
  const [shown, setShown] = useState<Account | null>(account);
  if (account && account !== shown) setShown(account);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || saving) return;
    const html = sanitizeHtml(editorRef.current?.innerHTML ?? "");
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await updateAccountSignature(
          account.id,
          htmlHasContent(html) ? html : null,
        ),
      );
      onClose();
    } catch {
      setError("署名を保存できませんでした。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open && !saving) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>署名</DialogTitle>
          <DialogDescription>
            {shown?.email}{" "}
            から送るメールの末尾に入ります。返信と転送では、元のメールの前に入ります。空にして保存すると、署名なしになります。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="flex max-h-80 flex-col overflow-hidden rounded-lg border">
            {shown && (
              <Editor
                // 別のアカウントを開いたら、そのアカウントの署名で作り直す。
                key={`${shown.id}:${shown.signatureHtml ?? ""}`}
                editorRef={editorRef}
                initialHtml={shown.signatureHtml ?? ""}
                disabled={saving}
                label="署名"
                onChange={() => setError(null)}
                toolbar={(format) => (
                  <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5">
                    {format}
                  </div>
                )}
              />
            )}
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
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
