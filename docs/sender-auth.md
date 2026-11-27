# 送信元の認証表示と差出人のアイコン

## 認証結果 (SPF・DKIM・DMARC)

- つなぎ先のメールサーバー (Gmail なら mx.google.com) がメールに付けた `Authentication-Results` を読むだけで、Orbit 自身は検証しない。
- `Authentication-Results` は差出人も書ける。受信サーバーが自分のヘッダーを付けないと、差出人が書いた偽のヘッダーがいちばん上に残る (検査のミルターの無い Postfix + Dovecot、POP3 の取り込み、組織内のメールなど)。そこで、アカウントごとに「信頼する判定サーバーの名前 (authserv-id)」を決め、その名前のヘッダーだけを使う (`selectAuthResults`、`isTrustedAuthservId`)。照合できないヘッダーは無いものとして扱う (確認済みにも、失敗の警告にもしない = unknown)。
- 信頼する名前 (アカウントの `provider` と受信ホスト `imap_host` から決める):

  | アカウント | 信頼する authserv-id | 根拠 |
  |---|---|---|
  | Gmail | `mx.google.com` だけ | Gmail が受け取ったメールに付ける名前 |
  | Microsoft (Graph、Outlook.com / Exchange Online の IMAP・POP3) | 名前を省いた形 (空) と、`.outlook.com` で終わる名前 | Exchange Online は名前を省いて付ける (公開されているヘッダーの例)。`.outlook.com` は推測 (保護のサーバーが付けることがある) |
  | iCloud | `.icloud.com` で終わる名前 | iCloud は `bimi.icloud.com` / `dmarc.icloud.com` / `dkim-verifier.icloud.com` / `spf.icloud.com` のように方式ごとに分けて付ける (レビューの記憶と公開されている例による。実際のヘッダーでは未確認) |
  | 一般の IMAP / POP3 | 受信ホストと組織のドメイン (登録ドメイン) が同じ名前だけ。例: `imap.example.net` なら `mx.example.net` | 受信ホストが IP アドレスや公開サフィックスの下に無い名前なら何も信頼しない。受信ホストが gmail.com / outlook.com / office365.com / icloud.com / me.com などなら、そのサービスとして扱う |

- 使うのは、いちばん上から続く信頼する名前のヘッダーだけ。信頼しない名前・読めないヘッダー・同じ名前の 2 本目に当たったらそこでやめる (それより下は差出人が書いた可能性がある)。iCloud のように方式ごとに分かれていれば、まとめて方式ごとに上のものを使う。
- 残る穴: 一般のサーバーで受信サーバーが自分のヘッダーを付けない場合、差出人が受信ホストと同じ組織の名前 (`mx.example.net` など) を騙ると、まだ確認済みに見せられる。Microsoft の名前を省いた形も、組織内のメールでは本物と見分けられない。RFC 8601 の「自分の名前を騙るヘッダーを消す」を Gmail などが守っているか (POP 取り込みの経路) も未確認。このため、確認済みは利用者の目を通らない書き換え (メールの招待の REPLY の自動反映) の根拠にしない。
- DMARC の合格は、`header.from` が書かれていて差出人のドメインと一致するときだけ確認済みにする (`header.from` の無い `dmarc=pass` は確認済みにしない)。
- `ARC-Authentication-Results` は使わない。
- 取得経路: IMAP (Gmail を含む) は取り込み時と後からの補完で `HEADER.FIELDS` に含めて取得、Microsoft Graph は `internetMessageHeaders`、POP3 は保存してある原文から読む。どれも同じ名前のヘッダーをすべて (上から順に) 渡す。
- 読み取りは `packages/core/src/sender-auth.ts` (`parseAuthenticationResults`、`selectAuthResults`、`checkSender`)、アカウントからの決め方は `apps/worker/src/message-headers.ts` (`authTrustOf`)。結果は `messages.auth_results` (信頼したヘッダーをまとめたもの。無ければ null) と `messages.sender_check` に入る。
- `sender_check.version` は決まりの版 (`SENDER_CHECK_VERSION`、いまは 2)。
- 取り込み済みで `sender_check` が空のメール (この項目を足す前に取り込んだもの)、または版の無い (信頼する名前との照合を入れる前に作った) メールは、裏では補わない。API は版が古い結果を返さず (`sender_check` と `auth_results` を null にする。`apps/api/src/lib/sender-check.ts`)、画面は「確認中」として扱う (確認済みの印・BIMI のロゴ・メールの招待の反映は出さない)。利用者が開いたとき、カーソルを載せたとき、一覧に見えたときに、本文の先読みと同じ仕組み (`POST /v1/messages/prefetch`・詳細の取得 → `CHANNEL_BODY_FETCH` → ワーカーの `BodyRequests`) で認証結果のヘッダーだけを取得し直す (POP3 は保存してある原文から)。保存してある `auth_results` は「いちばん上の 1 本」だけなので、そこから正しく作り直すことはできない (iCloud の分かれたヘッダーや、下にあった本物のヘッダーが残っていない) ため、取り直す。サーバーから消えていて取り直せないメールは、確認中のまま (確認済みには戻らない)。全件を書き換えると、検索用の生成列と trigram 索引をそのたびに作り直すため DB が重くなり (マイグレーションなら大きな DB で終わらない)、一覧の読み込みも遅くなるので、しない。

