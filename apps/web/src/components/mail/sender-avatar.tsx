"use client";

import { cn } from "cn";
import { useState } from "react";
import type { Address, SenderCheck } from "@/lib/api";
import { addressLabel } from "@/lib/format";
import { useSenderIcon } from "@/lib/sender-icon";

/** アバターに出す 1 文字 (名前の先頭。名前が無ければアドレスの先頭)。 */
export function profileInitial(address: Address): string {
  const first = Array.from(addressLabel(address).trim())[0];
  return first ? first.toUpperCase() : "?";
}

/**
 * 差出人のアイコン。BIMI のロゴ、Gravatar、ドメインのファビコンの順に探し
 * (どれを使うかは lib/sender-icon.ts)、無ければ頭文字を出す。
 * 画像が届くまでは頭文字を出しておき、届いたら上に重ねる。
 */
export function SenderAvatar({
  address,
  check,
  enabled = true,
  contact = false,
  className,
}: {
  address: Address | undefined;
  check: SenderCheck | null | undefined;
  /** false なら画像を探さず、頭文字だけを出す。 */
  enabled?: boolean;
  /** 差出人でない相手 (宛先、宛先の候補)。証明書で確かめた BIMI のロゴと Gravatar だけを使う。 */
  contact?: boolean;
  /** 大きさと文字の大きさ (size-9 text-sm など)。 */
  className?: string;
}) {
  const icon = useSenderIcon(address?.address, check, enabled, contact);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = icon && icon.url !== failed ? icon : null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted font-medium",
        className,
      )}
    >
      {address ? profileInitial(address) : "?"}
      {shown && (
        // biome-ignore lint/performance/noImgElement: 取得済みの blob を表示するだけなので、画像の最適化は要らない
        <img
          src={shown.url}
          alt=""
          draggable={false}
          onError={() => setFailed(shown.url)}
          className={cn(
            "absolute inset-0 size-full",
            // サイトのアイコンは小さく透過していることが多いので、白地に余白を付けて出す。
            shown.source === "favicon"
              ? "bg-white object-contain p-[18%]"
              : "bg-white object-cover",
          )}
        />
      )}
    </span>
  );
}
