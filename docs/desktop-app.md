# デスクトップ版

Orbit のデスクトップ版 (`apps/desktop`、Windows / macOS / Linux) のビルド、入れ方、更新、署名の手順です。

## しくみ

- [Tauri 2](https://tauri.app/) で、Web 版の画面 (`apps/web` の静的出力) をそのままアプリに入れています。画面のコードは Web 版と共通です。
- アプリの中にあるのは画面だけで、メールは自分のサーバー (API) から取得します。最初に接続するサーバーはビルド時に決め (既定は `https://orbit.lunaproject.jp`)、ログイン画面の「接続先 … 変更」から後で変えられます。API は、デスクトップ版の画面のオリジン (`tauri://localhost`、`http://tauri.localhost`) を最初から許可しています。
- ログインの状態は、アプリのデータ (WebView の保存領域) に残ります。アプリを終了しても、次に開いたときはログインしたままです。
- アプリの ID は `jp.lunaproject.orbit` です。デスクトップ版は、メール・カレンダー・連絡先を 1 つのアプリにまとめる方針です (スマホは `jp.lunaproject.orbit.mail` のように、機能ごとに別のアプリにします)。2026-11-23 までにビルドしたもの (`jp.lunaproject.orbit.mail`) とはデータの保存場所が変わるので、入れ替えたあとはログインし直してください。ログインの戻り先の URL (`jp.lunaproject.orbit.mail://`) は Android のメールアプリと共通のままです。

### Orbit という 1 つのアプリ

- デスクトップ版は **Orbit** という名前の 1 つのアプリです (v0.2.0 までは「Orbit Mail」という名前でした)。Orbit Mail・Orbit Calendar・Orbit Contacts は、同じアプリを `--app=mail` などの引数付きで起動するショートカットです。すでに起動しているときは、そのアプリのウィンドウを前に出します (`src-tauri/src/launch.rs`)。
- いまあるのは Orbit Mail だけです。カレンダーと連絡先は、アプリにできてからショートカットを足します (アイコンは `icons/apps/` に用意済み)。足す場所は、Windows が `src-tauri/windows/orbit.nsh` の `ORBIT_APPS`、Linux が `src-tauri/linux/orbit.desktop` の `Actions`、アプリ側が `launch.rs` の `open_app` です。
- OS ごとの見え方:

  | OS | 見え方 |
  | --- | --- |
  | Windows | スタートメニューとデスクトップに「Orbit Mail」。「アプリと機能」には「Orbit」が 1 つ |
  | macOS | 「Orbit.app」が 1 つ。メールなどの切り替えはアプリの中で行う (macOS には引数付きのショートカットの決まった形が無いため) |
  | Linux | メニューに「Orbit」。右クリック (アクション) に「Orbit Mail」 |

- アプリ本体のアイコンは Orbit 共通のもの、メールのウィンドウ (タスクバー) とショートカットはメールのアイコンです。アイコンとインストーラーの画像は `node apps/desktop/scripts/generate-assets.mjs` で `assets/brand/svg/` から作り直せます (Playwright の Chromium と ImageMagick が必要)。

### 名前を Orbit Mail から Orbit に変えたときに保っていること

自動更新で入れ替わる既存のアプリが壊れないよう、次は変えていません。

- アプリの ID (`jp.lunaproject.orbit`): データの保存場所が同じなので、ログインと設定はそのまま残ります。
- 実行ファイルの名前 (`orbit-desktop`)、ログインの戻り先の URL (`jp.lunaproject.orbit.mail://`)、自動更新の問い合わせ先。
- MSI の upgradeCode (旧名から計算した値を `tauri.conf.json` に固定)。MSI 版は名前が変わっても上書きで入れ替わります。

OS ごとの入れ替わり方:

- **Windows (setup.exe)**: 新しいインストーラーが「Orbit Mail」の登録を見つけると、その版のアンインストーラーを静かに動かして取り除き (データは消さない)、`%LOCALAPPDATA%\Orbit` に入れ直して、ショートカットを作り直します。自動更新 (`/P /UPDATE`) のときも同じです。タスクバーにピン留めしていた「Orbit Mail」は外れるので、留め直してください。
- **macOS**: 自動更新は、今ある場所のアプリをそのまま中身ごと入れ替えます。そのため Finder 上の名前は「Orbit Mail.app」のまま残り、Dock やメニューの名前は「Orbit」になります。名前もそろえたいときは、`/Applications/Orbit Mail.app` を「Orbit.app」に名前を変えるか、新しい dmg から入れ直してください (データは残ります)。
- **Linux**: パッケージ名が `orbit-mail` から `orbit` に変わります。`orbit` は `orbit-mail` を置き換える (deb は Conflicts / Replaces、rpm は Obsoletes) ので、更新で古いほうは自動で外れます。AppImage はファイルの中身だけが入れ替わります。

### Windows のインストーラー

ウィザード (次へ・次へ…) は出しません。setup.exe を開くと、ロゴと進み具合だけの小さな画面が出て、ユーザーのフォルダー (`%LOCALAPPDATA%\Orbit`、管理者の権限は不要) に入り、終わると Orbit Mail が起動します。

- 最初に入れたときは、スタートメニューとデスクトップに Orbit Mail のショートカットを作ります。自動更新では作り直しません (消したショートカットが戻らないように)。
- 画面の文字は Windows の表示言語に合わせて日本語か英語です。
- アンインストールは「アプリと機能」から行います。確認の画面が 1 つ出て、「このパソコンに保存したデータ (ログイン状態・設定・キャッシュ) も削除する」を選べます (メールはサーバーに残ります)。
- コマンドから使うときの引数は Tauri の NSIS と同じです (`/S` 画面なし、`/P` 進み具合だけ、`/NS` ショートカットを作らない、`/UPDATE` 更新)。
- 中身は Tauri の標準のテンプレートを元にした `src-tauri/windows/installer.nsi` と、Orbit の部品 `src-tauri/windows/orbit.nsh` です。`@tauri-apps/cli` を上げるときは、標準のテンプレート (tauri-bundler の `src/bundle/windows/nsis/installer.nsi`) の変更を見比べて取り込みます。
- GitHub Actions の Windows のビルドでは、v0.2.0 (Orbit Mail) を入れてから自動更新と同じ引数で新しい版を入れ、置き換わること、新しく入れたときに起動すること、アンインストールで消えることを確かめます (`scripts/check-windows-installer.ps1`)。画面の様子は成果物 `windows-installer-screens` に残ります。
- MSI (`*.msi`) は、会社などで一括配布する用に残しています (画面は WiX の標準のまま)。普段は setup.exe を使ってください。

| 場所 | 中身 |
| --- | --- |
| `apps/desktop/src-tauri/tauri.conf.json` | アプリの ID、名前、ウィンドウ、インストーラーの設定 (`tauri.macos.conf.json` は macOS だけの上書き) |
| `apps/desktop/src-tauri/src/` | OS との橋渡し (ウィンドウ、通知領域、未読数、通知、外部リンク、自動更新) |
| `apps/desktop/src-tauri/icons/` | アプリのアイコン (`assets/brand/` から作ったもの。`apps/` はアプリごとのアイコン) |
| `apps/desktop/src-tauri/windows/`、`linux/` | Windows のインストーラー、Linux のメニューの項目 |
| `apps/desktop/scripts/ci-config.mjs` | GitHub Actions でのビルドに重ねる設定 (署名、自動更新) を作る |
| `apps/web/src/lib/desktop/`、`apps/web/src/components/desktop/` | アプリの中でだけ動く画面側の処理 (タイトルバーなど) |
| `.github/workflows/desktop.yml` | GitHub Actions でのビルド |

### Web 版との違い

- **ウィンドウ枠**: Windows と Linux では OS の枠を外し、アプリのタイトルバー (最小化・最大化・閉じる) を出します。macOS では OS のボタン (左上の 3 つ) をそのまま使います。
- **複数のウィンドウ**: 一覧のメールを右クリックして **新しいウィンドウで開く** を選ぶと、そのメールを別のウィンドウで開きます。作成画面は、見出しのボタンから別のウィンドウへ移せます (書きかけの内容は下書きとして保存され、新しいウィンドウがそれを開きます)。ウィンドウどうしは同じログインと設定を使います。追加のウィンドウは 16 個までで、閉じるとそのまま閉じます (通知領域に残るのはメインウィンドウだけ)。新着メールの通知と、通知を押したときに開く先は、メインウィンドウです。
- **通知領域 (トレイ)**: ウィンドウを閉じてもアプリは通知領域に残り、新着メールの通知を受け続けます。アイコンを押すとウィンドウが戻ります。右クリックのメニューから、「ウィンドウを閉じても通知を受け取る」の切り替え、更新の確認、終了ができます。
- **新着メールの通知**: OS の通知で知らせ、押すとそのメールを開きます。最初から有効で、**設定 → 通知** で切れます。届くのはアプリを起動している間 (通知領域に入っている間を含む) です。アプリを終了すると届きません。
- **通知のボタンと返信欄 (Windows)**: Windows の通知には、返信欄と、**設定 → 通知 → 通知に付けるボタン** で選んだボタン (既読にする、アーカイブなど) が付きます。返信欄に書いて、入力欄の右側の送信ボタン (紙飛行機のアイコン) を押すと、ウィンドウを開かずに、本文の下の返信欄と同じ内容 (署名と引用付き) で差出人へ返信します。送れなかったときは OS の通知で知らせます。通知が画面に出ている間に使ってください。通知センターに移ったあとの通知のボタンや返信欄は、アプリへ届かないことがあります (通知のプラグインと同じ制限です)。macOS と Linux の通知は、これまでどおり押すとメールを開くだけです。
- **未読数**: 通知領域のアイコンに赤い丸、ツールチップに件数を出します。macOS は Dock のアイコンとメニューバーに件数、Windows はタスクバーのアイコンに赤い丸を出します。
- **リンク**: メール本文のリンクは、OS の既定のブラウザーで開きます。
- **Google / Microsoft アカウントの追加**: ログイン画面は既定のブラウザーで開き、ログインが済むとアプリへ戻ります (Android アプリと同じ流れで、`jp.lunaproject.orbit.mail://` という URL でアプリを呼び出します)。
- **キー操作** (macOS は Ctrl の代わりに ⌘): ブラウザーとしてのキー (再読み込み、印刷、ページ内検索など) は止め、アプリの操作を割り当てています。

  | キー | 操作 |
  | --- | --- |
  | Ctrl+R / F5 | フォルダの更新 (表示中のフォルダをすぐにメールサーバーへ確認させ、一覧を取り直す) |
  | Ctrl+Shift+R / Shift+F5 | アカウントの更新 (選んでいるアカウント、選んでいなければ全アカウントを確認させる) |
  | Ctrl+Alt+R / Ctrl+Alt+F5 | 画面の再読み込み |
  | Ctrl+Alt+Shift+R / Ctrl+Alt+Shift+F5 | 強制再読み込み (キャッシュを使わずに読み込み直す) |
  | Ctrl+F / F3 | 検索欄へ移る (メールだけのウィンドウでは、メールの中を検索) |
  | Ctrl+Shift+F / Shift+F3 | 開いているメールの中を検索 |
  | Ctrl+P | 開いているメールを印刷 (本文を開いているメール。メールを開いていなければ何もしない) |

- **ブラウザーの機能**: 次のものは出しません。ズーム (Ctrl+± / Ctrl+ホイール / ピンチ)、リンクの URL の表示、マウスの戻る・進むボタンとスワイプ、Ctrl+U などのブラウザーのキー、画像やリンクのドラッグ、スペルチェックの波線、翻訳の提案、ブラウザーの右クリックメニューと自動入力。画面の文字は、入力欄とメールの内容 (見出しと本文) だけ選べます。添付ファイルは、保存先を選ぶ画面を出して保存します (ブラウザーのダウンロードの一覧は使いません)。開発中のビルドでは、開発者ツール (F12) を使えるよう、Windows のブラウザーのキーを止めていません。

## 1. GitHub Actions でビルドして入れる (いちばん手軽)

手元に開発環境が無くても、GitHub 上でインストーラーを作れます。

1. GitHub のリポジトリで **Actions → Desktop → Run workflow** を押す (ブランチは `main`)。3 つの OS 向けに並行してビルドします (初回は 20 分前後かかります)。
2. 終わったら、その実行のページの下にある **Artifacts** から、使う OS のものをダウンロードして展開する。

| Artifacts | 中身 | 入れ方 |
| --- | --- | --- |
| `orbit-windows` | `*-setup.exe` (NSIS)、`*.msi` | `*-setup.exe` を開く (MSI は一括配布用) |
| `orbit-macos` | `*.dmg` (Apple シリコンと Intel の両対応) | 開いて、アプリを「アプリケーション」へドラッグする |
| `orbit-linux` | `*.deb`、`*.rpm`、`*.AppImage` | ディストリビューションに合うものを入れる |

`apps/desktop` を変えたプルリクエストと `main` への push でも自動でビルドされます。Web の画面だけを変えたときは自動では作り直さないので、最新の画面を入れたいときは Run workflow を使ってください。

### 署名していないインストーラーを開くとき

署名の証明書を用意するまでは (下の「5. 署名」)、OS が警告を出します。自分でビルドしたものであれば、次の操作で開けます。

- **Windows**: 「Windows によって PC が保護されました」と出たら、**詳細情報 → 実行** を押す。
- **macOS**: 最初に開くと「開発元を確認できない」などと出て止まります。**システム設定 → プライバシーとセキュリティ** の下のほうにある **このまま開く** を押すか、ターミナルで `xattr -dr com.apple.quarantine "/Applications/Orbit.app"` を実行する。

### 新しい版に入れ替える (自動更新を有効にするまで)

画面 (Web の部分) だけの変更は、[画面の自動更新](app-update.md) を準備しておけば、サーバーを更新するだけでアプリにも届きます (アプリを入れ直す必要はありません)。

アプリ本体の自動更新は、リポジトリを公開するまで無効です。アプリ本体を新しい版にするには、もう一度 Run workflow でビルドし、同じ手順でインストーラーを実行します (上書きで入ります。ログインの状態や設定は残ります)。

## 2. 手元でビルドする

必要なものは、Node.js と pnpm (リポジトリの README を参照) に加えて次のとおりです。

- [Rust](https://www.rust-lang.org/ja/tools/install) (stable)
- Windows: 「C++ によるデスクトップ開発」を入れた Visual Studio Build Tools と WebView2 (Windows 10 / 11 には最初から入っています)
- macOS: Xcode Command Line Tools
- Linux: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf` など (Tauri の [前提条件](https://tauri.app/start/prerequisites/) を参照)

```sh
pnpm install

# 開発: Web の開発サーバー (http://localhost:3000) を起動し、それをアプリのウィンドウで開く。
# API は別に起動しておく (pnpm dev)。
pnpm --filter @orbit/desktop desktop:dev

# インストーラーを作る (apps/desktop/src-tauri/target/release/bundle/ にできる)。
# 最初に接続するサーバーを決めておくなら、NEXT_PUBLIC_API_URL を渡す。
pnpm --filter @orbit/desktop desktop:build
```

PowerShell で接続先を渡すときは、先に `$env:NEXT_PUBLIC_API_URL = "https://orbit.example.com"` を実行します。

Rust 側のテストは `apps/desktop/src-tauri` で `cargo test` です (先に `pnpm --filter @orbit/web build` で `apps/web/out` を作っておくか、空の `apps/web/out` フォルダーを作っておきます)。

## 3. 版を付けて出す

版のリリースは、サーバーと Android と一緒に `v` で始まるタグで作ります ([updates.md](updates.md) の「リリースを作る」)。

```sh
git tag v0.1.0
git push origin v0.1.0
```

Actions の **Release** がインストーラーをビルドし、GitHub Releases の `v0.1.0` に載せます。タグの版がそのままアプリの版になります。
リポジトリが非公開の間は、Releases のページはリポジトリを見られる人だけが開けます。

## 4. 本体の自動更新を有効にする

アプリ本体は、**接続先のサーバーから** 更新を受け取ります。サーバーは自分と同じ版のアプリを配るので、サーバーの版を固定すればアプリもその版に揃います。リポジトリが非公開でも、サーバーがリリースを取り込めれば動きます (しくみと更新のしかたの設定は [updates.md](updates.md))。

1. 更新ファイルに署名する鍵の組を作る (1 回だけ)。

   ```sh
   pnpm --filter @orbit/desktop tauri signer generate -w orbit-mail-updater.key
   ```

   パスワードを尋ねられます (空でも作れます)。`orbit-mail-updater.key` (秘密鍵) と `orbit-mail-updater.key.pub` (公開鍵) ができます。
   **秘密鍵とパスワードは安全な場所に控えてください。失うと、すでに配ったアプリへ更新を届けられなくなります** (利用者に入れ直してもらうことになります)。リポジトリにはコミットしないでください。

2. GitHub のリポジトリの **Settings → Secrets and variables → Actions** に登録する。

   | 種類 | 名前 | 値 |
   | --- | --- | --- |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY` | `orbit-mail-updater.key` の中身 |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 鍵のパスワード (空にしたなら登録しない) |
   | Variable | `TAURI_UPDATER_PUBKEY` | `orbit-mail-updater.key.pub` の中身 |

3. 「3. 版を付けて出す」の手順でリリースを作る。Releases に、インストーラーと一緒に更新用のファイル (`latest.json` と署名) が載ります。

この準備をしたあとにビルドしたアプリは、接続先のサーバーの設定 (`ORBIT_APP_UPDATE`) に従って、起動の少しあとと 6 時間ごとに新しい版を確かめます。通知領域のメニューの **更新を確認…** と、設定の **バージョン情報** からも確かめられます。準備をする前にビルドしたアプリには更新の仕組みが入っていないので、1 度だけ手で入れ直す必要があります。

## 5. 署名 (配布するとき)

自分で使うだけなら不要です。ほかの人に配るときは、OS の警告を出さないために署名します。どちらも有料で、あおいさん側での契約と登録が必要です。

### Windows

コード署名の証明書を `.pfx` として書き出せる場合は、次を登録すると、ビルドのときに署名します。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| Secret | `WINDOWS_CERTIFICATE` | `.pfx` を base64 にした値 (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) |
| Secret | `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` のパスワード |

近年発行される証明書は、秘密鍵を USB トークンやクラウドの HSM に置く決まりになっていて、`.pfx` に書き出せないものが多くあります。その場合はこの方法は使えず、Azure の Trusted Signing などクラウドで署名するサービスに合わせた設定が別に必要です (未対応。必要になったら追加します)。

### macOS

[Apple Developer Program](https://developer.apple.com/programs/) (年額) に加入し、「Developer ID Application」の証明書を作って `.p12` に書き出します。次を登録すると、ビルドのときに署名と公証 (notarization) を行います。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| Secret | `APPLE_CERTIFICATE` | `.p12` を base64 にした値 (`base64 -i certificate.p12`) |
| Secret | `APPLE_CERTIFICATE_PASSWORD` | `.p12` のパスワード |
| Secret | `APPLE_SIGNING_IDENTITY` | 証明書の名前 (例: `Developer ID Application: Your Name (TEAMID)`) |
| Secret | `APPLE_ID` | Apple ID のメールアドレス |
| Secret | `APPLE_PASSWORD` | Apple ID の「アプリ用パスワード」 |
| Secret | `APPLE_TEAM_ID` | チーム ID |

証明書が無いときは、その場限りの署名 (ad-hoc) を付けてビルドします (Apple シリコンの Mac で起動するために必要です)。

## 確認できていること、できていないこと

- 確認済み (Linux、仮想の画面で起動): タイトルバーの表示、接続先サーバーの設定、ログイン、再起動後もログインが残ること、作成画面と最大化、新着メールの通知とそれを押してメールを開く動き、閉じたときに通知領域へ残ること、二重に起動するとすでにあるウィンドウが出ること、アプリ専用の URL で開いたときの受け渡し。
- 未確認: Windows と macOS の実機での動作全般 (GitHub Actions でビルドが通ることだけを確認しています)。特に、通知領域のアイコンとメニュー、タスクバーや Dock の未読の表示、通知を押したときの動き、Google / Microsoft のログインからアプリへ戻る流れ、添付ファイルの保存、インストーラーの動作は、実機で確かめる必要があります。
- 未確認: キー操作とブラウザーの機能を止めた動き (Windows / macOS / Linux の実機)。特に、印刷の画面 (macOS の WebView は印刷に対応していない場合があります)、強制再読み込み、添付ファイルの保存先を選ぶ画面、マウスの戻るボタン。
- 未確認: 自動更新の一連の流れ (鍵の登録とリポジトリの公開が前提のため)。
