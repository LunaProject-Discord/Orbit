# アプリの画面の自動更新

(アプリ本体とサーバーの更新、版の固定は [updates.md](updates.md) を見てください。)

デスクトップ版 (Tauri) とスマホアプリ (Android) は、Web 版の画面 (`apps/web` の静的出力) をアプリに同梱しています。この仕組みを使うと、サーバーに新しい画面を配置 (`deploy/deploy.sh`) しただけで、アプリを入れ直さなくても画面が新しくなります。

- アプリは起動するといつもどおり同梱の (または前に取得した) 画面で開き、裏で新しい画面を取得します。
- 取得した画面は **次に起動したときに** 切り替わります。設定の **バージョン情報** から、すぐに切り替えることもできます。
- 画面の URL (`tauri://localhost`、`https://localhost`) は変わらないので、ログインの状態や端末に保存したメールはそのまま使えます。

## しくみ

1. Web のビルド (`apps/web/scripts/build.mjs`) が、画面の版 (ビルドした日時、UTC の `YYYYMMDDHHmmss`) を画面に埋め込み、書き出したすべてのファイルの SHA-256 を並べた一覧を作ります。一覧は Ed25519 の秘密鍵で署名し、`/app-update/manifest.json` として画面と一緒に配信します (`scripts/app-update-manifest.mjs`)。
2. アプリは起動から 20 秒後と、その後 6 時間ごとに、接続先のサーバーの一覧を取得します。署名をアプリに埋め込んだ公開鍵で確かめ、いまの画面より新しければ、ファイルを用意します。中身が同じファイルは同梱の画面などから写し、変わったファイルだけをサーバーから取得します。すべてのファイルは一覧の SHA-256 と照合します。ファイルは `/app-update/files/` から取得します。中身は画面と同じですが、HTML として扱われないよう `application/octet-stream` で配信しています (`deploy/Caddyfile`)。通常の URL の HTML には Cloudflare がスクリプト (ボット対策の JavaScript 検出) を差し込むため、一覧と一致しなくなるからです。
3. 次に起動したとき、取得した画面を配信します。画面が描けたところで「問題なく起動した」とアプリへ伝えます。伝えないまま終わった (画面が壊れていた) ときは、次に起動したときに前の画面へ戻し、その版は二度と使いません。
4. アプリ本体を更新すると、取得した画面は消して、新しいアプリに同梱の画面を使います。

| 場所 | 中身 |
| --- | --- |
| `apps/web/src/lib/app-update/` | 一覧の確認 (署名、版の比較) と、更新の流れ |
| `apps/web/src/components/mail/about-settings.tsx` | 設定の「バージョン情報」 |
| `apps/desktop/src-tauri/src/web_bundle.rs` | デスクトップ版: ファイルの取得と照合、配信する画面の切り替え |
| `apps/mobile/android/.../WebBundles.java`、`AppUpdatePlugin.java` | Android: 同じ処理 (配信は Capacitor の `serverBasePath` を使う) |
| `apps/web/app-update.json` | 画面が必要とするアプリ側の機能の版 (`minNativeApi`) |
| `deploy/app-update-key.sh` | 署名の鍵を作り、公開鍵を表示する |

## 準備

1. サーバーで `bash deploy/app-update-key.sh` を実行し、表示された公開鍵を控えます (`deploy/setup.sh` と `deploy/deploy.sh` も、鍵が無ければ作ります)。秘密鍵は `deploy/secrets/app-update-signing-key` に置かれ、Web のビルドが一覧の署名に使います (イメージには残りません)。
2. GitHub のリポジトリの **Settings → Secrets and variables → Actions → Variables** に、`APP_UPDATE_PUBLIC_KEY` という名前で公開鍵を登録します。
3. アプリをビルドし直して入れます (Actions の **Desktop** と **Android** の Run workflow)。公開鍵を埋め込んだアプリから、画面の自動更新が有効になります。
4. 以後は `deploy/deploy.sh` (または Actions の Deploy) でサーバーを更新するたびに、アプリの画面も更新されます。

公開鍵を登録していないアプリでは画面は更新されず、バージョン情報に「このビルドでは、画面の自動更新は無効です。」と出ます。

## アプリ本体の更新が要るとき

Rust (`apps/desktop/src-tauri`) や Java (`apps/mobile/android`) の処理を足し、画面からそれを使うときは、次の 3 か所の数字を一緒に 1 増やします。

- `apps/web/app-update.json` の `minNativeApi`
- `apps/desktop/src-tauri/src/web_bundle.rs` の `NATIVE_API`
- `apps/mobile/android/.../WebBundles.java` の `NATIVE_API`

(2026-11-25 に、ファイルの取得元を `/app-update/files/` に変えたため 2 にしました。1 のアプリは画面を更新できないので、入れ直してください。)

古いアプリは、自分より新しい機能を求める画面を取得しません (バージョン情報に「アプリ本体の更新が必要です」と出ます)。アプリ本体はこれまでどおり配り直してください。サーバーの API は、古い画面からも使えるよう後方互換を保ちます (Web 版のオフライン用の保存と同じ考え方です)。

## 注意

- 画面だけを差し替える仕組みです。アプリ本体のコード (Rust、Java) は更新しません。Google Play の規約は、WebView で動く JavaScript などの更新を、アプリの目的を変えない範囲で認めています。iOS 版を作るときは、App Store の規約を確かめ直してください。
- 鍵を作り直すと (`--renew`)、新しい公開鍵でアプリをビルドし直すまで、画面は更新されません。
- 署名の秘密鍵はサーバーにあるので、サーバーを乗っ取られた場合は署名も作れてしまいます。一覧の署名は、通信の途中での書き換えや、配信元を偽られることへの備えです。
