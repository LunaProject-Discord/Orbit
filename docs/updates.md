# サーバーとアプリの更新

Orbit は **接続先のサーバーが更新を決める** 作りです。

- サーバーとアプリ (デスクトップ版、Android) は、同じ版番号 (例 `v1.2.0`) でまとめてリリースします。
- サーバーの管理者は `deploy/.env` で「どの版を追うか (チャネル)」「版を固定するか」「自動で更新するか」を決めます。
- サーバーは自分と同じ版のデスクトップ版を配り、デスクトップ版は接続先のサーバーにだけ更新を問い合わせます。
  **サーバーの版を固定すれば、デスクトップ版もその版に揃います** (オンプレミスで版を固定する運用にも使えます)。
- スマホアプリ (Android、iOS) の本体は、アプリストアで更新します。端末によってはストア以外からの入れ替えが既定で制限されているためです。
- 画面 (Web の部分) は、これまでどおり接続先のサーバーの画面に追従します ([app-update.md](app-update.md))。

| 対象 | 更新のしかた | 版の固定 |
| --- | --- | --- |
| サーバー | `deploy/update.sh` (毎日のタイマー、または手動) | `ORBIT_UPDATE_VERSION` |
| 画面 (全端末) | 接続先のサーバーの画面を取得 ([app-update.md](app-update.md)) | サーバーに従う |
| デスクトップ版の本体 | 接続先のサーバーから取得 (Tauri の updater) | サーバーに従う |
| Android の本体 | Google Play などのアプリストア (APK を手で入れた場合は、手で入れ直す) | できない (ストアに任せる) |
| iOS の本体 (作るとき) | App Store / TestFlight / MDM | できない (ストアに任せる) |

## 版とチャネル

- 版はリポジトリのルートの `package.json` の `version` と、`v` で始まるタグ (`v1.2.0`、試験版は `v1.3.0-beta.1`) で表します。
- チャネル (`ORBIT_UPDATE_CHANNEL`):
  - `stable`: 正式版のタグ (`v1.2.0`) だけを追う (既定)
  - `beta`: 試験版のタグ (`v1.3.0-beta.1`) も追う
  - `edge`: main の最新を追う (リリースの前の変更も入る)。アプリ本体は、その時点の最新のリリースの版を配る
- `ORBIT_UPDATE_VERSION=1.2.0` と書くと、その版に固定します (チャネルより優先)。
- サーバーの版は、設定の **バージョン情報** の「接続先」に出ます。main の途中のコミットでは `1.2.0-dev+<コミット>` になります。

## リリースを作る (開発側)

