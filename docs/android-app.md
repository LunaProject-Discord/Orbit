# Android アプリ

Orbit Mail の Android アプリ (`apps/mobile`) のビルド、プッシュ通知、配布の手順です。

## しくみ

- [Capacitor](https://capacitorjs.com/) で、Web 版の画面 (`apps/web` の静的出力) をそのままアプリに入れています。画面のコードは Web 版と共通です。
- アプリの中にあるのは画面だけで、メールは自分のサーバー (API) から取得します。最初に接続するサーバーはビルド時に決め (既定は `https://orbit.lunaproject.jp`)、アプリのログイン画面の「接続先 … 変更」から後で変えられます。
- 新着メールの通知は Firebase Cloud Messaging (FCM) で届きます。サーバーの同期ワーカーが FCM へ送り、Android がアプリを閉じていても通知を出します。
- アプリの ID (パッケージ名) は `jp.lunaproject.orbit.mail` です。

| 場所 | 中身 |
| --- | --- |
| `apps/mobile/capacitor.config.ts` | アプリの ID、名前、プラグインの設定 |
| `apps/mobile/android/` | Android Studio で開くプロジェクト (コミットしてある) |
| `apps/mobile/scripts/generate-icons.mjs` | `assets/brand/` からアイコンと起動画面の画像を作る |
| `apps/web/src/lib/native/` | アプリの中でだけ動く処理 (起動画面、戻るボタン、テーマ、通知) |
| `.github/workflows/android.yml` | GitHub Actions でのビルド |

## 1. GitHub Actions でビルドする (いちばん手軽)

手元に Android の開発環境が無くても、GitHub 上でアプリを作れます。

1. GitHub のリポジトリで **Actions → Android → Run workflow** を押す (ブランチは `main`)。
2. 終わったら、その実行のページの下にある **Artifacts** から `orbit-mail-android-debug` をダウンロードする。
3. 中の `app-debug.apk` を Android 端末へ送り、開いてインストールする (「提供元不明のアプリ」の許可を求められます)。

`apps/mobile` を変えたプルリクエストと `main` への push でも自動でビルドされます。Web の画面だけを変えたときは自動では作り直さないので、最新の画面を入れたいときは Run workflow を使ってください。

確認用のアプリ (debug) の注意:

- 署名が実行のたびに変わるため、**前に入れた debug 版の上から更新できません** (一度アンインストールが必要)。続けて使うなら、下の「3. 署名鍵」を済ませて配布用 (release) を使ってください。
- 下の「2. プッシュ通知」を済ませるまで、通知は届きません (設定画面の通知の欄に「設定されていません」と出ます)。

接続先を変えたいときは、リポジトリの **Settings → Secrets and variables → Actions → Variables** に `MOBILE_SERVER_URL` (例: `https://orbit.lunaproject.jp`) を登録します。

## 2. プッシュ通知 (Firebase) の準備

Firebase のプロジェクトは無料で作れます。作業は Google アカウントでログインして行います。

### 2-1. Firebase にアプリを登録する

1. [Firebase コンソール](https://console.firebase.google.com/) で **プロジェクトを作成** する (名前は自由。Google アナリティクスは不要)。
2. プロジェクトの概要で **Android アプリを追加** する。
   - Android パッケージ名: `jp.lunaproject.orbit.mail`
   - ほかは空でかまいません。
3. **`google-services.json` をダウンロード** する。以降の「SDK の追加」の案内は、すでに組み込んであるので飛ばします。

### 2-2. アプリのビルドに渡す

- **GitHub Actions**: リポジトリの **Settings → Secrets and variables → Actions → Secrets** に、名前 `ANDROID_GOOGLE_SERVICES_JSON` で `google-services.json` の中身をそのまま貼り付ける。
- **手元でビルドする場合**: `apps/mobile/android/app/google-services.json` に置く (Git には入りません)。

### 2-3. サーバーから送れるようにする

1. Firebase コンソールの **プロジェクトの設定 (歯車) → サービス アカウント → 新しい秘密鍵を生成** で JSON をダウンロードする。この鍵は、このプロジェクトのアプリへ通知を送れる秘密の値です。他人に渡さないでください。
2. JSON を base64 で 1 行にする。

   ```powershell
   # Windows (PowerShell)
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\service-account.json"))
   ```

   ```sh
   # Linux / macOS
   base64 -w0 service-account.json   # macOS は base64 -i service-account.json
   ```

3. サーバーの `deploy/.env` の `FCM_SERVICE_ACCOUNT=` に貼り付け、サーバーを更新する。

   ```sh
   bash /opt/mail/deploy/deploy.sh
   ```

   同期ワーカーのログに「FCM_SERVICE_ACCOUNT が未設定のため…」が出なくなれば読み込めています。

開発用 (手元の `.env`) も同じ名前の `FCM_SERVICE_ACCOUNT` です。

### 2-4. アプリで通知を有効にする

Firebase の設定を入れてビルドし直したアプリを入れ、**設定 → 通知** をオンにします。Android が通知の許可を尋ねるので許可してください。

うまくいかないとき:

| 設定画面の表示 | 原因 |
| --- | --- |
| 「このサーバー、またはこのアプリでは…設定されていません」 | アプリに `google-services.json` が入っていない (2-2)、またはサーバーに `FCM_SERVICE_ACCOUNT` が無い (2-3) |
| 「端末の設定で…許可されていません」 | Android の設定 → アプリ → Orbit Mail → 通知 を許可する |
| オンにできるが届かない | 同期ワーカーのログに「新着メールの通知をスマホアプリへ送れませんでした」が無いか確かめる。Firebase のプロジェクトが、アプリとサーバーで同じかも確かめる |

## 3. 署名鍵 (配布用のアプリ)

端末に入れたアプリを更新するには、毎回同じ鍵で署名する必要があります。

1. 鍵を作る (JDK に入っている `keytool` を使います。Android Studio を入れてあれば、その中の JDK で動きます)。

   ```sh
   keytool -genkeypair -v -keystore orbit-mail-release.jks -alias orbit-mail -keyalg RSA -keysize 2048 -validity 10000
   ```

   尋ねられるパスワードと、`-alias` に付けた名前を控えておきます。

2. **鍵のファイルとパスワードを、安全な場所に保管する**。失うと、同じアプリとして更新できなくなります (Google Play の「Play アプリ署名」を使っている場合は、アップロード用の鍵を再登録できます)。リポジトリには入れないでください。

3. GitHub のシークレットに登録する。

   | 名前 | 値 |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | 鍵のファイルを base64 にしたもの (2-3 と同じコマンドで作れます) |
   | `ANDROID_KEYSTORE_PASSWORD` | キーストアのパスワード |
   | `ANDROID_KEY_ALIAS` | `orbit-mail` (`-alias` に付けた名前) |
   | `ANDROID_KEY_PASSWORD` | 鍵のパスワード (キーストアと同じなら省略可) |

登録後は、ビルドのたびに `orbit-mail-android-release` もできます。中の `app-release.apk` は端末へ直接入れる用、`app-release.aab` は Google Play へ出す用です。

版の番号は、`android-v0.1.0` のようなタグを push すると `0.1.0` になります (それ以外は `0.1.0-<コミット>`)。Google Play が求める通し番号 (versionCode) には、GitHub Actions の実行番号を使っています。

## 4. Google Play で配布する (任意)

自分の端末で使うだけなら、3 の `app-release.apk` を直接入れれば足ります。Google Play を使うと、更新が自動になります。

1. [Google Play Console](https://play.google.com/console/) で開発者アカウントを作る (登録料がかかります。金額と本人確認の内容は、登録時の案内を確認してください)。
2. **アプリを作成** し、アプリ名 (Orbit Mail) などを入力する。
3. **テスト → 内部テスト** でリリースを作り、`app-release.aab` をアップロードする。テスターに自分の Google アカウントを追加すると、Play ストアから入れられます。
4. ストアの掲載情報に使うアイコン (512px) は `apps/mobile/store/play-icon-512.png` です。

内部テストより広く公開する (製品版など) には、ストアの掲載情報、プライバシーポリシー、データの取り扱いの申告などが必要です。個人の開発者アカウントでは、製品版の前に一定の人数と期間のクローズドテストが求められることがあります。条件は変わることがあるので、Play Console の案内を確認してください。

## 5. 手元でビルドする (開発用)

必要なもの: Node.js と pnpm (リポジトリ共通)、[Android Studio](https://developer.android.com/studio) (Android SDK と JDK が一緒に入ります)。

```powershell
pnpm install
# 接続先のサーバーを決めて、画面をビルドし、Android プロジェクトへ入れる
$env:NEXT_PUBLIC_API_URL = "https://orbit.lunaproject.jp"
pnpm --filter @mail/mobile android:prepare
# Android Studio で開く (実機かエミュレーターを選んで ▶ を押す)
pnpm --filter @mail/mobile android:open
```

- `NEXT_PUBLIC_API_URL` を空にしてビルドすると、最初の起動時に接続先サーバーの入力画面が出ます。
- 画面 (`apps/web`) を変えたら、`android:prepare` をやり直します。
- 手元の開発用サーバー (`http://192.168.x.x:8787` など) へは、そのままでは繋がりません。アプリは平文の http 通信を許可していないためです。公開しているサーバー (https) に繋いで確認してください。
- WebView の中は、PC の Chrome で `chrome://inspect` を開くと開発者ツールで調べられます (debug 版のみ)。

## アイコンを作り直す

アイコンと起動画面の画像は `assets/brand/svg/` から作ってコミットしてあります。ロゴを変えたときは作り直します (Playwright の Chromium が必要)。

```sh
pnpm --filter @mail/mobile icons
```

## いまの制限

- **Gmail / Microsoft アカウントの追加 (Google / Microsoft でログイン) は、アプリからはまだできません。** ログイン後の戻り先が Web 版の URL になっているためです。Web 版 (またはブラウザー) で追加すれば、アプリにも表示されます。パスワードで追加するアカウント (iCloud、一般的なメールサーバー) はアプリからも追加できます。
- 画面はステータスバーとナビゲーションバーの内側に表示します (バーの下まで画面を広げてはいません)。
- アプリを開いている間に届いたメールは、通知を出さず一覧に反映します。
- iOS 版はまだありません。同じ `apps/mobile` に `ios/` を足す形で追加できます (プッシュ通知は APNs の対応が別途必要)。
