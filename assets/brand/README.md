# Orbit のアイコンとロゴ

Orbit (by Luna Project) のブランド素材です。Web (apps/web) のアイコンとロゴはここから作っています。

## 形の決まり

- **輪 (軌道)** の右下に、**Luna Project の月** (黄色 `#ffc636`、Luna Project のアセットの形そのまま) が衛星として乗る。これが Orbit 共通の記号。
- 輪の中のモチーフと色が製品ごとに変わる。

  | 製品 | モチーフ | 色 (グラデーション) |
  | --- | --- | --- |
  | Orbit Mail | 封筒の折り目 | `#5B5BF0` → `#8B5CF6` |
  | Orbit Calendar (案) | 見出しの帯と日付の点 | `#F9603A` → `#F43F7A` |
  | Orbit Contacts (案) | 人の頭と肩 | `#0FA58F` → `#22B8CF` |

  Calendar と Contacts は方向性を示す案で、未確定。
- 暗い背景用のアイコンは、タイルが `#14162A`、輪は明るめのグラデーション。
- ロゴの文字は **LINE Seed** (Luna Project のロゴと同じ書体、SIL Open Font License 1.1) をパスにしたもの。「Orbit」は Bold、製品名は Regular。

## ファイル

- `svg/` — 生成した SVG。
  - `orbit-mail-icon.svg` / `-dark` : 角丸のアプリアイコン (明 / 暗)
  - `orbit-mail-icon-square.svg` : 四角いっぱい (iOS など、OS が角を丸める場所用)
  - `orbit-mail-icon-maskable.svg` : 安全領域に収めた版 (Android の maskable / adaptive icon 用)
  - `orbit-mail-icon-small.svg` : 32px 以下用 (線を太く、月を大きくした版)
  - `orbit-mail-mark.svg` / `-dark` : 背景なしの記号
  - `orbit-mail-logo.svg` / `-dark` : 横組みロゴ
  - `orbit-*.svg` : 製品のモチーフがない共通マーク、`orbit-calendar-*` / `orbit-contacts-*` : 展開案
- `png/` — 書き出した PNG。Desktop (Tauri) とスマホアプリ (Capacitor) のアイコン生成には `orbit-mail-icon-1024.png` (角丸)、`orbit-mail-icon-square-1024.png` (iOS)、`orbit-mail-icon-maskable-1024.png` (Android) を元にする。
- `data/` — Luna Project の月のパスと、LINE Seed からパスにした文字。

## 作り直し方

```sh
node assets/brand/build.mjs        # SVG と apps/web/src/components/brand/brand-data.ts を作る (依存なし)
node assets/brand/export-png.mjs   # PNG を書き出す (Playwright の Chromium が必要)
# favicon.ico (16 / 32 / 48px) は ImageMagick でまとめる
convert assets/brand/png/favicon-16.png assets/brand/png/favicon-32.png assets/brand/png/favicon-48.png apps/web/src/app/favicon.ico
cp assets/brand/svg/orbit-mail-icon-small.svg apps/web/src/app/icon.svg
```

画面に直接描くロゴは `apps/web/src/components/brand/orbit-logo.tsx` (`OrbitMark` / `OrbitLogo`)。記号の数値を変えたら、この部品の数値もそろえる。
