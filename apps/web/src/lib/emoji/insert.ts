/**
 * 入力欄の文字列の、選択している範囲 (無ければカーソルの位置) を text に置き換える。
 * 位置が分からないとき (一度もフォーカスしていない入力欄など) は、末尾に足す。
 * maxLength を超えるなら、何も変えずに null を返す。
 */
export function insertIntoText(
  value: string,
  selection: { start: number | null; end: number | null },
  text: string,
  maxLength?: number,
): { value: string; caret: number } | null {
  const start = Math.min(selection.start ?? value.length, value.length);
  const end = Math.max(start, Math.min(selection.end ?? start, value.length));
  const next = value.slice(0, start) + text + value.slice(end);
  if (maxLength !== undefined && next.length > maxLength) return null;
  return { value: next, caret: start + text.length };
}

/**
 * input / textarea のカーソルの位置に text を入れ、新しい文字列を onChange に渡す。
 * 描き直された後に、入れた文字の後ろへカーソルを置いてフォーカスを戻す。
 */
export function insertIntoField(
  field: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  text: string,
  onChange: (next: string) => void,
) {
  const inserted = insertIntoText(
    value,
    { start: field?.selectionStart ?? null, end: field?.selectionEnd ?? null },
    text,
    field && field.maxLength > 0 ? field.maxLength : undefined,
  );
  if (!inserted) return;
  onChange(inserted.value);
  requestAnimationFrame(() => {
    if (!field) return;
    field.focus();
    field.setSelectionRange(inserted.caret, inserted.caret);
  });
}
