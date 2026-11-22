/**
 * 配信停止の URL (List-Unsubscribe ヘッダー) を、見出しに出すリンクにする。
 * https はページを開き、mailto は配信停止を依頼するメールの作成を始める。それ以外は出さない。
 */
export function unsubscribeLinks(
  urls: string[],
): { href: string; label: string }[] {
  const links: { href: string; label: string }[] = [];
  for (const href of urls) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.protocol === "https:") {
      links.push({ href, label: `ページを開く (${url.hostname})` });
    } else if (url.protocol === "mailto:") {
      let address = url.pathname;
      try {
        address = decodeURIComponent(address);
      } catch {
        // 壊れた % 表記は、そのまま出す。
      }
      links.push({ href, label: `メールで依頼 (${address})` });
    }
  }
  return links;
}
