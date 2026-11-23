# スマホアプリどうしの設定の共有

スマホでは、Orbit を機能ごとに別のアプリにします (デスクトップ版は 1 つのアプリで、複数のウィンドウを開く形です)。

| アプリ | Android のパッケージ名 / iOS の Bundle ID | 状況 |
| --- | --- | --- |
| Orbit Mail | `jp.lunaproject.orbit.mail` | Android 版あり |
| Orbit Calendar | `jp.lunaproject.orbit.calendar` | 未着手 |
| Orbit Contacts | `jp.lunaproject.orbit.contacts` | 未着手 |

どれか 1 つのアプリで接続先サーバーを決めてログインすれば、ほかのアプリでは入力し直さずに使えるようにします。

## 共有する内容

OS が違っても、同じ 2 つの値を共有します。

| 値 | 中身 |
| --- | --- |
| `serverUrl` | 接続先サーバー (API の URL。末尾の `/` 無し) |
| `sessionToken` | ログイン (API へ `Authorization: Bearer` で渡す値)。ログアウト中は空 |

端末ごとの表示の設定 (テーマ、フォントなど) は共有しません。サーバーに保存している設定は、同じ利用者でログインすればどのアプリからも同じ内容になります。

## 画面側の窓口 (OS 共通)

画面 (Web 側) は、`apps/web/src/lib/native/shared-config.ts` の 2 つの関数だけを使います。中では、アプリ専用のプラグイン `AppShell` の同じ名前のメソッドを呼びます。OS ごとの違いは、このプラグインの実装の中に閉じ込めます。

| 関数 | `AppShell` のメソッド | 動き |
| --- | --- | --- |
| `publishSharedConfig()` | `publishSharedConfig({ serverUrl, sessionToken })` | このアプリの接続先とログインを、ほかのアプリが引き継げるように保存する。ログインとログアウトのたびに呼ぶ |
| `adoptSharedConfig()` | `findSharedConfig()` → `{ found, serverUrl?, sessionToken? }` | 起動時にログインしていなければ、ほかのアプリの内容を引き継ぐ |

- 引き継いだログインが有効かどうかは、いつもどおりサーバーへ利用者を確かめて決めます。無効 (ほかのアプリでログアウト済みなど) なら、ログイン画面を出します。
- どれかのアプリでログアウトすると、サーバー側のログインが無効になるので、ほかのアプリも次にサーバーへつないだときにログアウトになります。

新しいアプリ (Calendar など) を作るときは、同じプラグインのメソッドを実装し、起動時に `adoptSharedConfig()`、ログインの状態が変わったときに `publishSharedConfig()` を呼びます (Mail では `components/auth-provider.tsx`)。

## Android

`apps/mobile/android/app/src/main/java/…/SharedConfig.java` と `SharedConfigProvider.java`。

- それぞれのアプリが、自分の内容を ContentProvider (`<パッケージ名>.shared`) で公開します。読み取り専用で、1 行 (`server_url`、`session_token`、`updated_at`) を返します。
- 読めるのは、**同じ鍵で署名したアプリだけ** です。権限 `jp.lunaproject.orbit.permission.SHARED_CONFIG` を `signature` で定義し、ContentProvider の中でも呼び出し元の署名を確かめます。
- 探す側は、決まったパッケージ名 (上の表) の ContentProvider を順に読み、接続先とログインがそろったもののうち、最も新しいものを使います。Android 11 以降は相手のアプリが見えるように、`AndroidManifest.xml` の `<queries>` にパッケージ名を並べます。
- 注意: GitHub Actions の debug 版は、ビルドのたびに署名の鍵が変わることがあります。共有を試すときは、同じ鍵で署名したアプリどうし (同じ実行で作った debug 版、またはリリース用の鍵で署名した版) を使います。

## iOS (これから)

iOS 版はまだありません。作るときは、同じ窓口 (`AppShell` の 2 つのメソッド) を次のように実装する想定です。

- 3 つのアプリを同じ開発チームで署名し、**Keychain Sharing** で同じアクセスグループ (例: `<チーム ID>.jp.lunaproject.orbit.shared`) を持たせます。
- `publishSharedConfig` は、`serverUrl`・`sessionToken`・更新の時刻を 1 つの JSON にして、そのアクセスグループの Keychain に保存します。`findSharedConfig` は、同じ項目を読みます。
- iOS では保存場所が 1 つなので、Android のように相手を順に探す必要はありません (「最も新しいもの」は、最後に保存した内容そのものです)。
- ログインを含むので、App Groups の UserDefaults ではなく Keychain に置きます。App Groups は、将来ウィジェットや通知の拡張で、ログイン以外のデータを共有するときに使います。
