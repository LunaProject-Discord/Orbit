"use client";

import { cn } from "cn";
import { SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SearchFilters, SearchParams } from "@/lib/api";
import { countFilters, emptyFilters, isSearchActive } from "@/lib/search";

/** 検索欄の id。ショートカットキー (/) でここへ移動する。 */
export const SEARCH_INPUT_ID = "mail-search-input";

type Props = {
  value: SearchParams;
  onChange: (value: SearchParams) => void;
  /** 検索欄に出す案内 (「すべてのアカウントから検索」など)。 */
  placeholder: string;
  /** 表示中の一覧の名前。探す範囲の切り替えに使う。 */
  folderLabel: string;
};

/** 一覧の上の検索欄。語の入力と、差出人・件名・期間などの絞り込み条件を受け付ける。 */
export function SearchBar({
  value,
  onChange,
  placeholder,
  folderLabel,
}: Props) {
  const id = useId();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { filters } = value;
  const filterCount = countFilters(filters);
  const active = isSearchActive(value);
  const setFilters = (patch: Partial<SearchFilters>) =>
    onChange({ ...value, filters: { ...filters, ...patch } });

  return (
    <search className="flex shrink-0 flex-col gap-3 border-b px-4 py-3">
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={SEARCH_INPUT_ID}
          type="text"
          role="searchbox"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          aria-label="メールを検索"
          placeholder={placeholder}
          value={value.text}
          onChange={(event) => onChange({ ...value, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            // 入力があれば消し、無ければ検索欄から抜ける。
            if (value.text) onChange({ ...value, text: "" });
            else event.currentTarget.blur();
          }}
          className="pr-[4.5rem] pl-8"
        />
        <div className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center">
          {value.text && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="入力を消す"
              onClick={() => {
                onChange({ ...value, text: "" });
                document.getElementById(SEARCH_INPUT_ID)?.focus();
              }}
            >
              <XIcon />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              filterCount > 0
                ? `絞り込み条件 (${filterCount} 件を指定中)`
                : "絞り込み条件"
            }
            aria-expanded={filtersOpen}
            aria-controls={`${id}-filters`}
            onClick={() => setFiltersOpen((open) => !open)}
            className={cn("relative", filtersOpen && "bg-muted")}
          >
            <SlidersHorizontalIcon />
            {filterCount > 0 && (
              <span
                className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                aria-hidden="true"
              />
            )}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div id={`${id}-filters`} className="flex flex-col gap-3">
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <Label htmlFor={`${id}-from`} className="font-normal">
              差出人
            </Label>
            <Input
              id={`${id}-from`}
              value={filters.from}
              placeholder="名前またはアドレス"
              autoComplete="off"
              onChange={(event) => setFilters({ from: event.target.value })}
              className="h-8"
            />
            <Label htmlFor={`${id}-to`} className="font-normal">
              宛先
            </Label>
            <Input
              id={`${id}-to`}
              value={filters.to}
              placeholder="名前またはアドレス"
              autoComplete="off"
              onChange={(event) => setFilters({ to: event.target.value })}
              className="h-8"
            />
            <Label htmlFor={`${id}-subject`} className="font-normal">
              件名
            </Label>
            <Input
              id={`${id}-subject`}
              value={filters.subject}
              autoComplete="off"
              onChange={(event) => setFilters({ subject: event.target.value })}
              className="h-8"
            />
            <Label htmlFor={`${id}-since`} className="font-normal">
              期間
            </Label>
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                id={`${id}-since`}
                type="date"
                aria-label="期間の始まり"
                value={filters.since}
                max={filters.until || undefined}
                onChange={(event) => setFilters({ since: event.target.value })}
                className="h-8 min-w-0 px-1.5"
              />
              <span className="text-muted-foreground text-xs">〜</span>
              <Input
                type="date"
                aria-label="期間の終わり"
                value={filters.until}
                min={filters.since || undefined}
                onChange={(event) => setFilters({ until: event.target.value })}
                className="h-8 min-w-0 px-1.5"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {(
              [
                ["hasAttachment", "添付あり"],
                ["unread", "未読のみ"],
                ["flagged", "スター付き"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-${key}`}
                  checked={filters[key]}
                  onCheckedChange={(checked) =>
                    setFilters({ [key]: checked === true })
                  }
                />
                <Label htmlFor={`${id}-${key}`} className="font-normal">
                  {label}
                </Label>
              </div>
            ))}
            <Button
              variant="ghost"
              size="xs"
              disabled={filterCount === 0}
              onClick={() => onChange({ ...value, filters: emptyFilters })}
              className="ml-auto"
            >
              条件を消す
            </Button>
          </div>
        </div>
      )}

      {active && (
        <fieldset className="flex items-center gap-1.5">
          <legend className="sr-only">探す範囲</legend>
          {(
            [
              ["all", "すべてのフォルダ"],
              ["folder", `${folderLabel}のみ`],
            ] as const
          ).map(([scope, label]) => (
            <Button
              key={scope}
              variant={value.scope === scope ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={value.scope === scope}
              onClick={() => onChange({ ...value, scope })}
              className="min-w-0 rounded-full"
            >
              <span className="truncate">{label}</span>
            </Button>
          ))}
        </fieldset>
      )}
    </search>
  );
}
