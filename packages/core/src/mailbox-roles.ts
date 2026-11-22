/** フォルダの役割 (IMAP の SPECIAL-USE に当たるもの)。 */
export const MAILBOX_ROLES = [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "junk",
  "archive",
  "all",
  "flagged",
] as const;
export type MailboxRoleName = (typeof MAILBOX_ROLES)[number];

/**
 * 利用者がアプリ内で付けられる役割。受信トレイと、Gmail の「すべてのメール」
 * 「スター付き」は、メールサーバーの仕組みと結び付いているので付け替えられない。
 */
export const ASSIGNABLE_MAILBOX_ROLES = [
  "sent",
  "drafts",
  "archive",
  "junk",
  "trash",
] as const;
export type AssignableMailboxRole = (typeof ASSIGNABLE_MAILBOX_ROLES)[number];

/** 役割の上書き。"none" は「役割なし (ふつうのフォルダ) として扱う」。 */
export const MAILBOX_ROLE_OVERRIDES = [
  ...ASSIGNABLE_MAILBOX_ROLES,
  "none",
] as const;
export type MailboxRoleOverride = (typeof MAILBOX_ROLE_OVERRIDES)[number];

export type RoleSource = {
  id: string;
  /** メールサーバーが知らせてきた役割。 */
  detected: MailboxRoleName | null;
  /** 利用者が付けた役割。付けていなければ null。 */
  override: MailboxRoleOverride | null;
};

/**
 * 1 つのアカウントのフォルダについて、実際に使う役割を決める。
 *
 * - 利用者が付けた役割があれば、それを使う ("none" なら役割なし)。
 * - 付けていなければ、メールサーバーが知らせてきた役割を使う。ただし、同じ役割を
 *   利用者がほかのフォルダに付けているなら、そちらに譲って役割なしにする
 *   (「迷惑メール」が 2 つあると、移動先が決まらないため)。
 */
export function resolveMailboxRoles(
  folders: RoleSource[],
): Map<string, MailboxRoleName | null> {
  const taken = new Set<string>(
    folders
      .map((folder) => folder.override)
      .filter((override) => override !== null && override !== "none"),
  );
  return new Map(
    folders.map((folder) => {
      if (folder.override !== null) {
        return [folder.id, folder.override === "none" ? null : folder.override];
      }
      return [
        folder.id,
        folder.detected !== null && taken.has(folder.detected)
          ? null
          : folder.detected,
      ];
    }),
  );
}
