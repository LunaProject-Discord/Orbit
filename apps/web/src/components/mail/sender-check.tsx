"use client";

import { cn } from "cn";
import {
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Hint } from "@/components/hint";
import type {
  Address,
  AuthMethodResult,
  AuthResults,
  SenderCheck,
  SenderWarning,
} from "@/lib/api";

/** 注意の見出し。 */
const WARNING_TITLES: Record<SenderWarning, string> = {
  dmarc_fail: "なりすましの可能性があります",
  auth_fail: "送信元を確認できませんでした",
  name_mismatch: "差出人の名前とアドレスが一致しません",
};

/** 一覧などで、注意の印に添える説明 (いちばん重いもの)。 */
export function senderWarningLabel(
  check: SenderCheck | null | undefined,
): string | null {
  const first = (["dmarc_fail", "name_mismatch", "auth_fail"] as const).find(
    (warning) => check?.warnings.includes(warning),
  );
  return first ? WARNING_TITLES[first] : null;
}

function domainOf(address: Address | undefined): string {
  const value = address?.address ?? "";
  return value.slice(value.lastIndexOf("@") + 1).toLowerCase();
}

function warningText(
  warning: SenderWarning,
  check: SenderCheck,
  from: Address | undefined,
): string {
  const domain = domainOf(from);
  switch (warning) {
    case "dmarc_fail":
      return `差出人のドメイン (${domain}) が認めていない送り方で届いています (DMARC に不合格)。リンクや添付ファイルを開く前に、送り主を確かめてください。`;
    case "auth_fail":
      return `差出人のドメイン (${domain}) からの送信であることを確かめられませんでした (SPF に不合格で、DKIM の署名もありません)。`;
    case "name_mismatch":
      return `名前は「${check.claimed ?? ""}」ですが、実際のアドレスは別のドメイン (${domain}) です。本物の連絡かどうか注意してください。`;
  }
}

/** メール一覧の差出人の横に出す、注意の印。注意が無ければ何も出さない。 */
export function SenderWarningMark({
  check,
  className,
}: {
  check: SenderCheck | null | undefined;
  className?: string;
}) {
  const label = senderWarningLabel(check);
  if (!label) return null;
  return (
    <Hint label={label}>
      <span role="img" aria-label={label} className="flex shrink-0">
        <TriangleAlertIcon
          className={cn("size-3.5 text-destructive", className)}
          aria-hidden="true"
        />
      </span>
    </Hint>
  );
}

/** 開いたメールの本文の上に出す、なりすましなどの注意の帯。 */
export function SenderWarningBanner({
  check,
  from,
}: {
  check: SenderCheck | null | undefined;
  from: Address | undefined;
}) {
  if (!check || check.warnings.length === 0) return null;
  const severe =
    check.warnings.includes("dmarc_fail") ||
    check.warnings.includes("name_mismatch");
  return (
    <div
      role="alert"
      data-slot="sender-warning"
      className={cn(
        "flex shrink-0 gap-3 border-b px-4 py-2.5 sm:px-6",
        severe ? "bg-destructive/10" : "bg-amber-500/10",
      )}
    >
      <ShieldAlertIcon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          severe ? "text-destructive" : "text-amber-600 dark:text-amber-400",
        )}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        {check.warnings.map((warning) => (
          <p key={warning} className="min-w-0 break-words">
            <span className="font-medium">{WARNING_TITLES[warning]}</span>
            <span className="text-muted-foreground">
              {" "}
              {warningText(warning, check, from)}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

const RESULT_LABELS: Record<string, string> = {
  pass: "合格",
  fail: "不合格",
  softfail: "不合格 (弱)",
  hardfail: "不合格",
  neutral: "判定なし",
  none: "なし",
  temperror: "一時的なエラー",
  permerror: "設定の誤り",
  policy: "ポリシーにより保留",
  bestguesspass: "推定で合格",
};

function resultLabel(result: AuthMethodResult): string {
  const label = RESULT_LABELS[result.result] ?? result.result;
  return result.domain ? `${label} (${result.domain})` : label;
}

function resultTone(result: string): string {
  if (result === "pass") return "text-emerald-600 dark:text-emerald-400";
  if (result === "fail" || result === "softfail" || result === "hardfail")
    return "text-destructive";
  return "text-muted-foreground";
}

/** 差出人の名前の横に出す、送信元を確認できた印。 */
export function VerifiedSenderMark({
  check,
}: {
  check: SenderCheck | null | undefined;
}) {
  if (!check?.verified || check.warnings.length > 0) return null;
  const label = "送信元を確認済み (差出人のドメインの DMARC に合格)";
  return (
    <Hint label={label}>
      <span role="img" aria-label={label} className="flex shrink-0">
        <ShieldCheckIcon
          className="size-4 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      </span>
    </Hint>
  );
}

/**
 * メールの詳細の表に出す「送信元の確認」の行。
 * つなぎ先のサーバーが付けた結果 (SPF・DKIM・DMARC) を並べる。結果が無ければ出さない。
 */
export function AuthResultsRows({
  auth,
  check,
}: {
  auth: AuthResults | null | undefined;
  check: SenderCheck | null | undefined;
}) {
  if (!auth) return null;
  const items: { name: string; result: AuthMethodResult }[] = [];
  if (auth.dmarc) items.push({ name: "DMARC", result: auth.dmarc });
  if (auth.spf) items.push({ name: "SPF", result: auth.spf });
  for (const dkim of auth.dkim) items.push({ name: "DKIM", result: dkim });
  const verified = check?.verified === true && check.warnings.length === 0;
  const failed = (check?.warnings ?? []).some(
    (warning) => warning === "dmarc_fail" || warning === "auth_fail",
  );
  const Icon = verified
    ? ShieldCheckIcon
    : failed
      ? ShieldAlertIcon
      : ShieldIcon;
  return (
    <>
      <dt className="text-muted-foreground">送信元の確認</dt>
      <dd className="flex min-w-0 flex-col gap-0.5" data-slot="auth-results">
        <span className="flex items-center gap-1.5">
          <Icon
            className={cn(
              "size-4 shrink-0",
              verified
                ? "text-emerald-600 dark:text-emerald-400"
                : failed
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
          {verified
            ? "確認済み"
            : failed
              ? "確認できませんでした"
              : "確認の結果が足りません"}
        </span>
        {items.length > 0 && (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {items.map((item, index) => (
              <span
                // 同じ方式 (DKIM) が複数並ぶことがあるので、位置も使う。
                key={`${item.name}-${index}`}
                className="min-w-0 break-words"
              >
                <span className="text-muted-foreground">{item.name}: </span>
                <span className={resultTone(item.result.result)}>
                  {resultLabel(item.result)}
                </span>
              </span>
            ))}
          </span>
        )}
        {auth.authservId && (
          <span className="text-muted-foreground text-xs">
            判定したサーバー: {auth.authservId}
          </span>
        )}
      </dd>
    </>
  );
}
