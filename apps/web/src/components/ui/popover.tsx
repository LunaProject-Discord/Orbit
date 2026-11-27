"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "cn";
import { useRef } from "react";
import {
  SheetCloseContext,
  sheetBackdrop,
  sheetPositioner,
  useNarrowScreen,
  useSheetClose,
  useSheetSwipe,
} from "@/components/ui/menu-sheet";
import { popupCollisionPadding } from "@/lib/desktop/title-bar-height";

function Popover({ actionsRef, ...props }: PopoverPrimitive.Root.Props) {
  const sheet = useSheetClose(actionsRef);
  return (
    <SheetCloseContext.Provider value={sheet.value}>
      <PopoverPrimitive.Root
        data-slot="popover"
        actionsRef={sheet.actionsRef}
        {...props}
      />
    </SheetCloseContext.Provider>
  );
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  collisionPadding,
  anchor,
  initialFocus,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    | "align"
    | "alignOffset"
    | "side"
    | "sideOffset"
    | "collisionPadding"
    | "anchor"
  >) {
  // スマホ幅では画面の下から出るシートにする (見た目は globals.css の [data-menu-sheet])。
  const narrow = useNarrowScreen();
  const swipe = useSheetSwipe();
  const popup = useRef<HTMLDivElement | null>(null);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Backdrop className={sheetBackdrop} />
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding ?? popupCollisionPadding()}
        anchor={anchor}
        // デスクトップ版のタイトルバー (z-[60]) より手前に出す。
        className={cn("isolate z-[70]", sheetPositioner)}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          data-menu-sheet=""
          // シートを指で開いたときは、検索欄などではなくシート自体にフォーカスを置く
          // (画面のキーボードが出て、シートを隠してしまうため)。
          initialFocus={
            narrow
              ? (type) => {
                  if (type === "touch") return popup.current;
                  if (typeof initialFocus === "function") {
                    return initialFocus(type);
                  }
                  if (initialFocus && typeof initialFocus === "object") {
                    return initialFocus.current;
                  }
                  return initialFocus ?? true;
                }
              : initialFocus
          }
          className={cn(
            "z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
          ref={(element) => {
            popup.current = element;
            swipe(element);
          }}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      data-sheet-title=""
      className={cn("font-medium", className)}
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverTitle, PopoverTrigger };
