"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import {
  CheckIcon,
  CopyIcon,
  SearchIcon,
  SignatureIcon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SenderAvatar } from "@/components/mail/sender-avatar";
import { Button } from "@/components/ui/button";
import {
  sheetBackdrop,
  useNarrowScreen,
  useSheetSwipe,
} from "@/components/ui/menu-sheet";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Address, SenderCheck } from "@/lib/api";
import { addressFull, addressLabel } from "@/lib/format";
import { usePreferences } from "@/lib/preferences";

/** プロフィールカードから始められる操作。渡さなかった操作のボタンは出さない。 */
export type ProfileActions = {
  /** このアドレスとやり取りしたメールを検索する。 */
  onSearch?: (address: Address) => void;
  /** このアドレス宛ての新しいメールを書き始める。 */
  onCompose?: (address: Address) => void;
  /** このアドレス宛てのメールに使う署名を決める。 */
  onSignature?: (address: Address) => void;
  /** このアドレスに署名を決めてあるか (ボタンの文言に使う)。 */
  hasSignature?: (address: Address) => boolean;
};

export { profileInitial } from "@/components/mail/sender-avatar";

/**
 * メールの相手 (差出人や宛先) の名前。カーソルを合わせるか、押す (タッチではタップ) と、
 * プロフィールカード (名前、アドレス、コピー、検索、メールの作成) を出す。
 * いまはメールに書かれた名前とアドレスだけを出す。連絡先ができたら、ここに情報を足す。
 */
export function ProfileName({
  address,
  check,
  full = false,
  className,
  onSearch,
  onCompose,
  onSignature,
  hasSignature,
}: {
  address: Address;
  /**
   * 差出人の確認結果 (差出人のときだけ)。アイコンに BIMI のロゴやサイトのアイコンを使ってよいかに使う。
   * 宛先など確認結果の無い相手は、Gravatar (設定でオンのとき) だけを使う。
   */
  check?: SenderCheck | null;
  /** 「名前 <アドレス>」の形で出す。false なら名前だけ (無ければアドレス)。 */
  full?: boolean;
  className?: string;
} & ProfileActions) {
  const [open, setOpen] = useState(false);
  const { senderIconInProfile } = usePreferences();
  const [copied, setCopied] = useState(false);
  const narrow = useNarrowScreen();
  const swipe = useSheetSwipe(() => setOpen(false));
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const name = address.name?.trim() || null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address.address);
    } catch {
      // コピーできない環境では何もしない (アドレスは表示されているので、選択してコピーできる)。
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };
  const run = (action: (address: Address) => void) => {
    setOpen(false);
    action(address);
  };

  const label = full ? addressFull(address) : addressLabel(address);
  const triggerClass = cn(
    "max-w-full cursor-pointer rounded-sm text-left decoration-muted-foreground/60 underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:underline",
    className,
  );
  const body = (Title: typeof PopoverTitle | typeof DialogPrimitive.Title) => (
    <>
      <div className="flex items-center gap-3 max-sm:px-3.5 max-sm:pb-1">
        <SenderAvatar
          address={address}
          check={check}
          // 開いたときだけ探す (名前を並べただけでは取りに行かない)。
          enabled={senderIconInProfile && open}
          className="size-11 text-base"
        />
        <div className="min-w-0 flex-1">
          <Title className="truncate font-medium">
            {name ?? address.address}
          </Title>
          {/* 名前が無いときは、上にアドレスを出しているので繰り返さない。 */}
          {name && (
            <p className="break-all text-muted-foreground text-xs">
              {address.address}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Button
          variant="ghost"
          size="sm"
          data-sheet-item=""
          className="justify-start"
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "コピーしました" : "アドレスをコピー"}
        </Button>
        {onSearch && (
          <Button
            variant="ghost"
            size="sm"
            data-sheet-item=""
            className="justify-start"
            onClick={() => run(onSearch)}
          >
            <SearchIcon />
            このアドレスのメールを検索
          </Button>
        )}
        {onCompose && (
          <Button
            variant="ghost"
            size="sm"
            data-sheet-item=""
            className="justify-start"
            onClick={() => run(onCompose)}
          >
            <SquarePenIcon />
            メールを作成
          </Button>
        )}
        {onSignature && (
          <Button
            variant="ghost"
            size="sm"
            data-sheet-item=""
            className="justify-start"
            onClick={() => run(onSignature)}
          >
            <SignatureIcon />
            {hasSignature?.(address)
              ? "この相手への署名を変更"
              : "この相手への署名を設定"}
          </Button>
        )}
      </div>
    </>
  );

  // スマホの幅では、画面の下から出るシートにする (指で押しやすく、画面からはみ出さない)。
  if (narrow) {
    return (
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Trigger className={triggerClass}>
          {label}
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className={sheetBackdrop} />
          <DialogPrimitive.Popup
            ref={swipe}
            data-slot="profile-sheet"
            // 見た目は、メニューやピッカーのシートと共通 (globals.css の [data-menu-sheet])。
            data-menu-sheet=""
            className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 text-sm outline-none"
          >
            {body(DialogPrimitive.Title)}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={350}
        closeDelay={150}
        className={triggerClass}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3 p-3">
        {body(PopoverTitle)}
      </PopoverContent>
    </Popover>
  );
}

/** 相手の並び。「、」で区切り、1 人ずつプロフィールカードを出せる。 */
export function ProfileNames({
  addresses,
  check,
  full = false,
  separator = ", ",
  ...actions
}: {
  addresses: Address[];
  /** 差出人の確認結果。先頭の相手 (差出人) にだけ使う。 */
  check?: SenderCheck | null;
  full?: boolean;
  separator?: string;
} & ProfileActions) {
  return (
    <>
      {addresses.map((address, index) => (
        // 同じアドレスが 2 回書かれたメールもあるので、位置も鍵に含める。
        <span key={`${index}:${address.address}`}>
          {index > 0 && separator}
          <ProfileName
            address={address}
            check={index === 0 ? check : null}
            full={full}
            {...actions}
          />
        </span>
      ))}
    </>
  );
}
