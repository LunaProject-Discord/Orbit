/**
 * よく使われるメールサービスの接続先。利用者にホスト名やポートを入力させずに
 * アカウントを追加できるようにする。
 */

export type MailServer = { host: string; port: number; secure: boolean };

export type MailProviderPreset = { imap: MailServer; smtp: MailServer };

export const MAIL_PROVIDER_PRESETS = {
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  },
  icloud: {
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    // iCloud の SMTP は 587 番の STARTTLS。
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
  },
} satisfies Record<string, MailProviderPreset>;

export type PresetProvider = keyof typeof MAIL_PROVIDER_PRESETS;

const HOST_PROVIDERS: Record<string, PresetProvider> = {
  "imap.gmail.com": "gmail",
  "imap.googlemail.com": "gmail",
  "imap.mail.me.com": "icloud",
};

/**
 * IMAP のホスト名からサービスを判別する。手動で設定した場合でも、Gmail なら
 * Gmail として扱う (送信の控えを二重に保存しない、ラベルの扱いなどが変わる)。
 */
export function providerOfImapHost(host: string): PresetProvider | null {
  return HOST_PROVIDERS[host.trim().toLowerCase().replace(/\.$/, "")] ?? null;
}
