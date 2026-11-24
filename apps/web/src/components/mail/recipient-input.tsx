"use client";

import { XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  useState,
} from "react";
import { Hint } from "@/components/hint";
import {
  ContactSuggestionList,
  useContactCombobox,
} from "@/components/mail/contact-suggestions";
import type { Address } from "@/lib/api";
import {
  mergeAddresses,
  parseAddressList,
  type RecipientField,
} from "@/lib/compose";
import { addressFull } from "@/lib/format";

type Props = {
  id: string;
  value: RecipientField;
  onChange: (value: RecipientField) => void;
  disabled?: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  /**
   * 候補から除くアドレス (ほかの欄で選び済みの宛先など)。この欄で選び済みの宛先は、
   * 渡さなくても除く。
   */
  exclude?: readonly string[];
};

/**
 * 宛先の入力欄。確定した宛先は 1 件ずつの札 (チップ) にして並べる。
 * Enter、カンマ、セミコロン、欄から離れたときに、入力中の文字列を宛先として確定する。
 */
export function RecipientInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  inputRef,
  exclude,
}: Props) {
  const [focused, setFocused] = useState(false);
  const combobox = useContactCombobox({
    query: value.text,
    exclude: [...value.list.map((entry) => entry.address), ...(exclude ?? [])],
    // 候補を選んだら、入力中の文字列の代わりにその宛先を加える。
    onPick: (contact) =>
      onChange({
        list: mergeAddresses(value.list, [
          {
            ...(contact.name ? { name: contact.name } : {}),
            address: contact.address,
          },
        ]),
        text: "",
      }),
  });

  /** 入力中の文字列を宛先にする。読み取れなかった分は入力欄に残す。 */
  function commit(text: string) {
    const parsed = parseAddressList(text);
    onChange({
      list: mergeAddresses(value.list, parsed.addresses),
      text: parsed.invalid.join(", "),
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (combobox.handleKeyDown(event)) return;
    if (event.nativeEvent.isComposing) return;
    if (
      (event.key === "Enter" && !event.ctrlKey && !event.metaKey) ||
      event.key === "," ||
      event.key === ";"
    ) {
      // 名前を引用符で囲んでいる途中のカンマは、区切りとして扱わない。
      const quoted = (value.text.match(/"/g)?.length ?? 0) % 2 === 1;
      if (event.key !== "Enter" && quoted) return;
      event.preventDefault();
      if (value.text.trim()) commit(value.text);
      return;
    }
    if (event.key === "Backspace" && value.text === "") {
      const last = value.list.at(-1);
      if (!last) return;
      event.preventDefault();
      // 最後の宛先を入力欄に戻して、直せるようにする。
      onChange({ list: value.list.slice(0, -1), text: addressFull(last) });
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text/plain");
    // 宛先をまとめて貼り付けたときは、その場で 1 件ずつに分ける。
    if (!/[,;\n]/.test(pasted)) return;
    event.preventDefault();
    commit(`${value.text} ${pasted}`);
  }

  const remove = (target: Address) =>
    onChange({
      ...value,
      list: value.list.filter((entry) => entry !== target),
    });
  // 欄から離れても読み取れずに残った文字列は、誤りとして色を変える。
  const invalid =
    !focused &&
    value.text.trim() !== "" &&
    parseAddressList(value.text).invalid.length > 0;

  return (
    <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {value.list.map((entry) => (
        <Hint key={entry.address} label={addressFull(entry)}>
          <span className="inline-flex h-7 max-w-full pointer-coarse:h-9 items-center gap-1 rounded-full border bg-muted/60 pr-1 pl-2.5 text-sm">
            <span className="truncate">
              {entry.name?.trim() || entry.address}
            </span>
            <button
              type="button"
              aria-label={`${entry.name?.trim() || entry.address} を宛先から外す`}
              disabled={disabled}
              onClick={() => remove(entry)}
              className="relative flex size-5 shrink-0 items-center justify-center rounded-full pointer-coarse:size-7 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <XIcon className="size-3.5" />
            </button>
          </span>
        </Hint>
      ))}
      <input
        id={id}
        ref={inputRef}
        type="text"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        {...combobox.inputProps}
        aria-invalid={invalid || undefined}
        placeholder={value.list.length === 0 ? placeholder : undefined}
        value={value.text}
        disabled={disabled}
        onChange={(event) => onChange({ ...value, text: event.target.value })}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => {
          setFocused(true);
          combobox.inputProps.onFocus();
        }}
        onBlur={() => {
          setFocused(false);
          combobox.inputProps.onBlur();
          if (value.text.trim()) commit(value.text);
        }}
        className="h-7 min-w-24 flex-1 pointer-coarse:h-10 bg-transparent text-base outline-none placeholder:text-muted-foreground aria-invalid:text-destructive md:text-sm"
      />
      <ContactSuggestionList {...combobox.list} />
    </div>
  );
}
