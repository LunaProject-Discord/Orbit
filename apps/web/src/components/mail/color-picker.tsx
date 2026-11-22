"use client";

import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useRef,
  useState,
} from "react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ACCOUNT_COLOR_COLUMNS,
  ACCOUNT_COLOR_PRESETS,
  ACCOUNT_DOT_CLASS,
  accountColorLabel,
  accountColorStyle,
  RECENT_COLORS_KEY,
} from "@/lib/account-colors";
import {
  type Hsv,
  hexToHsv,
  hsvToHex,
  normalizeHex,
  textOn,
} from "@/lib/color";
import { addRecent, readRecent } from "@/lib/picker";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * アカウントの色を選ぶボタン。押すと、色の見本 (明るい色と濃い色)、最近使った色、
 * 自由に色を作る欄 (色合い・鮮やかさ・明るさ、または #RRGGBB の入力) が出る。
 */
export function ColorPicker({
  value,
  chosen,
  onChange,
  labelledBy,
}: {
  /** いま出している色 ("#rrggbb")。選んでいなければ、自動で割り当てた色。 */
  value: string;
  /** 利用者が色を選んでいるか (false なら、自動で割り当てた色)。 */
  chosen: boolean;
  /** 選んだ色。null は「自動の色に戻す」。 */
  onChange: (next: string | null) => void;
  /** このボタンの名前になる要素の id。 */
  labelledBy: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const custom = hsvToHex(hsv);
  const typed = normalizeHex(text);
  const isPreset = ACCOUNT_COLOR_PRESETS.some((item) => item.hex === value);

  const choose = (next: string | null, remember = false) => {
    setOpen(false);
    if (next !== null && remember) addRecent(RECENT_COLORS_KEY, next);
    if (next === null ? chosen : !chosen || next !== value) onChange(next);
  };
  const edit = (next: Hsv) => {
    setHsv(next);
    setText(hsvToHex(next));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // 開くたびに、いまの色から作り始める。
          setHsv(hexToHsv(value));
          setText(value);
          setRecent(
            readRecent(RECENT_COLORS_KEY)
              .map(normalizeHex)
              .filter((item): item is string => item !== null)
              .slice(0, ACCOUNT_COLOR_COLUMNS),
          );
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            id={`${id}-trigger`}
            aria-labelledby={`${labelledBy} ${id}-trigger`}
            style={accountColorStyle(value)}
            className="justify-start gap-2 font-normal"
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 rounded-full", ACCOUNT_DOT_CLASS)}
        />
        <span className={cn(!accountColorLabel(value) && "tabular-nums")}>
          {accountColorLabel(value) ?? value.toUpperCase()}
        </span>
        <ChevronDownIcon className="text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[17.5rem] gap-3 p-3">
        <PopoverTitle className="sr-only">色を選ぶ</PopoverTitle>

        <Swatches
          label="色の見本"
          colors={ACCOUNT_COLOR_PRESETS.map((item) => item.hex)}
          value={value}
          onChoose={(hex) => choose(hex)}
        />

        {recent.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-xs">最近使った色</p>
            <Swatches
              label="最近使った色"
              colors={recent}
              value={isPreset ? null : value}
              onChoose={(hex) => choose(hex, true)}
            />
          </div>
        )}

        <form
          className="flex flex-col gap-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed) choose(typed, true);
          }}
        >
          <p className="text-muted-foreground text-xs">色を作る</p>
          <ShadeArea hsv={hsv} onChange={edit} />
          <HueSlider hsv={hsv} onChange={edit} />
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-8 shrink-0 rounded-md ring-1 ring-foreground/10"
              style={{ backgroundColor: typed ?? custom }}
            />
            <Input
              value={text}
              maxLength={9}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-label="色のコード (#RRGGBB)"
              aria-invalid={typed === null}
              placeholder="#RRGGBB"
              onChange={(event) => {
                setText(event.target.value);
                const next = normalizeHex(event.target.value);
                if (next) setHsv(hexToHsv(next));
              }}
              className="h-8 font-mono uppercase"
            />
            <Button type="submit" size="sm" disabled={typed === null}>
              決定
            </Button>
          </div>
        </form>

        <div className="flex items-center justify-between gap-2 border-t pt-2">
          <p className="text-[11px] text-muted-foreground leading-snug">
            見やすいように、画面の配色に合わせて明るさを調整して表示します。
          </p>
          <Button
            variant="ghost"
            size="xs"
            disabled={!chosen}
            onClick={() => choose(null)}
            className="shrink-0"
          >
            自動に戻す
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 色の見本の並び。矢印キーで動かせる。 */
function Swatches({
  label,
  colors,
  value,
  onChoose,
}: {
  label: string;
  colors: readonly string[];
  value: string | null;
  onChoose: (hex: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = value === null ? -1 : colors.indexOf(value);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -ACCOUNT_COLOR_COLUMNS,
        ArrowDown: ACCOUNT_COLOR_COLUMNS,
      }[event.key] ?? 0;
    const next = index + step;
    if (step === 0 || next < 0 || next >= colors.length) return;
    event.preventDefault();
    ref.current?.querySelectorAll("button")[next]?.focus();
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className="grid grid-cols-10 gap-1.5"
    >
      {colors.map((hex, index) => {
        const name = accountColorLabel(hex) ?? hex.toUpperCase();
        return (
          <Hint key={hex} label={name}>
            {/* biome-ignore lint/a11y/useSemanticElements: 色の見本をそのまま選択肢にするため、radio の役割を持つボタンにしている */}
            <button
              type="button"
              role="radio"
              aria-checked={index === selected}
              aria-label={name}
              tabIndex={index === Math.max(selected, 0) ? 0 : -1}
              onClick={() => onChoose(hex)}
              onKeyDown={(event) => move(event, index)}
              style={{ backgroundColor: hex, color: textOn(hex) }}
              className={cn(
                "flex aspect-square items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-popover transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                index === selected && "ring-2 ring-foreground/40",
              )}
            >
              {index === selected && (
                <CheckIcon className="size-3" aria-hidden="true" />
              )}
            </button>
          </Hint>
        );
      })}
    </div>
  );
}

/** ドラッグ中の位置 (0〜1) を伝える。 */
function useDrag(onMove: (x: number, y: number) => void) {
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onMove(
      clamp((event.clientX - rect.left) / rect.width),
      clamp((event.clientY - rect.top) / rect.height),
    );
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      move(event);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
    },
  };
}

