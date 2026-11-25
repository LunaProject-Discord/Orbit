"use client";

import { cn } from "cn";
import {
  ArrowLeftIcon,
  AtSignIcon,
  CalendarIcon,
  ClockIcon,
  FileSearchIcon,
  FolderIcon,
  PaperclipIcon,
  SearchIcon,
  TagIcon,
  TextIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ja } from "react-day-picker/locale";
import { createPortal } from "react-dom";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { formatDateValue, parseDateValue } from "@/components/ui/date-picker";
import type { Account, MailboxSummary, SearchParams } from "@/lib/api";
import {
  type ContactSuggestion,
  useSearchContacts,
} from "@/lib/search-contacts";
import { type FolderSuggestion, folderSuggestions } from "@/lib/search-folders";
import {
  ADDRESS_OPERATORS,
  addSearchHistory,
  chipLabel,
  completeQuery,
  DATE_OPERATORS,
  FOLDER_OPERATORS,
  hasOpenSpace,
  type InPlaceDraft,
  type InputToken,
  inPlaceText,
  joinChips,
  joinSearchInput,
  normalizeQuery,
  OPERATOR_VALUES,
  quoteValue,
  readSearchHistory,
  removeSearchHistory,
  replaceToken,
  SEARCH_OPERATORS,
  type SearchChip,
  type SearchOperator,
  splitChipRaw,
  splitSearchInput,
  tokenAt,
  writeSearchHistory,
} from "@/lib/search-input";

/** 検索欄の id。ショートカットキー (/) でここへ移動する。 */
export const SEARCH_INPUT_ID = "mail-search-input";

/** 候補の 1 行。 */
type Suggestion = {
  id: string;
  icon: ReactNode;
  label: ReactNode;
  /** 行の右に添える説明。 */
  detail?: ReactNode;
  apply: () => void;
  /** 候補から消せる行 (最近の検索) なら、消す処理。 */
  remove?: () => void;
};

type Section = { title: string; items: Suggestion[]; action?: ReactNode };

const operatorIcons: Record<SearchOperator["key"], ReactNode> = {
  from: <UserIcon />,
  to: <AtSignIcon />,
  subject: <TagIcon />,
  body: <TextIcon />,
  folder: <FolderIcon />,
  has: <PaperclipIcon />,
  is: <SearchIcon />,
  after: <CalendarIcon />,
  before: <CalendarIcon />,
};

/** 検索した語を、この端末の「最近の検索」に残す。 */
export function rememberSearch(text: string) {
  if (normalizeQuery(text) === "") return;
  writeSearchHistory(addSearchHistory(readSearchHistory(), text));
}

type Props = {
  value: SearchParams;
  onChange: (value: SearchParams) => void;
  /** Enter などで検索を確定した (入力が止まるのを待たずに、この語で検索する)。 */
  onSubmit: (text: string) => void;
  /** 検索欄に出す案内 (「すべてのアカウントから検索」など)。 */
  placeholder: string;
  /**
   * popup: 一覧の右上などに置く小さな検索欄。候補は欄の下に浮かべて出す (Web・デスクトップ)。
   * screen: スマホの検索画面。欄はアプリバーいっぱいに広げ、候補は欄の下の画面全体に出す。
   */
  variant: "popup" | "screen";
  /** 開いているメールの中を探す。メールを開いていなければ undefined。 */
  onFindInMessage?: (text: string) => void;
  /** screen のとき、戻るボタンで検索画面を閉じる。 */
  onClose?: () => void;
  /** screen のとき、検索画面を開いた直後に欄へ入力できるようにする。 */
  autoFocus?: boolean;
  className?: string;
  /** folder: の候補に出すフォルダ (全アカウント分) と、その持ち主のアカウント。 */
  folders?: {
    mailboxes: readonly MailboxSummary[];
    accounts: readonly Account[];
  };
};

/**
 * 検索欄。入力中の語に合わせて、演算子 (from: など)、相手のアドレス、日付、最近の検索、
 * 開いているメールの中の検索を候補に出す (Discord の検索欄のような動き)。
 */
