"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { Spinner } from "@/components/ui/spinner";

/**
 * 画面の下に重ねて出す知らせ (トースト) の置き場。知らせはすべてここに出す。
 * 出す側は components/mail/toasts.tsx の関数を使う。
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-center"
      // 知らせが重なったときも、畳まずにすべて読めるようにする。
      expand
      // スマホ幅では、右下の「作成」ボタンに重ならない高さに出す。
      mobileOffset={{ bottom: 88, left: 16, right: 16 }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Spinner className="size-4" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: "閉じる",
        classNames: {
          toast: "cn-toast font-sans! text-sm! shadow-xl!",
          // ボタンは、指でも押しやすい大きさにする。
          actionButton:
            "h-8! shrink-0! rounded-md! px-3! font-semibold! text-sm! pointer-coarse:h-10! pointer-coarse:px-4!",
          cancelButton:
            "h-8! shrink-0! rounded-md! px-3! text-sm! pointer-coarse:h-10! pointer-coarse:px-4!",
          closeButton: "pointer-coarse:size-7!",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
