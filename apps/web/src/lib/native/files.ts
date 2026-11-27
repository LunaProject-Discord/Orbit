/**
 * スマホアプリ (Android) で、添付ファイルを端末に保存したり、別のアプリで開いたりする。
 * WebView は <a download> で保存できず、PDF なども表示できないので、中身をアプリ側
 * (apps/mobile の AppShellPlugin、AttachmentFiles) へ渡して任せる。しくみは docs/android-app.md。
 *
 * 渡し方: beginFile で一時ファイルを作り、中身を小分けの base64 にして appendFile で順に送り、
 * 最後に saveFile か openFile を呼ぶ。
 */

import { isNativeApp, loadAppShell } from "@/lib/native/app";

/**
 * 1 回の appendFile で送る元データの大きさ。アプリ側との取り決め (512KB 以下) より小さく、
 * 3 の倍数にして base64 の途中に詰め物 (=) が入らないようにする。
 * 一度に大きく送ると、base64 の文字列と橋渡しの JSON の分だけ WebView のメモリを食う。
 */
export const FILE_CHUNK_BYTES = 384 * 1024;

/** blob の一部を base64 にする。FileReader に任せ、大きな文字列の組み立てを JavaScript でしない。 */
function chunkToBase64(chunk: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("ファイルを読めませんでした。"));
    reader.readAsDataURL(chunk);
  });
}

/** アプリが、呼んだメソッドを持っていない (古いアプリ)。Capacitor は code で知らせる。 */
function isUnimplemented(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "UNIMPLEMENTED"
  );
}

type Handoff = "saveFile" | "openFile";

/**
 * 中身をアプリ側へ渡して、保存か外部アプリでの表示を頼む。結果の真偽を返す。
 * アプリの中でないか、古いアプリでメソッドが無ければ null (呼び出し側は従来の方法へ)。
 * それ以外の失敗は例外のまま返す (呼び出し側が知らせる)。
 */
async function handOff(
  method: Handoff,
  blob: Blob,
  filename: string,
  mimeType: string,
): Promise<boolean | null> {
  if (!isNativeApp()) return null;
  const { AppShell } = await loadAppShell();
  let id: string;
  try {
    ({ id } = await AppShell.beginFile());
  } catch (error) {
    if (isUnimplemented(error)) return null;
    throw error;
  }
  // 1 つずつ順に送る (アプリ側は届いた順に後ろへ足す)。一度に読むのは 1 切れだけにする。
  for (let start = 0; start < blob.size; start += FILE_CHUNK_BYTES) {
    const data = await chunkToBase64(
      blob.slice(start, start + FILE_CHUNK_BYTES),
    );
    await AppShell.appendFile({ id, data });
  }
  const options = { id, name: filename, mimeType };
  if (method === "saveFile") {
    return (await AppShell.saveFile(options)).saved === true;
  }
  return (await AppShell.openFile(options)).opened === true;
}

/**
 * ファイルを保存する。保存先は、アプリ側が Android の画面 (ファイル アプリ) で利用者に選ばせる。
 * 保存したら true、保存先を選ぶのをやめたら false、アプリ側に頼めなければ null (古いアプリ、ブラウザー)。
 */
export function saveFileNative(
  blob: Blob,
  filename: string,
  mimeType: string,
): Promise<boolean | null> {
  return handOff("saveFile", blob, filename, mimeType);
}

/**
 * ファイルを、対応するほかのアプリ (PDF ビューアーなど) で開く。
 * 開いたら true、開けるアプリが無ければ false、アプリ側に頼めなければ null (古いアプリ、ブラウザー)。
 */
export function openFileNative(
  blob: Blob,
  filename: string,
  mimeType: string,
): Promise<boolean | null> {
  return handOff("openFile", blob, filename, mimeType);
}
