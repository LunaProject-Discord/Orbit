# 送信元の認証表示と差出人のアイコン

## 認証結果 (SPF・DKIM・DMARC)

- つなぎ先のメールサーバー (Gmail なら mx.google.com) がメールに付けた `Authentication-Results` を読むだけで、Orbit 自身は検証しない。
- 同じヘッダーが複数あるときは、いちばん上 (最後に受け取ったサーバーが付けたもの) だけを使う。送り主が偽のヘッダーを書き込めるため。`ARC-Authentication-Results` は使わない。
- Microsoft 365 / Outlook.com は判定したサーバーの名前を省くので、その場合は空として読む。
- 取得経路: IMAP (Gmail を含む) は取り込み時と後からの補完で `HEADER.FIELDS` に含めて取得、Microsoft Graph は `internetMessageHeaders`、POP3 は保存してある原文から読む。
- 読み取りは `packages/core/src/sender-auth.ts` (`parseAuthenticationResults`、`checkSender`)。結果は `messages.auth_results` と `messages.sender_check` に入る。
- 取り込み済みのメールは、`sender_check` が空のものを同期ワーカーが少しずつ読み直す (`headersPending`、索引 `messages_sender_check_pending_idx`)。マイグレーションで全件を書き換えると、検索用の生成列と索引を全件作り直すため大きな DB で終わらなくなるので、しない。

## なりすましの警告

`sender_check.warnings` に次の注意が入り、一覧には印、開いたメールには帯を出す。

- `dmarc_fail`: DMARC に不合格。
- `auth_fail`: DMARC の結果が無く、SPF に不合格で DKIM にも合格していない (Microsoft の `compauth=fail` を含む)。
- `name_mismatch`: 表示名に書かれたアドレスやドメイン、または有名な会社名 (`BRANDS` の一覧) と、実際のアドレスの組織のドメインが違う。

## 差出人のアイコン

- 探す順: (連絡先の写真、連絡先の機能ができたら) → BIMI のロゴ → Gravatar → ドメインのファビコン → 頭文字。
- BIMI は確認済み (DMARC に合格し差出人のドメインと一致) で注意の無いメールだけ。ファビコンは注意の無いメールだけ。なりすましのメールを、それらしく見せないため。個人向けのメールサービス (gmail.com など) のファビコンは使わない。
- BIMI の証明書 (VMC) は検証していない。
- 取得はすべて API サーバー (`apps/api/src/lib/sender-icons.ts`、`GET /v1/sender-icons`) が行い、結果を `sender_icons` に覚える (見つかったもの 7 日、無かったもの 3 日、通信の失敗 6 時間)。端末から差出人側へ通信は出ない。
- SVG は要素の許可リストで無害化し、外部の参照・スクリプト・イベントの属性を取り除いてから保存する。
- 端末ごとの設定 (メールの表示 → 差出人のアイコン): 一覧に表示、詳細に表示、Gravatar を使う (標準はオフ)。