1. ルートの `package.json` の `version` を新しい版にして main へ入れる。
2. その版のタグを付けて push する。

   ```sh
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. Actions の **Release** が、デスクトップ版 (Windows / macOS / Linux) と Android をビルドし、GitHub Releases の `v1.2.0` に次を載せます。
   - インストーラー、APK (手で入れる用)
   - `latest.json` (デスクトップ版の更新の一覧と署名)
   - `SHA256SUMS` (すべてのファイルの SHA-256)

デスクトップ版の本体の更新には、更新ファイルの署名の鍵が要ります (下の「準備」)。鍵が無いとインストーラーだけが載り、`latest.json` は作られません。Android の APK は、配布用の署名鍵 (`ANDROID_KEYSTORE_BASE64` など、[android-app.md](android-app.md)) があるときだけ載せます (上から入れ直すには毎回同じ鍵での署名が要るため)。

## サーバーを更新する

```sh
bash deploy/update.sh --check   # 更新先の版を表示するだけ
bash deploy/update.sh --now     # いま更新する
```

`deploy/update.sh` は `deploy/.env` の方針から更新先のコミットを決め、DB のバックアップを取ってから `deploy/deploy.sh` を呼びます。

- 更新して API が起動しなければ、前のコミットに戻し、その版を `deploy/.update-state/failed` に記録して自動では二度と試しません (消せばまた試します)。
- 固定していないときは、古い版へは戻しません。固定した版がいまより古いときは、`--now` を付けたときだけ戻します。DB の変更 (マイグレーション) は戻らないので注意してください。
- 更新が済むと `deploy/app-release.sh` が、その版のデスクトップ版のファイルを GitHub Releases から `deploy/app-releases/<版>/` に取り込み、`deploy/app-releases/CURRENT` にその版を書きます。以後、接続しているデスクトップ版へその版を配ります。

### 毎日自動で更新する

```sh
# deploy/.env で ORBIT_SERVER_AUTO_UPDATE=true にしてから
sudo bash deploy/auto-update.sh install   # タイマーを入れる (毎日 ORBIT_UPDATE_TIME ごろ)
bash deploy/auto-update.sh status         # 次の実行と直近のログ
sudo bash deploy/auto-update.sh remove    # 外す
```

タイマーはリポジトリの持ち主の利用者で `deploy/update.sh` を動かします (その利用者が docker を使えること)。タイマーを入れたまま `ORBIT_SERVER_AUTO_UPDATE=false` にすれば、何もしなくなります。

GitHub Actions の **Deploy** (main に入るたびに SSH で更新する、[deploy-oracle-cloud.md](deploy-oracle-cloud.md)) は、main を追う (`edge`) 運用のためのものです。リリースを追う運用ではこのタイマーを使い、Deploy は `DEPLOY_ENABLED=false` のままにします。

### 非公開のリポジトリ、ネットにつながらないサーバー

- リポジトリが非公開なら、GitHub の Fine-grained token (そのリポジトリの **Contents** を **Read-only**) を作り、`deploy/.env` の `ORBIT_RELEASES_TOKEN` に書きます。
  別のリポジトリ (fork など) から取るときは `ORBIT_RELEASES_REPO=owner/name` も書きます。
- ネットにつながらないサーバーでは、リリースのファイル一式 (`SHA256SUMS`、`latest.json`、インストーラー) を手で `deploy/app-releases/<版>/` に置き、`deploy/app-releases/CURRENT` にその版 (例 `1.2.0`) を 1 行で書きます。サーバーのコード自体は、そのタグのコミットを手で用意して `bash deploy/deploy.sh <コミット>` で更新します。

## デスクトップ版の本体の更新のしかた

`deploy/.env` の `ORBIT_APP_UPDATE` で決めます。デスクトップ版は起動したときと 6 時間ごとに、接続先の `/v1/server-info` でこの値を読みます。

| 値 | 動き |
| --- | --- |
| `auto` (既定) | 確認せずに取得する。macOS と Linux はその場で入れ替え、次に起動したときに新しい版になる。Windows は入れ替えるとアプリが終了するので、トレイの「終了」で終わるときに入れ替える |
| `notify` | 「更新して再起動しますか」と尋ねる |
| `off` | 何もしない |

設定の **バージョン情報** の「アプリ本体の更新」から、確認と入れ替えを手で行うこともできます。

- 更新ファイルの署名を、ビルドに埋め込んだ公開鍵で確かめます。サーバーが乗っ取られても、鍵を持たない人が作ったファイルは入りません。サーバーが HTTPS でないときは更新しません。
- 古い版へ戻すことはしません。サーバーをいまのアプリより古い版に固定しても、アプリはそのまま使い続けます (下の「互換性」)。
- スマホアプリの本体はストアで更新するので、この設定は効きません。画面 (Web の部分) は、スマホアプリでもサーバーの画面に追従します。

## 互換性

- サーバーは `/v1/server-info` で、話せる API の版の範囲 (`api.minVersion`〜`api.version`) を返します。画面は自分が話せる範囲 (`apps/web/src/lib/app-update/body.ts` の `CLIENT_API_MIN`〜`CLIENT_API_MAX`) と比べ、重ならなければバージョン情報に警告を出します。
- サーバーの API は、古いアプリからも使えるよう後方互換を保ちます。互換が切れる変更をしたときだけ `apps/api/src/routes/server-info.ts` の `API_VERSION` を上げ、古いアプリへの対応をやめたときに `MIN_API_VERSION` を上げます。画面側も、新しい API を使うようにしたら `CLIENT_API_MAX` を、古いサーバーへの対応をやめたら `CLIENT_API_MIN` を上げます。
- 複数のサーバーにつなぐようになったら、アプリ本体と画面の更新は「更新元」の 1 台に従い、ほかのサーバーは互換性の判定にだけ使う想定です (未実装)。

## 準備 (1 回だけ)

1. デスクトップ版の更新ファイルの署名の鍵を作り、GitHub に登録する ([desktop-app.md](desktop-app.md) の「4. 本体の自動更新を有効にする」)。
2. (APK も載せるなら) Android の配布用の署名鍵を登録する ([android-app.md](android-app.md) の「3. 署名鍵」)。
3. 画面の自動更新の公開鍵を登録する ([app-update.md](app-update.md) の「準備」)。
4. リリースを作り (上の「リリースを作る」)、その版のデスクトップ版を 1 度だけ手で入れる (この仕組みより前のアプリは、サーバーから本体を更新できません)。
5. サーバーの `deploy/.env` に `ORBIT_*` を書き、必要ならタイマーを入れる。
