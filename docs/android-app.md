# Android アプリ

Orbit Mail の Android アプリ (`apps/mobile`) のビルド、プッシュ通知、配布の手順です。

## しくみ

- [Capacitor](https://capacitorjs.com/) で、Web 版の画面 (`apps/web` の静的出力) をそのままアプリに入れています。画面のコードは Web 版と共通です。
- アプリの中にあるのは画面だけで、メールは自分のサーバー (API) から取得します。最初に接続するサーバーはビルド時に決め (既定は `https://orbit.lunaproject.jp`)、アプリのログイン画面の「接続先 … 変更」から後で変えられます。
- 新着メールの通知は Firebase Cloud Messaging (FCM) で届きます。サーバーの同期ワーカーが FCM へ送り、アプリを閉じていても通知を出します。
- 通知には差出人、件名、本文の冒頭が出ます (本文は、通知を広げると件名の下に出ます。一度に 4 通以上届いてまとめた通知には出ません)。
- 通知はメールアカウントごとに分かれます。Android の設定 → アプリ → Orbit Mail → 通知 に、アカウントの名前の分類が並び、音や表示のしかた、オン / オフを別々に変えられます。通知の一覧でも、アカウントごとにまとまって表示されます。通知するアカウントは **設定 → 通知 → アカウントごとの通知** でも選べます (すべての端末で共通)。
- 通知にはボタン (既読にする、スターを付ける、アーカイブ、削除、迷惑メールから 3 つまで) が付き、アプリを開かずに操作できます。どれを出すかは **設定 → 通知 → 通知に付けるボタン** で選びます (すべての端末で共通)。
- 通知の **返信** を押すと通知の中に入力欄が開き、アプリを開かずに差出人へ返信できます。返信には署名と元のメールの引用 (テキスト) が付き、返信したメールは既読になります。Android の通知に並ぶのは 3 つまでなので、返信欄があるときはボタンは選んだうちの最初の 2 つまでになります。送れなかったときは「返信を送れませんでした」の通知に書いた文章が残ります。
- アプリの ID (パッケージ名) は `jp.lunaproject.orbit.mail` です。スマホでは機能ごとに別のアプリにし (将来の Calendar、Contacts)、接続先サーバーとログインはアプリどうしで共有します。しくみは [mobile-shared-config.md](./mobile-shared-config.md) を参照してください。

| 場所 | 中身 |
| --- | --- |
| `apps/mobile/capacitor.config.ts` | アプリの ID、名前、プラグインの設定 |
| `apps/mobile/android/` | Android Studio で開くプロジェクト (コミットしてある) |
| `apps/mobile/scripts/generate-icons.mjs` | `assets/brand/` からアイコンと起動画面の画像を作る |
| `apps/web/src/lib/native/` | アプリの中でだけ動く処理 (起動画面、戻るボタン、テーマ、通知) |
| `apps/mobile/android/app/src/main/java/…/OrbitMessagingService.java` ほか | 通知の組み立て (`MailNotifications`) と、通知のボタン・返信欄の処理 (`NotificationActionReceiver`) |
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

画面 (Web の部分) だけの変更は、[画面の自動更新](app-update.md) を準備しておけば、サーバーを更新するだけでアプリにも届きます。

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
   bash /opt/orbit/deploy/deploy.sh
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
| 通知は届くがボタンが無い | 何通かまとめた通知 (「新着メール 4 件」など) にはボタンが付きません。1 通ずつの通知にも無いときは、設定の「通知に付けるボタン」で 1 つ以上選んであるか、サーバーの `API_PUBLIC_URL` がアプリから届く URL かを確かめる |
| ボタンを押すと「操作を反映できませんでした」と出る | 端末がオフライン、または通知が 7 日より古い。通知を押してアプリを開き、そこで操作する |
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

版の番号は、リリースのタグ (`v0.1.0`、[updates.md](updates.md)) を push すると `0.1.0` になります (それ以外は `0.1.0-<コミット>`)。通し番号 (versionCode) は、リリースでは版から決め (`scripts/android-version-code.mjs`、例 `1.2.0` → `10200999`)、それ以外は GitHub Actions の実行番号を使います。

リリースの APK は GitHub Releases に載ります (手で入れる用)。アプリ本体の自動更新は、Google Play などのアプリストアに任せます ([updates.md](updates.md))。画面 (Web の部分) は、これまでどおり接続先のサーバーの画面に自動で更新されます。

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
pnpm --filter @orbit/mobile android:prepare
# Android Studio で開く (実機かエミュレーターを選んで ▶ を押す)
pnpm --filter @orbit/mobile android:open
```

- `NEXT_PUBLIC_API_URL` を空にしてビルドすると、最初の起動時に接続先サーバーの入力画面が出ます。
- 画面 (`apps/web`) を変えたら、`android:prepare` をやり直します。
- 手元の開発用サーバー (`http://192.168.x.x:8787` など) へは、そのままでは繋がりません。アプリは平文の http 通信を許可していないためです。公開しているサーバー (https) に繋いで確認してください。
- WebView の中は、PC の Chrome で `chrome://inspect` を開くと開発者ツールで調べられます (debug 版のみ)。

## Google / Microsoft アカウントの追加

Google と Microsoft のログイン画面は、アプリの外のブラウザーで開きます (アプリの中の画面では、Google がログインを受け付けないためです)。

1. アプリで「アカウントを追加」から Google か Microsoft を選ぶと、ブラウザーが開く。
2. ログインが済むと、Web 版のページ (`https://<サーバー>/oauth/google` など) に戻り、「アプリに戻ります」と表示される。
3. 自動で、または「Orbit Mail に戻る」を押すとアプリに戻り、アカウントが追加される。

サーバー側の設定 (Google Cloud や Entra のリダイレクト URI) は Web 版と同じままで、追加の登録は要りません。アプリへ戻るときは、アプリ専用の URL (`jp.lunaproject.orbit.mail://oauth/…`) を使います。サーバーが古いと戻れないので、サーバーも最新にしてください。

## アイコンを作り直す

アイコンと起動画面の画像は `assets/brand/svg/` から作ってコミットしてあります。ロゴを変えたときは作り直します (Playwright の Chromium が必要)。

```sh
pnpm --filter @orbit/mobile icons
```

## 通知のしくみ (ボタン)

- サーバーは、通知の中身 (差出人、件名、ボタン) を FCM の data だけで送ります。アプリの受け口 (`OrbitMessagingService`) がそれを受けて、通知を組み立てて出します。そのため、**サーバーとアプリの両方を新しくする必要があります** (古いアプリには、新しいサーバーからの通知が出ません)。
- アカウントごとの分類 (通知チャンネル) の ID は `new-mail-<アカウントの ID>` です。アプリを開いたときに、いまのアカウントに合わせて作り、削除したアカウントの分は消します (`apps/web/src/lib/native/push.ts` の `syncAccountChannels`)。まだ無い分類は、通知が届いたときにアプリが作ります。
- ボタンを押すと、アプリを開かずにサーバーの `POST /v1/notification-actions` へ操作を送ります。ログインの代わりに、通知ごとに付けた合言葉 (その 1 通だけを 7 日間操作できる。サーバーの `CREDENTIALS_ENCRYPTION_KEY` から計算) を使います。
- 送り先は、サーバーの `API_PUBLIC_URL` です (`deploy/` の構成では自動で `https://<ドメイン>` になります)。
- ブラウザー (PWA) の通知にも同じボタンが付きます。ブラウザーが並べられる数 (Chrome は 2 つ) までで、設定で選んだ順に先頭から出ます。

## 引っ張って更新

メールの一覧をいちばん上で下へ引っ張ると、メールサーバーへの確認をすぐに始め、一覧を取得し直します (スマホのブラウザーでも同じです)。新しく届いたメールは、同期が済みしだい一覧に出ます。

## サイドバーのスワイプ

画面の左端から右へスワイプするとサイドバーが開き、開いているときに左へスワイプすると閉じます (スマホのブラウザーでも同じです)。一覧の行やメールのスワイプと区別するため、開く操作は左端 (24px) から始めた動きだけを受け付けます。Android を「ジェスチャー ナビゲーション」にしている端末では、画面の端からのスワイプを Android が「戻る」として先に受け取るため、開く操作は効かないことがあります (メニューのボタンで開けます)。

## 添付ファイルの保存と、ほかのアプリで開く

アプリの中の画面 (WebView) は、ブラウザーのようにダウンロード (`<a download>`) でファイルを保存できず、PDF も表示できません。そこで添付ファイルは、画面がサーバーから取得した中身をアプリ (Android 側) へ渡し、アプリが保存したり、ほかのアプリで開いたりします。

- 画面は `AppShell` プラグインの `beginFile` で一時ファイルを作り、中身を小分けの base64 にして `appendFile` で順に渡し、最後に `saveFile` か `openFile` を呼びます。一時ファイルはアプリのキャッシュ (`attachments/<id>/`) に置きます (`AttachmentFiles.java`)。
- **保存**: Android の保存先を選ぶ画面 (ファイル アプリ) が開き、選んだ場所 (端末の「ダウンロード」や Google ドライブなど) に書き出します。保存しても取り消しても、一時ファイルはすぐ消します。
- **ほかのアプリで開く**: 添付の名前に改名し、PDF ビューアーなどの対応するアプリで開きます。相手のアプリには、そのファイルだけを読む許可を渡します。相手が読んでいる間は消せないので残し、次に添付を扱うときに 24 時間より古いものを消します。開けるアプリが無いときは、画面にそう伝えます。
- 添付の名前は差出人が自由に付けられるので、パスの区切りや制御文字、先頭のドットなどを除いてからファイル名に使います。
- 画面側 (`apps/web/src/lib/native/files.ts`) は、元データで 384KB ずつ base64 にして送ります。種類 (MIME) はメールに書かれたものをそのまま使わず、拡張子と既知の種類から選びます (`lib/attachments.ts` の `safeMimeType`。分からなければ `application/octet-stream`)。古いアプリでメソッドが無いときは、従来の方法に戻ります。
- 添付のカードを押したとき、画面の中でプレビューできない種類 (Word、zip など) は、ほかのアプリで開きます (保存はカードの保存ボタン)。プレビューの画面には「保存」と「別のアプリで開く」が並びます。

### PDF のプレビュー

WebView には PDF ビューアーが無いので、添付の PDF は画面の中で pdf.js (`pdfjs-dist` の legacy 版) を使って canvas に描きます (`apps/web/src/components/mail/pdf-preview.tsx`)。ブラウザーに PDF ビューアーがある環境 (PC のブラウザー、デスクトップ版) では、これまでどおりブラウザーのビューアーで表示します。

- pdf.js のワーカー、CMap (日本語の PDF に必要)、標準フォント、wasm は、ビルドの前に `apps/web/scripts/copy-pdfjs.mjs` が `public/pdfjs/<版>/` へ写し、アプリに同梱されます (約 4.7MB)。Web 版のオフライン用の一覧にはワーカーだけを入れ、CMap などは使った分だけサービスワーカーが保存します。
- 差出人のファイルなので、描くのは canvas だけです。PDF の中のスクリプト、リンク、入力欄、XFA のフォームは使いません。
- 見えているページの付近だけを描き、離れたページの canvas は捨てます。拡大・縮小はボタンとピンチでできます。パスワード付きや壊れた PDF は、保存かほかのアプリで開くよう案内します。

## いまの制限

- 画面はステータスバーとナビゲーションバーの内側に表示します (バーの下まで画面を広げてはいません)。
- アプリを開いている間に届いたメールは、通知を出さず一覧に反映します。
- iOS 版はまだありません。同じ `apps/mobile` に `ios/` を足す形で追加できます (プッシュ通知は APNs の対応が別途必要)。
