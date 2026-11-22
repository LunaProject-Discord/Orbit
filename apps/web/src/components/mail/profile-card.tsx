"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { CheckIcon, CopyIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Address } from "@/lib/api";
import { addressFull, addressLabel } from "@/lib/format";

/** プロフィールカードから始められる操作。渡さなかった操作のボタンは出さない。 */
export type ProfileActions = {
  /** このアドレスとやり取りしたメールを検索する。 */
  onSearch?: (address: Address) => void;
  /** このアドレス宛ての新しいメールを書き始める。 */
  onCompose?: (address: Address) => void;
};

/** スマホの幅 (Tailwind の sm 未満) かどうか。カードをシートで出すかを決める。 */
const NARROW_QUERY = "(max-width: 639px)";

function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(NARROW_QUERY);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** アバターに出す 1 文字 (名前の先頭。名前が無ければアドレスの先頭)。 */
export function profileInitial(address: Address): string {
  const first = Array.from(addressLabel(address).trim())[0];
  return first ? first.toUpperCase() : "?";
}

/**
 * メールの相手 (差出人や宛先) の名前。カーソルを合わせるか、押す (タッチではタップ) と、
 * プロフィールカード (名前、アドレス、コピー、検索、メールの作成) を出す。
 * いまはメールに書かれた名前とアドレスだけを出す。連絡先ができたら、ここに情報を足す。
 */
export function ProfileName({
  address,
  full = false,
  className,
  onSearch,
  onCompose,
}: {
  address: Address;
  /** 「名前 <アドレス>」の形で出す。false なら名前だけ (無ければアドレス)。 */
  full?: boolean;
  className?: string;
} & ProfileActions) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const narrow = useNarrowScreen();
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
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-base"
        >
          {profileInitial(address)}
        </span>
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
          size={narrow ? "lg" : "sm"}
          className="justify-start"
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "コピーしました" : "アドレスをコピー"}
        </Button>
        {onSearch && (
          <Button
            variant="ghost"
            size={narrow ? "lg" : "sm"}
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
            size={narrow ? "lg" : "sm"}
            className="justify-start"
            onClick={() => run(onCompose)}
          >
            <SquarePenIcon />
            メールを作成
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
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/30 duration-200 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
          <DialogPrimitive.Popup
            data-slot="profile-sheet"
            className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 rounded-t-2xl bg-popover px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] text-popover-foreground text-sm shadow-lg outline-none ring-1 ring-foreground/10 duration-200 data-closed:animate-out data-closed:slide-out-to-bottom data-open:animate-in data-open:slide-in-from-bottom"
          >
            <span
              aria-hidden="true"
              className="mx-auto mb-1 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30"
            />
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
  full = false,
  separator = ", ",
  ...actions
}: {
  addresses: Address[];
  full?: boolean;
  separator?: string;
} & ProfileActions) {
  return (
    <>
      {addresses.map((address, index) => (
        // 同じアドレスが 2 回書かれたメールもあるので、位置も鍵に含める。
        <span key={`${index}:${address.address}`}>
          {index > 0 && separator}
          <ProfileName address={address} full={full} {...actions} />
        </span>
      ))}
    </>
  );
}