export function SearchBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  variant,
  onFindInMessage,
  onClose,
  autoFocus,
  className,
  folders,
}: Props) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 条件の並びが左右に隠れているか (端を薄くするため)。
  const [chipsOverflow, setChipsOverflow] = useState({
    start: false,
    end: false,
  });
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.text.length);
  const [active, setActive] = useState(-1);
  const [history, setHistory] = useState<string[]>([]);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    right: number;
  } | null>(null);
  /**
   * 検索欄の入力の全体。入力し終えた条件はチップにし、入力中の条件 (末尾の「from:…」) は
   * チップの中で値を入力する。欄 (input) には、入力中の条件の値か、条件以外の語を出す。
   */
  const full = value.text;
  const parts = splitSearchInput(full);
  /**
   * 確定したチップをその場で編集しているとき (押すか、矢印キーで入ったとき)。
   * 編集中の値は検索の書き方として成り立たないこともあるので、入力の全体からは読み直さず、
   * ここに持つ。入力が外から変わったら (最近の検索を選んだなど) やめる。
   */
  const [inPlaceState, setInPlace] = useState<
    | (InPlaceDraft & {
        at: number;
        others: SearchChip[];
        rest: string;
        text: string;
      })
    | null
  >(null);
  const inPlace =
    inPlaceState && inPlaceState.text === full ? inPlaceState : null;
  const chips = inPlace ? inPlace.others : parts.chips;
  const rest = inPlace ? inPlace.rest : parts.rest;
  const editing = inPlace ? null : parts.editing;
  const text = inPlace ? inPlace.value : editing ? editing.value : rest;
  /** 欄 (input) を包むチップ。その場で編集しているチップか、末尾の入力中の条件。 */
  const slot = inPlace ?? editing;
  const token: InputToken = inPlace
    ? {
        start: 0,
        end: 0,
        negated: inPlace.negated,
        key: inPlace.key,
        value: inPlace.value.replace(/["“”]/gu, ""),
      }
    : editing
      ? {
          start: full.length - editing.prefix.length - editing.value.length,
          end: full.length,
          negated: editing.negated,
          key: editing.key,
          value: editing.value.replace(/["“”]/gu, ""),
        }
      : tokenAt(rest, Math.min(caret, rest.length));
  const screen = variant === "screen";

  const contactQuery = ADDRESS_OPERATORS.includes(
    token.key as (typeof ADDRESS_OPERATORS)[number],
  )
    ? token.value
    : token.key === "" && token.value.length >= 1
      ? token.value
      : null;
  const isFolderKey = FOLDER_OPERATORS.includes(
    token.key as (typeof FOLDER_OPERATORS)[number],
  );
  const folderOptions = useMemo(
    () =>
      isFolderKey && folders
        ? folderSuggestions(folders.mailboxes, folders.accounts, token.value, 8)
        : [],
    [isFolderKey, folders, token.value],
  );
  const contacts = useSearchContacts(
    contactQuery ?? "",
    contactQuery === null ? 0 : token.key ? 8 : 4,
  );

  /** 欄にカーソルを置く (描画のあと)。 */
  const placeCaret = (position: number) => {
    setCaret(position);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(position, position);
    });
  };
  /**
   * 入力の全体を置き換える。チップが増えたり減ったり、入力中の条件に入ったり出たりして
   * 欄の中身が入れ替わったときは、カーソルを欄の末尾に置く。
   */
  const apply = (next: string, nextCaret?: number) => {
    onChange({ ...value, text: next });
    const after = splitSearchInput(next);
    const changed =
      after.chips.length !== chips.length ||
      after.editing?.key !== editing?.key ||
      (after.editing === null) !== (editing === null);
    const view = after.editing ? after.editing.value : after.rest;
    if (changed) placeCaret(view.length);
    else if (nextCaret !== undefined) placeCaret(nextCaret);
  };
  const setFull = (next: string) => {
    const after = splitSearchInput(next);
    onChange({ ...value, text: next });
    placeCaret((after.editing ? after.editing.value : after.rest).length);
  };
  /** 欄の文字が変わった。入力中の条件の値なら、空白で区切った時点でチップにする。 */
  const setText = (next: string, nextCaret?: number) => {
    if (inPlace) {
      setInPlaceValue(next, nextCaret);
      return;
    }
    if (!editing) {
      apply(joinSearchInput({ chips, rest: next, editing: null }), nextCaret);
      return;
    }
    if (!hasOpenSpace(next)) {
      apply(
        joinSearchInput({ chips, rest, editing: { ...editing, value: next } }),
        nextCaret,
      );
      return;
    }
    // 値を入力し終えた。空白の後ろ (貼り付けた文字など) は、条件以外の語にする。
    const trimmed = next.trimStart();
    const space = trimmed.search(/\s/u);
    const head = space === -1 ? trimmed : trimmed.slice(0, space);
    const tail = space === -1 ? "" : trimmed.slice(space).trim();
    const base = joinSearchInput({ chips, rest, editing: null });
    const spacer = base === "" || /\s$/u.test(base) ? "" : " ";
    const committed =
      head === "" ? base : `${base}${spacer}${editing.prefix}${head} `;
    apply(
      tail
        ? `${committed}${/\s$/u.test(committed) ? "" : " "}${tail}`
        : committed,
    );
  };
  const removeChip = (index: number) => {
    if (inPlace) {
      // その場で編集しているチップはそのままにして、ほかのチップを外す。
      const others = inPlace.others.filter((_, item) => item !== index);
      const at = index < inPlace.at ? inPlace.at - 1 : inPlace.at;
      const nextText = inPlaceText(others, at, inPlace, inPlace.rest);
      onChange({ ...value, text: nextText });
      setInPlace({ ...inPlace, others, at, text: nextText });
      return;
    }
    apply(
      joinSearchInput({
        chips: chips.filter((_, item) => item !== index),
        rest,
        editing,
      }),
      Math.min(caret, text.length),
    );
  };
  /**
   * いまの入力を、チップと条件以外の語に分け直す。入力中の条件は、値があれば確定し、
   * 空なら捨てる。その場で編集しているチップも元の位置に確定する。
   */
  const settledParts = (): { chips: SearchChip[]; rest: string } => {
    if (inPlace) return splitSearchInput(inPlace.text);
    if (editing && editing.value.trim() !== "") {
      return splitSearchInput(`${full} `);
    }
    return splitSearchInput(joinSearchInput({ chips, rest, editing: null }));
  };
  /** index 番目の確定したチップを、その場で編集する。 */
  const enterChip = (
    settled: { chips: SearchChip[]; rest: string },
    index: number,
    caretAt: "start" | "end",
  ) => {
    const target = settled.chips[index];
    const split = target ? splitChipRaw(target.raw) : null;
    if (!target || !split) return;
    const others = settled.chips.filter((_, item) => item !== index);
    const draft: InPlaceDraft = {
      key: target.key,
      negated: target.negated,
      prefix: split.prefix,
      value: split.value,
    };
    const nextText = inPlaceText(others, index, draft, settled.rest);
    if (nextText !== full) onChange({ ...value, text: nextText });
    setInPlace({
      ...draft,
      at: index,
      others,
      rest: settled.rest,
      text: nextText,
    });
    placeCaret(caretAt === "end" ? split.value.length : 0);
  };
  /** 確定したチップを押したら、その場で値を直せるようにする。 */
  const editChip = (index: number) => {
    const settled = settledParts();
    // その場で編集しているチップがあれば、それを確定した後の位置に直す。
    const shift =
      inPlace &&
      index >= inPlace.at &&
      settled.chips.length > inPlace.others.length
        ? 1
        : 0;
    enterChip(settled, index + shift, "end");
    openPanel();
  };
  /**
   * その場での編集を終える。next: 次のチップへ、prev: 前のチップへ、
   * end: 普通の入力 (条件以外の語の末尾) へ、start: 普通の入力の先頭へ、none: フォーカスは動かさない。
   */
  const leaveChip = (to: "next" | "prev" | "end" | "start" | "none") => {
    if (!inPlace) return;
    const settled = splitSearchInput(inPlace.text);
    const kept = settled.chips.length > inPlace.others.length;
    if (to === "prev" && inPlace.at > 0) {
      enterChip(settled, inPlace.at - 1, "end");
      return;
    }
    if (to === "next") {
      const index = kept ? inPlace.at + 1 : inPlace.at;
      if (index < settled.chips.length) {
        enterChip(settled, index, "start");
        return;
      }
    }
    setInPlace(null);
    if (to === "none") {
      setCaret(settled.rest.length);
      return;
    }
    placeCaret(to === "end" ? settled.rest.length : 0);
  };
  /** その場で編集しているチップの値が変わった。空白で区切ったら確定する。 */
  const setInPlaceValue = (next: string, nextCaret?: number) => {
    if (!inPlace) return;
    let draftValue = next;
    let nextRest = inPlace.rest;
    let done = false;
    if (hasOpenSpace(next)) {
      // 値を入力し終えた。空白の後ろ (貼り付けた文字など) は、条件以外の語にする。
      const trimmed = next.trimStart();
      const space = trimmed.search(/\s/u);
      draftValue = space === -1 ? trimmed : trimmed.slice(0, space);
      const tail = space === -1 ? "" : trimmed.slice(space).trim();
      if (tail) nextRest = nextRest ? `${nextRest} ${tail}` : tail;
      done = true;
    }
    const draft = { ...inPlace, value: draftValue, rest: nextRest };
    const nextText = inPlaceText(inPlace.others, inPlace.at, draft, nextRest);
    onChange({ ...value, text: nextText });
    if (done) {
      setInPlace(null);
      placeCaret(splitSearchInput(nextText).rest.length);
      return;
    }
    setInPlace({ ...draft, text: nextText });
    if (nextCaret !== undefined) setCaret(nextCaret);
  };
  const replace = (target: InputToken, replacement: string) => {
    if (inPlace) {
      // その場で編集しているチップの値を、選んだ候補にして確定する。
      const split = splitChipRaw(replacement);
      const draft = split
        ? { ...inPlace, prefix: split.prefix, value: split.value }
        : { ...inPlace, value: "" };
      const nextRest = split
        ? inPlace.rest
        : [inPlace.rest, replacement].filter(Boolean).join(" ");
      const nextText = inPlaceText(inPlace.others, inPlace.at, draft, nextRest);
      onChange({ ...value, text: nextText });
      setInPlace(null);
      placeCaret(splitSearchInput(nextText).rest.length);
      return;
    }
    if (editing) {
      apply(replaceToken(full, target, replacement).text);
      return;
    }
    const result = replaceToken(rest, target, replacement);
    apply(
      joinSearchInput({ chips, rest: result.text, editing: null }),
      result.caret,
    );
  };
  const submit = (query = full) => {
    rememberSearch(query);
    setHistory(readSearchHistory());
    setOpen(false);
    onSubmit(query);
    // スマホでは、画面のキーボードを閉じて結果を見せる。
    if (screen) inputRef.current?.blur();
  };

  const sections = buildSections({
    text: full,
    token,
    contacts: contactQuery === null ? [] : contacts,
    folders: folderOptions,
    history,
    onFindInMessage: onFindInMessage
      ? (query) => {
          setOpen(false);
          onFindInMessage(query);
        }
      : undefined,
    replace,
    runHistory: (query) => {
      setFull(query);
      submit(query);
    },
    removeHistory: (query) => {
      const next = removeSearchHistory(readSearchHistory(), query);
      writeSearchHistory(next);
      setHistory(next);
    },
    clearHistory: () => {
      writeSearchHistory([]);
      setHistory([]);
    },
  });
  const items = sections.flatMap((section) => section.items);
  const dateKey = DATE_OPERATORS.includes(
    token.key as (typeof DATE_OPERATORS)[number],
  )
    ? token.key
    : null;
  const showPanel = open && (items.length > 0 || dateKey !== null);

  // 入力中の語が変わったら、候補の選択を戻す。演算子の値の候補は、最初の行を選んでおく。
  const tokenKey = `${token.start}:${token.key}:${token.value}`;
  const prefersFirst =
    token.key !== "" &&
    (ADDRESS_OPERATORS.includes(
      token.key as (typeof ADDRESS_OPERATORS)[number],
    ) ||
      token.key in OPERATOR_VALUES);
  const [shownToken, setShownToken] = useState(tokenKey);
  if (shownToken !== tokenKey) {
    setShownToken(tokenKey);
    setActive(prefersFirst ? 0 : -1);
  }
  const activeIndex = active >= items.length ? -1 : active;

  // 候補を欄の下に置く。欄の幅が変わる (フォーカスで広がる) ときも追いかける。
  useLayoutEffect(() => {
    if (!open) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const update = () => {
      const rect = wrapper.getBoundingClientRect();
      setPosition({
        top: rect.bottom,
        left: rect.left,
        right: window.innerWidth - rect.right,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrapper);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // 欄と候補の外を押したら閉じる。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        wrapperRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // 欄 (チップと入力欄) は全体で横にスクロールする。入力すると、カーソルのある入力欄が
  // 見えるところまで送る (input の中のスクロールは、外側の枠までは動かさないため)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 入力が変わったときだけ動かす
  useEffect(() => {
    const scroller = scrollRef.current;
    const input = inputRef.current;
    if (!scroller) return;
    if (input && document.activeElement === input) revealInput(scroller, input);
    measureChips(scroller);
  }, [full, chips.length]);

  // 欄の幅が変わったときも、端の薄さを付け直す。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 初めに一度だけ付ける
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureChips(scroller));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  /** 入力欄 (のカーソルの辺り) が見えるよう、欄を横に送る。 */
  function revealInput(scroller: HTMLElement, input: HTMLInputElement) {
    const view = scroller.getBoundingClientRect();
    const box = input.getBoundingClientRect();
    // 入力欄の中のカーソルの位置は測れないので、末尾にあるときは欄の右端、それ以外は左端を見せる。
    const atEnd =
      (input.selectionEnd ?? input.value.length) >= input.value.length;
    if (atEnd && box.right > view.right) {
      scroller.scrollLeft += box.right - view.right;
    } else if (box.left < view.left) {
      scroller.scrollLeft -= view.left - box.left;
    }
  }

  function measureChips(list: HTMLElement) {
    const start = list.scrollLeft > 1;
    const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setChipsOverflow((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }

  // 選んでいる候補が見えるようにする。
  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`${id}-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id]);

  useEffect(() => {
    if (!autoFocus) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [autoFocus]);

  const openPanel = () => {
    setHistory(readSearchHistory());
    setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!open) {
          openPanel();
          return;
        }
        if (items.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => {
          const from = current >= items.length ? -1 : current;
          const next = from + step;
          return next < -1
            ? items.length - 1
            : next >= items.length
              ? -1
              : next;
        });
        return;
      }
      case "Enter": {
        event.preventDefault();
        const item = showPanel ? items[activeIndex] : undefined;
        if (item) {
          item.apply();
          return;
        }
        if (inPlace) {
          setInPlace(null);
          submit();
          return;
        }
        // 入力中の条件は、チップにしてから検索する。
        if (editing && editing.value.trim() !== "") {
          const committed = `${full} `;
          apply(committed);
          submit(committed);
          return;
        }
        submit();
        return;
      }
      case "Tab": {
        const item = showPanel ? items[activeIndex] : undefined;
        if (!item) return;
        event.preventDefault();
        item.apply();
        return;
      }
      case "Delete": {
        // 選んでいる最近の検索を消す (ブラウザーの候補と同じ操作)。
        const item = showPanel ? items[activeIndex] : undefined;
        if (!item?.remove) return;
        event.preventDefault();
        item.remove();
        return;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        // カーソルが欄の端にあれば、隣のチップの中へ移る。
        if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
          return;
        }
        const input = event.currentTarget;
        if (input.selectionStart !== input.selectionEnd) return;
        const at = input.selectionStart ?? 0;
        if (event.key === "ArrowRight") {
          if (!inPlace || at < input.value.length) return;
          event.preventDefault();
          leaveChip("next");
          return;
        }
        if (at !== 0) return;
        if (inPlace) {
          if (inPlace.at === 0) return;
          event.preventDefault();
          leaveChip("prev");
          return;
        }
        if (editing) {
          event.preventDefault();
          const settled = settledParts();
          if (rest !== "") {
            // 入力中の条件を確定し、条件以外の語の末尾へ戻る。
            setFull(joinSearchInput({ ...settled, editing: null }));
            return;
          }
          if (chips.length > 0) enterChip(settled, chips.length - 1, "end");
          else setFull(joinSearchInput({ ...settled, editing: null }));
          return;
        }
        if (chips.length === 0) return;
        event.preventDefault();
        enterChip(settledParts(), chips.length - 1, "end");
        return;
      }
      case "Backspace": {
        const input = event.currentTarget;
        if (input.selectionStart !== 0 || input.selectionEnd !== 0) return;
        if (inPlace) {
          // 値を消し終えたチップで押したら、チップごと消して前へ移る。
          if (inPlace.value !== "") return;
          event.preventDefault();
          leaveChip(inPlace.at > 0 ? "prev" : "start");
          return;
        }
        if (editing) {
          // 値の無い条件で押したら、条件をやめて普通の入力に戻る。
          if (editing.value !== "") return;
          event.preventDefault();
          apply(joinSearchInput({ chips, rest, editing: null }));
          return;
        }
        const last = chips[chips.length - 1];
        if (!last) return;
        event.preventDefault();
        if (rest === "") {
          // 直前のチップの値を、もう一度入力できるようにする。
          apply(`${joinChips(chips.slice(0, -1), "")}${last.raw}`);
        } else {
          removeChip(chips.length - 1);
        }
        return;
      }
      case "Escape": {
        if (showPanel && !screen) {
          event.preventDefault();
          setOpen(false);
          return;
        }
        if (inPlace) {
          event.preventDefault();
          leaveChip("end");
          return;
        }
        // 入力があれば消し、無ければ検索欄から抜ける。
        if (full) setFull("");
        else if (screen) onClose?.();
        else event.currentTarget.blur();
        return;
      }
    }
  };

  const panel =
    showPanel && position
      ? createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: 押してもフォーカスを欄に残すためだけの処理
          <div
            ref={panelRef}
            id={`${id}-panel`}
            // 押しても欄からフォーカスを外さない (入力を続けられるように)。カレンダーは除く。
            onMouseDown={(event) => {
              if (
                !(event.target as HTMLElement).closest("[data-search-calendar]")
              ) {
                event.preventDefault();
              }
            }}
            style={
              screen
                ? { top: position.top }
                : {
                    top: position.top + 6,
                    right: Math.max(8, position.right),
                  }
            }
            className={cn(
              "fixed z-50 flex flex-col overflow-y-auto overscroll-contain bg-popover text-popover-foreground",
              screen
                ? "inset-x-0 bottom-0 border-t pb-[env(safe-area-inset-bottom)]"
                : "max-h-[min(32rem,calc(100dvh-var(--titlebar-height)-6rem))] w-[min(26rem,calc(100vw-1rem))] rounded-lg border shadow-lg",
            )}
          >
            {dateKey && (
              <div className="flex flex-col border-b" data-search-calendar="">
                <p className="px-3 pt-3 font-medium text-muted-foreground text-xs">
                  {dateKey === "after" || dateKey === "since"
                    ? "この日以降のメールを探す"
                    : "この日より前のメールを探す"}
                </p>
                <Calendar
                  mode="single"
                  locale={ja}
                  selected={parseDateValue(token.value)}
                  defaultMonth={parseDateValue(token.value)}
                  onSelect={(date) => {
                    if (!date) return;
                    replace(
                      token,
                      `${token.negated ? "-" : ""}${token.key}:${formatDateValue(date)}`,
                    );
                  }}
                  className="mx-auto bg-transparent"
                />
              </div>
            )}
            <div role="listbox" id={`${id}-listbox`} aria-label="検索の候補">
              {(() => {
                let index = 0;
                return sections.map((section) => (
                  // biome-ignore lint/a11y/useSemanticElements: listbox の中のまとまり
                  <div
                    key={section.title}
                    role="group"
                    aria-label={section.title}
                    className="flex flex-col py-1.5"
                  >
                    <div className="flex items-center justify-between px-3 py-1">
                      <span className="font-medium text-muted-foreground text-xs">
                        {section.title}
                      </span>
                      {section.action}
                    </div>
                    {section.items.map((item) => {
                      const itemIndex = index++;
                      return (
                        // biome-ignore lint/a11y/useFocusableInteractive: フォーカスは欄に置いたまま、aria-activedescendant で選ぶ
                        // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードでは欄の矢印キーと Enter で選ぶ
                        <div
                          key={item.id}
                          id={`${id}-option-${itemIndex}`}
                          role="option"
                          aria-selected={itemIndex === activeIndex}
                          onClick={item.apply}
                          onPointerMove={() => setActive(itemIndex)}
                          className={cn(
                            "mx-1.5 flex min-h-9 cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-sm pointer-coarse:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                            itemIndex === activeIndex &&
                              "bg-accent text-accent-foreground",
                          )}
                        >
                          {item.icon}
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                          {item.detail && (
                            <span className="shrink-0 truncate text-muted-foreground text-xs">
                              {item.detail}
                            </span>
                          )}
                          {item.remove && (
                            <Hint label="最近の検索から消す" shortcut="Delete">
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`「${item.id.slice("history-".length)}」を最近の検索から消す`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  item.remove?.();
                                }}
                                className="-my-1 -mr-1 shrink-0"
                              >
                                <XIcon />
                              </Button>
                            </Hint>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <search
      className={cn(
        "min-w-0",
        // 狭い枠では虫めがねだけを出し、押したら左へ広げてツールバーに重ねる (Discord と同じ動き)。
        !screen && "relative h-8 w-8 shrink-0 @3xl/pane:w-44",
        className,
      )}
    >
      <div
        ref={wrapperRef}
        className={cn(
          "group/search flex min-w-0 items-center",
          screen
            ? "h-full gap-1"
            : "absolute inset-y-0 right-0 z-10 w-full rounded-md bg-background transition-[width] duration-200 focus-within:w-[min(24rem,calc(100cqw-2rem))]",
        )}
      >
        {screen && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="検索を閉じる"
            onClick={onClose}
            className="-ml-2 shrink-0 pointer-coarse:-ml-2.5"
          >
            <ArrowLeftIcon />
          </Button>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 欄の余白 (チップの横など) を押しても入力できるようにするだけ */}
        <div
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest("button, input")) return;
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            "flex min-w-0 flex-1 cursor-text items-center",
            screen
              ? "h-10 gap-1.5"
              : "h-8 gap-1.5 overflow-hidden rounded-md border border-input bg-muted/40 pr-1 pl-2 transition-colors focus-within:border-ring focus-within:bg-background focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
          )}
        >
          {!screen && (
            <SearchIcon
              className="pointer-events-none size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          {/* チップと入力欄は、ひとまとまりで横にスクロールする。 */}
          <div
            ref={scrollRef}
            onScroll={(event) => measureChips(event.currentTarget)}
            className={cn(
              "flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              // 隠れている側の端は、欄の端で切れて見えないよう薄くする。
              chipsOverflow.start &&
                chipsOverflow.end &&
                "[mask-image:linear-gradient(to_right,transparent,#000_1rem,#000_calc(100%-1rem),transparent)]",
              chipsOverflow.start &&
                !chipsOverflow.end &&
                "[mask-image:linear-gradient(to_right,transparent,#000_1rem)]",
              !chipsOverflow.start &&
                chipsOverflow.end &&
                "[mask-image:linear-gradient(to_right,#000_calc(100%-1rem),transparent)]",
            )}
          >
            {chips.length > 0 && (
              <ul
                aria-label="検索の条件"
                className={cn(
                  // チップは欄 (スクロールする枠) の中に直接並べる。その場で編集しているチップの
                  // 欄 (input) は、order でチップの間に置く (欄を作り直すとフォーカスが外れるため)。
                  "contents",
                  // 虫めがねだけの狭い表示では、広げている間だけ出す。
                  !screen &&
                    "hidden group-focus-within/search:contents @3xl/pane:contents",
                )}
              >
                {chips.map((chip, index) => {
                  const { label, value: chipValue } = chipLabel(chip);
                  return (
                    <li
                      // 同じ条件を 2 回書くこともあるので、位置も含める。
                      key={`${index}:${chip.raw}`}
                      className={chipClass(chip.negated, screen, false)}
                      style={{
                        order:
                          inPlace && index >= inPlace.at ? index + 1 : index,
                      }}
                    >
                      <button
                        type="button"
                        // 欄からフォーカスを外さない (その場での編集を続けたまま切り替える)。
                        onMouseDown={(event) => event.preventDefault()}
                        aria-label={`${chip.negated ? "除外の条件 " : ""}${label} ${chipValue} を編集`}
                        onClick={() => editChip(index)}
                        className="-ml-1 flex min-w-0 cursor-pointer items-center gap-1 self-stretch rounded-sm pl-1 outline-none transition-colors hover:bg-current/5 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChipHead
                          chipKey={chip.key}
                          label={label}
                          negated={chip.negated}
                        />
                        <span
                          className={cn(
                            "truncate font-semibold",
                            screen ? "max-w-32" : "max-w-28",
                          )}
                        >
                          {chipValue}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`${chip.negated ? "除外の条件 " : ""}${label} ${chipValue} を外す`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => removeChip(index)}
                        className={cn(
                          "relative flex shrink-0 items-center justify-center rounded-sm opacity-60 outline-none transition after:absolute after:-inset-1 hover:bg-current/10 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:after:-inset-2.5",
                          // 押せる範囲の右側はチップの端で止める (はみ出すと並びの幅が伸び、余白ができる)。
                          screen
                            ? "size-5 [&_svg]:size-3.5 after:-right-1 pointer-coarse:after:-right-1"
                            : "size-4 [&_svg]:size-3 after:-right-0.5 pointer-coarse:after:-right-0.5",
                        )}
                      >
                        <XIcon />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {(editing || inPlace) && rest !== "" && (
              <span
                style={{ order: SLOT_ORDER - 1 }}
                className={cn(
                  "shrink-0 whitespace-pre",
                  screen ? "text-base" : "text-sm",
                  !screen &&
                    "hidden group-focus-within/search:inline @3xl/pane:inline",
                )}
              >
                {rest}
              </span>
            )}
            {/* 入力中の条件は、欄 (input) ごとチップに包む。欄は作り直さない (フォーカスを保つ) よう、
              包みは常に置き、入力中でなければ display: contents にする。 */}
            <span
              style={{ order: inPlace ? inPlace.at : SLOT_ORDER }}
              className={
                slot
                  ? cn(
                      chipClass(slot.negated, screen, true),
                      !screen &&
                        "hidden group-focus-within/search:flex @3xl/pane:flex",
                    )
                  : "contents"
              }
            >
              {slot && (
                <ChipHead
                  chipKey={slot.key}
                  label={
                    chipLabel({
                      raw: "",
                      key: slot.key,
                      value: "",
                      negated: slot.negated,
                    }).label
                  }
                  negated={slot.negated}
                />
              )}
              <input
                ref={inputRef}
                id={SEARCH_INPUT_ID}
                type="text"
                role="combobox"
                aria-expanded={showPanel}
                aria-controls={`${id}-listbox`}
                aria-autocomplete="list"
                aria-activedescendant={
                  showPanel && activeIndex >= 0
                    ? `${id}-option-${activeIndex}`
                    : undefined
                }
                enterKeyHint="search"
                autoComplete="off"
                spellCheck={false}
                aria-label="メールを検索"
                style={{ order: SLOT_ORDER }}
                placeholder={
                  slot
                    ? (SEARCH_OPERATORS.find(
                        (operator) =>
                          operator.key ===
                          (slot.key === "cc" ? "to" : slot.key),
                      )?.example ?? "")
                    : chips.length > 0
                      ? undefined
                      : placeholder
                }
                value={text}
                onChange={(event) =>
                  setText(
                    event.target.value,
                    event.target.selectionStart ?? event.target.value.length,
                  )
                }
                onSelect={(event) =>
                  setCaret(event.currentTarget.selectionStart ?? text.length)
                }
                onFocus={() => {
                  if (!open) openPanel();
                }}
                onClick={() => {
                  if (!open) openPanel();
                }}
                onBlur={(event) => {
                  if (inPlace) leaveChip("none");
                  // 候補 (カレンダーなど) へ移ったときは閉じない。
                  if (panelRef.current?.contains(event.relatedTarget as Node))
                    return;
                  setOpen(false);
                }}
                onKeyDown={onKeyDown}
                className={cn(
                  "bg-transparent outline-none placeholder:text-muted-foreground",
                  // 入力中のチップの中ではチップと同じ大きさにする。スマホは iOS が 16px 未満の欄で
                  // 画面を拡大してしまうので、text-base のまま。
                  screen ? "text-base" : slot ? "text-xs" : "text-sm",
                  slot
                    ? // 入力中の条件のチップの中の欄。中身の幅に合わせる (対応していないブラウザーでは広がる)。
                      cn(
                        "field-sizing-content min-w-[2ch] max-w-48 flex-none rounded-sm bg-background/85 font-semibold text-inherit shadow-xs ring-1 ring-current/10 placeholder:font-normal placeholder:text-current/45 dark:bg-background/60",
                        // 値を入れる部分は、チップの中で背景を変えて欄だとわかるようにする。
                        screen ? "h-6 px-1.5" : "h-4.5 px-1",
                      )
                    : cn(
                        "h-full w-full flex-1",
                        screen ? "min-w-24" : "min-w-20",
                      ),
                )}
              />
            </span>
          </div>
          {full && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="入力をクリア"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setFull("");
                openPanel();
              }}
              className={cn(
                "ml-auto shrink-0",
                // 虫めがねだけの狭い表示では、広げている間だけ出す。
                !screen &&
                  "hidden group-focus-within/search:inline-flex @3xl/pane:inline-flex",
              )}
            >
              <XIcon />
            </Button>
          )}
        </div>
      </div>
      {panel}
    </search>
  );
}

/** 末尾の入力欄 (と条件以外の語) の並び順。チップ (0, 1, 2…) より後ろに置く。 */
const SLOT_ORDER = 10000;

/** チップのアイコン (演算子ごと)。 */
const chipIcons: Record<string, ReactNode> = {
  ...operatorIcons,
  cc: operatorIcons.to,
  in: operatorIcons.folder,
  since: operatorIcons.after,
  until: operatorIcons.before,
};

/**
 * 条件のチップの見た目。条件はブランドの藍色、除外 (-from: など) は赤みのある色にし、
 * 入力中のチップは縁を濃くして、いま値を入れている場所だと分かるようにする。
 */
function chipClass(negated: boolean, screen: boolean, editing: boolean) {
  return cn(
    "flex shrink-0 items-center gap-1 rounded-md pl-1.5 ring-1 ring-inset transition-colors",
    screen ? "h-8 pr-1 text-sm" : "h-6 pr-0.5 text-xs",
    editing && (screen ? "pr-1" : "pr-0.5"),
    negated
      ? cn(
          "bg-rose-500/10 text-rose-950 ring-rose-500/20 dark:bg-rose-400/15 dark:text-rose-50 dark:ring-rose-400/25",
          editing && "bg-rose-500/15 ring-rose-500/50 dark:ring-rose-400/60",
        )
      : cn(
          "bg-indigo-500/10 text-indigo-950 ring-indigo-500/20 dark:bg-indigo-400/15 dark:text-indigo-50 dark:ring-indigo-400/25",
          editing &&
            "bg-indigo-500/15 ring-indigo-500/50 dark:ring-indigo-400/60",
        ),
  );
}

/** チップの頭 (アイコンと条件の名前)。値と見分けられるよう、色を薄くして細めの字にする。 */
function ChipHead({
  chipKey,
  label,
  negated,
}: {
  chipKey: string;
  label: string;
  negated: boolean;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
        negated
          ? "text-rose-700 dark:text-rose-300"
          : "text-indigo-700 dark:text-indigo-300",
      )}
    >
      {chipIcons[chipKey]}
      {negated && (
        <span className="rounded-sm bg-rose-500/15 px-1 font-semibold text-[0.625rem] leading-4 dark:bg-rose-400/20">
          除外
        </span>
      )}
      {label}
    </span>
  );
}

function buildSections({
  text,
  token,
  contacts,
  folders,
  history,
  onFindInMessage,
  replace,
  runHistory,
  removeHistory,
  clearHistory,
}: {
  text: string;
  token: InputToken;
  contacts: ContactSuggestion[];
  folders: FolderSuggestion[];
  history: string[];
  onFindInMessage: ((query: string) => void) | undefined;
  replace: (token: InputToken, replacement: string) => void;
  runHistory: (query: string) => void;
  removeHistory: (query: string) => void;
  clearHistory: () => void;
}): Section[] {
  const sections: Section[] = [];
  const query = normalizeQuery(completeQuery(text));
  const sign = token.negated ? "-" : "";

  // 演算子の値を入力している間は、その候補を優先する (メールの中の検索は出さない)。
  // メールの中では、演算子 (from: など) と除外の語 (-語) を除いた語をそのまま探す。
  const findText = query
    .split(" ")
    .filter((word) => !/^-|^[a-z]+[:：]/iu.test(word))
    .join(" ")
    .replace(/["“”]/gu, "");
  if (onFindInMessage && findText !== "" && token.key === "") {
    sections.push({
      title: "開いているメール",
      items: [
        {
          id: "find",
          icon: <FileSearchIcon />,
          label: (
            <>
              このメールの中で「
              <strong className="font-semibold">{findText}</strong>」を探す
            </>
          ),
          apply: () => onFindInMessage(findText),
        },
      ],
    });
  }

  const contactItem = (
    contact: ContactSuggestion,
    key: string,
    prefix: string,
  ): Suggestion => ({
    id: `contact-${key}-${contact.address}`,
    icon: key === "from" ? <UserIcon /> : <AtSignIcon />,
    label: (
      <>
        <span className="text-muted-foreground">{prefix}</span>
        {contact.name ? (
          <>
            {contact.name}{" "}
            <span className="text-muted-foreground">{contact.address}</span>
          </>
        ) : (
          contact.address
        )}
      </>
    ),
    apply: () => replace(token, `${sign}${key}:${contact.address}`),
  });

  if (
    ADDRESS_OPERATORS.includes(token.key as (typeof ADDRESS_OPERATORS)[number])
  ) {
    if (contacts.length > 0) {
      sections.push({
        title: token.key === "from" ? "差出人" : "宛先",
        items: contacts.map((contact) => contactItem(contact, token.key, "")),
      });
    }
    return sections;
  }

  if (
    FOLDER_OPERATORS.includes(token.key as (typeof FOLDER_OPERATORS)[number])
  ) {
    if (folders.length > 0) {
      sections.push({
        title: "フォルダ",
        items: folders.map((folder) => ({
          id: `folder-${folder.label}`,
          icon: <FolderIcon />,
          label: folder.label,
          detail: folder.detail,
          apply: () =>
            replace(token, `${sign}${token.key}:${quoteValue(folder.label)}`),
        })),
      });
    }
    return sections;
  }

  const values = OPERATOR_VALUES[token.key as SearchOperator["key"]];
  if (values) {
    const items = values
      .filter((item) => item.value.startsWith(token.value.toLowerCase()))
      .map((item) => ({
        id: `value-${item.value}`,
        icon: operatorIcons[token.key as SearchOperator["key"]],
        label: (
          <>
            <span className="text-muted-foreground">{token.key}:</span>
            {item.value}
          </>
        ),
        detail: item.label,
        apply: () => replace(token, `${sign}${token.key}:${item.value}`),
      }));
    if (items.length > 0) sections.push({ title: "条件", items });
    return sections;
  }
  if (DATE_OPERATORS.includes(token.key as (typeof DATE_OPERATORS)[number])) {
    return sections;
  }
  if (token.key !== "") return sections;

  // 演算子を入れていない語: 当てはまる演算子と、相手のアドレスを出す。
  const word = token.value.toLowerCase();
  const operators = SEARCH_OPERATORS.filter(
    (operator) => word === "" || operator.key.startsWith(word),
  );
  if (operators.length > 0) {
    sections.push({
      title: "検索オプション",
      items: operators.map((operator) => ({
        id: `operator-${operator.key}`,
        icon: operatorIcons[operator.key],
        label: (
          <>
            <span className="font-medium">{operator.key}:</span>{" "}
            <span className="text-muted-foreground">{operator.label}</span>
          </>
        ),
        detail: operator.example,
        apply: () => replace(token, `${sign}${operator.key}:`),
      })),
    });
  }
  if (word !== "" && contacts.length > 0) {
    sections.push({
      title: "差出人",
      items: contacts.map((contact) => contactItem(contact, "from", "from: ")),
    });
  }
  if (query === "" && history.length > 0) {
    sections.push({
      title: "最近の検索",
      action: (
        <Button
          variant="ghost"
          size="xs"
          onClick={clearHistory}
          className="-my-1 -mr-1.5 h-6 text-muted-foreground text-xs"
        >
          すべて消す
        </Button>
      ),
      items: history.map((item) => ({
        id: `history-${item}`,
        icon: <ClockIcon />,
        label: item,
        apply: () => runHistory(item),
        remove: () => removeHistory(item),
      })),
    });
  }
  return sections;
}

/** 検索結果で、探す範囲 (すべてのフォルダ / 表示中のフォルダ) を切り替える。 */
export function SearchScope({
  value,
  onChange,
  folderLabel,
  className,
}: {
  value: SearchParams;
  onChange: (value: SearchParams) => void;
  folderLabel: string;
  className?: string;
}) {
  return (
    <fieldset className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <legend className="sr-only">検索する範囲</legend>
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
  );
}
