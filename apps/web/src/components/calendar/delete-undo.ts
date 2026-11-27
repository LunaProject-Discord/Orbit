"use client";

import { useCallback, useEffect, useRef } from "react";
import { hideUndo, showNotice, showUndo } from "@/components/mail/toasts";
import type { CalendarClient, PendingUndo } from "@/lib/calendar/offline";
import { usePreferences } from "@/lib/preferences";
import { isTypingTarget, resolveShortcut } from "@/lib/shortcuts";
import { UNDO_MS } from "@/lib/undo";

/**
 * 予定の削除の「元に戻す」。Mail の削除と同じトースト (showUndo)・時間 (UNDO_MS)・キー (Z)。
 *
 * 削除は端末の表示からすぐ消し (送信待ちを重ねた表示)、サーバーへ送るのはトーストを出している
 * 間だけ待つ (CalendarClient.holdForUndo)。「元に戻す」を押したら送信待ちから取り除くので、
 * サーバーには何も送らない。時間が過ぎるかトーストを閉じたら、その時点で送る。もう送っていた
 * ら、消した予定を作り直さずに、元に戻せなかったことを知らせる。
 */
export type DeleteWithUndo = (
  client: CalendarClient,
  /** トーストの文言 (「予定を削除しました」など)。 */
  message: string,
  /** もう送っていて元に戻せなかったときの知らせ。 */
  failure: string,
  /** 削除の書き込み (client.deleteEvent など)。中で積んだものをまとめて待たせる。 */
  write: () => void,
) => void;

export function useDeleteUndo(): DeleteWithUndo {
  const undoRef = useRef<{
    id: number;
    pending: PendingUndo;
    failure: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const undoSeq = useRef(0);

  /** 「元に戻す」の受け付けを終えて、待たせていた削除を送る。 */
  const commitUndo = useCallback((only?: number) => {
    const group = undoRef.current;
    if (!group || (only !== undefined && group.id !== only)) return;
    undoRef.current = null;
    clearTimeout(group.timer);
    group.pending.release();
    hideUndo(`calendar-${group.id}`);
  }, []);
  // 画面を離れるときは、待たせていた削除をそのまま送る。
  useEffect(() => () => commitUndo(), [commitUndo]);

  /** 直前の削除を元に戻す。まだ送っていなければ送らずに取り消す。 */
  const handleUndo = useCallback(() => {
    const group = undoRef.current;
    if (!group) return;
    undoRef.current = null;
    clearTimeout(group.timer);
    hideUndo(`calendar-${group.id}`);
    void group.pending.undo().then((undone) => {
      if (!undone) showNotice(group.failure);
    });
  }, []);

  // Mail と同じく Z で直前の削除を元に戻す (トーストにキーを出している)。
  const { shortcuts } = usePreferences();
  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!undoRef.current || resolveShortcut(event) !== "undo") return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      event.preventDefault();
      handleUndo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts, handleUndo]);

  return useCallback(
    (client, message, failure, write) => {
      // 続けて削除したら、前の削除を確定してから受け付ける。
      commitUndo();
      const pending = client.holdForUndo(write, UNDO_MS);
      const id = ++undoSeq.current;
      undoRef.current = {
        id,
        pending,
        failure,
        timer: setTimeout(() => commitUndo(id), UNDO_MS),
      };
      showUndo(
        `calendar-${id}`,
        message,
        handleUndo,
        // 利用者がトーストを閉じたら、その時点で確定する。
        () => commitUndo(id),
      );
    },
    [commitUndo, handleUndo],
  );
}
