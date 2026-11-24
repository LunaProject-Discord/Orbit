"use client";

import { REGEXP_ONLY_DIGITS, REGEXP_ONLY_DIGITS_AND_CHARS } from "input-otp";
import { Fragment } from "react";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";

/** 認証アプリ (TOTP) のコードの桁数。 */
export const TOTP_LENGTH = 6;
/** バックアップコードの文字数 (区切りのハイフンを除く)。Better Auth の既定と同じ。 */
export const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_GROUP = 5;

type CommonProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** すべての桁が埋まったとき。 */
  onComplete?: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  "aria-describedby"?: string;
};

/** 貼り付けた文字から空白などの区切りを除く。 */
export function stripCodeSeparators(text: string): string {
  return text.replace(/[^0-9A-Za-z]/g, "");
}

/**
 * バックアップコードを、サーバーに保存されている形 (`xxxxx-xxxxx`) に戻す。
 * 大文字と小文字は区別されるので変えない。
 */
export function formatBackupCode(value: string): string {
  const code = stripCodeSeparators(value);
  if (code.length <= BACKUP_CODE_GROUP) return code;
  return `${code.slice(0, BACKUP_CODE_GROUP)}-${code.slice(BACKUP_CODE_GROUP)}`;
}

/** 認証アプリに表示される 6 桁のコードの入力欄。 */
export function TotpInput(props: CommonProps) {
  return (
    <InputOTP
      id={props.id}
      maxLength={TOTP_LENGTH}
      pattern={REGEXP_ONLY_DIGITS}
      pasteTransformer={stripCodeSeparators}
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={props.autoFocus}
      required
      disabled={props.disabled}
      value={props.value}
      onChange={props.onChange}
      onComplete={props.onComplete}
      aria-invalid={props.invalid || undefined}
      aria-describedby={props["aria-describedby"]}
    >
      <InputOTPGroup>
        {Array.from({ length: TOTP_LENGTH }, (_, index) => (
          <InputOTPSlot
            // biome-ignore lint/suspicious/noArrayIndexKey: 桁の位置そのものがキー。
            key={index}
            index={index}
            aria-invalid={props.invalid || undefined}
            className="size-11 font-mono text-lg"
          />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

/** バックアップコード (`xxxxx-xxxxx`、英数字 10 文字) の入力欄。 */
export function BackupCodeInput(props: CommonProps) {
  const groups = BACKUP_CODE_LENGTH / BACKUP_CODE_GROUP;
  return (
    <InputOTP
      id={props.id}
      maxLength={BACKUP_CODE_LENGTH}
      pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
      pasteTransformer={stripCodeSeparators}
      inputMode="text"
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      autoFocus={props.autoFocus}
      required
      disabled={props.disabled}
      value={props.value}
      onChange={(value) => props.onChange(stripCodeSeparators(value))}
      onComplete={props.onComplete}
      aria-invalid={props.invalid || undefined}
      aria-describedby={props["aria-describedby"]}
      containerClassName="w-full gap-1.5 sm:gap-2"
    >
      {Array.from({ length: groups }, (_, group) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 区切りの位置そのものがキー。
        <Fragment key={group}>
          {group > 0 && <InputOTPSeparator />}
          <InputOTPGroup className="min-w-0 flex-1">
            {Array.from({ length: BACKUP_CODE_GROUP }, (_, offset) => {
              const index = group * BACKUP_CODE_GROUP + offset;
              return (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={props.invalid || undefined}
                  className="h-11 min-w-0 flex-1 font-mono text-base"
                />
              );
            })}
          </InputOTPGroup>
        </Fragment>
      ))}
    </InputOTP>
  );
}