## なりすましの警告

`sender_check.warnings` に次の注意が入り、一覧には印、開いたメールには帯を出す。

- `dmarc_fail`: DMARC に不合格。
- `auth_fail`: DMARC の結果が無く、SPF に不合格で DKIM にも合格していない (Microsoft の `compauth=fail` を含む)。
- `name_mismatch`: 表示名に書かれたアドレスやドメイン、または有名な会社名 (`BRANDS` の一覧) と、実際のアドレスの組織のドメインが違う。

## 差出人のアイコン

- 探す順: (連絡先の写真、連絡先の機能ができたら) → BIMI のロゴ → Gravatar → ドメインのファビコン → 頭文字。
- BIMI は確認済み (信頼する判定サーバーの DMARC に合格し差出人のドメインと一致、版 2 の結果) で注意の無いメールだけ。ファビコンは注意の無いメールだけ。なりすましのメールを、それらしく見せないため。個人向けのメールサービス (gmail.com など) のファビコンは使わない。
- BIMI は証明書 (VMC・CMC、レコードの a=) を確かめられたときだけ使い、ロゴは証明書の logotype 拡張に入っているもの (gzip の SVG) を使う (l= のロゴは取りに行かない)。確かめる内容: 用途 (拡張鍵用途 1.3.6.1.5.5.7.3.31)、期限、subjectAltName に BIMI のレコードを置いたドメインがあること、信頼する発行元までの署名の連なり (apps/api/src/lib/mark-certificate.ts)。信頼する発行元は [markcerts/mvarcs](https://github.com/markcerts/mvarcs) の cacert.pem を写した apps/api/src/lib/mark-roots.ts (発行元が増えたら更新する)。Entrust のルートからは 2024-11-15 より後に発行された証明書を信頼しない。失効は、証明書に書かれた失効リスト (CRL、http でも取得する。署名で中身を確かめる) で、本人と途中の証明書について確かめる (apps/api/src/lib/mark-crl.ts)。本人の証明書に失効リストの場所が無ければ使わない。失効していればロゴを出さず、失効リストを取得できない・署名が合わない・次の更新日を過ぎているときは 6 時間後に確かめ直し、その間もロゴを出さない。OCSP は使わない。確かめたロゴは 1 日だけ覚える (失効の反映は最長 1 日遅れる)。キャッシュの鍵は `bimi-mark:` (確かめる前の `bimi:` は使わない)。
- 取得はすべて API サーバー (`apps/api/src/lib/sender-icons.ts`、`GET /v1/sender-icons`) が行い、結果を `sender_icons` に覚える (見つかったもの 7 日、無かったもの 3 日、通信の失敗 6 時間)。端末から差出人側へ通信は出ない。
- SVG は要素の許可リストで無害化し、外部の参照・スクリプト・イベントの属性を取り除いてから保存する。
- 端末ごとの設定 (メールの表示 → 差出人のアイコン): 一覧に表示、詳細に表示、プロフィールカードと宛先の候補に表示 (いずれも標準はオン)。
- すべての端末で共通の設定: Gravatar を使う (標準はオフ)。取得はサーバーが代わりに行うので、利用者ごとに `user_settings.sender_icon_gravatar` に保存し (`PUT /v1/settings/sender-icons`)、`GET /v1/sender-icons` は設定がオフなら端末が頼んでも Gravatar を使わない。
- プロフィールカードは、差出人なら確認結果を使って探す。宛先や宛先の候補の相手は確認結果が無いので、証明書で確かめた BIMI のロゴと Gravatar だけを使う (ファビコンは使わない)。カードは開いたときだけ探す。