const THUMB_CLASS =
  "pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.3)]";

/** 鮮やかさ (横) と明るさ (縦) を選ぶ面。 */
function ShadeArea({
  hsv,
  onChange,
}: {
  hsv: Hsv;
  onChange: (next: Hsv) => void;
}) {
  const drag = useDrag((x, y) => onChange({ ...hsv, s: x, v: 1 - y }));
  const percent = (value: number) => Math.round(value * 100);
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="鮮やかさと明るさ"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent(hsv.s)}
      aria-valuetext={`鮮やかさ ${percent(hsv.s)}%、明るさ ${percent(hsv.v)}%`}
      {...drag}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 0.1 : 0.02;
        const [ds, dv] = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        }[event.key] ?? [0, 0];
        if (ds === 0 && dv === 0) return;
        event.preventDefault();
        onChange({ ...hsv, s: clamp(hsv.s + ds), v: clamp(hsv.v + dv) });
      }}
      style={{
        backgroundColor: `hsl(${hsv.h} 100% 50%)`,
        backgroundImage:
          "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
      }}
      className="relative h-32 cursor-crosshair touch-none rounded-md outline-none ring-1 ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={THUMB_CLASS}
        style={{
          left: `${hsv.s * 100}%`,
          top: `${(1 - hsv.v) * 100}%`,
          backgroundColor: hsvToHex(hsv),
        }}
      />
    </div>
  );
}

/** 色合いを選ぶつまみ。 */
function HueSlider({
  hsv,
  onChange,
}: {
  hsv: Hsv;
  onChange: (next: Hsv) => void;
}) {
  const drag = useDrag((x) => onChange({ ...hsv, h: Math.round(x * 360) }));
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="色合い"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hsv.h)}
      {...drag}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 30 : 3;
        const delta =
          {
            ArrowLeft: -step,
            ArrowDown: -step,
            ArrowRight: step,
            ArrowUp: step,
          }[event.key] ?? 0;
        if (delta === 0) return;
        event.preventDefault();
        onChange({ ...hsv, h: Math.min(360, Math.max(0, hsv.h + delta)) });
      }}
      style={{
        backgroundImage:
          "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
      }}
      className="relative h-3 cursor-pointer touch-none rounded-full outline-none ring-1 ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={THUMB_CLASS}
        style={{
          left: `${(hsv.h / 360) * 100}%`,
          top: "50%",
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
        }}
      />
    </div>
  );
}
