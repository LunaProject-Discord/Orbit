//! 端末に入っているフォントの一覧。設定画面で、ゴシック体・明朝体・等幅などに使うフォントを選ぶために使う
//! (WebView からは、OS のフォントの一覧を取れないことが多い)。

use std::collections::BTreeMap;

use fontdb::{Database, Language};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FontFamily {
    /// CSS の font-family に書く名前 (英語の名前)。
    family: String,
    /// 一覧に出す名前 (日本語の名前があればそちら)。
    label: String,
    /// 等幅のフォントか。
    monospace: bool,
    /// フォントのファイルに書かれている書体の分類 (sans / serif / script / decorative / symbol)。
    /// 画面側で、ゴシック体・明朝体の欄に合うフォントを先に並べるのに使う。書かれていなければ出さない。
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
}

/// フォントのファイルの OS/2 テーブルの中身を返す。複数のフォントをまとめたファイル (.ttc) は index 番目を見る。
fn os2_table(data: &[u8], index: u32) -> Option<&[u8]> {
    let u16_at = |offset: usize| {
        data.get(offset..offset + 2)
            .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]) as usize)
    };
    let u32_at = |offset: usize| {
        data.get(offset..offset + 4)
            .map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
    };
    let mut start = 0;
    if data.get(0..4)? == b"ttcf" {
        if index as usize >= u32_at(8)? {
            return None;
        }
        start = u32_at(12 + 4 * index as usize)?;
    }
    let tables = u16_at(start + 4)?;
    for i in 0..tables {
        let record = start + 12 + i * 16;
        if data.get(record..record + 4)? == b"OS/2" {
            let offset = u32_at(record + 8)?;
            let length = u32_at(record + 12)?;
            return data.get(offset..offset.checked_add(length)?);
        }
    }
    None
}

/// OS/2 テーブルの PANOSE と sFamilyClass から、書体の分類を読む。
/// 和文のフォントには書かれていないことが多いので、画面側では名前からの見分けを優先する。
fn classify(os2: &[u8]) -> Option<&'static str> {
    let panose = os2.get(32..42)?;
    match panose[0] {
        // 欧文のテキスト用: 2 番目 (セリフの形) で見分ける。
        2 => match panose[1] {
            2..=10 => return Some("serif"),
            11..=13 | 15 => return Some("sans"),
            _ => {}
        },
        3 => return Some("script"),
        4 => return Some("decorative"),
        5 => return Some("symbol"),
        _ => {}
    }
    // sFamilyClass の上位の 1 バイト。
    match os2[30] {
        1..=5 | 7 => Some("serif"),
        8 => Some("sans"),
        9 => Some("decorative"),
        10 => Some("script"),
        12 => Some("symbol"),
        _ => None,
    }
}

/// フォントの名前の組 (名前, 言語) と等幅かどうかから、一覧を作る。
/// 同じ名前のフォント (太さ違いなど) は 1 つにまとめ、名前順に並べる。
fn collect<'a>(
    faces: impl Iterator<Item = (&'a [(String, Language)], bool, Option<&'static str>)>,
) -> Vec<FontFamily> {
    let mut families: BTreeMap<String, FontFamily> = BTreeMap::new();
    for (names, monospace, kind) in faces {
        // 先頭は英語の名前 (フォントに無ければ、ほかの言語の名前)。
        let Some((family, _)) = names.first() else {
            continue;
        };
        if family.is_empty() || family.starts_with('.') {
            // 名前が . で始まるのは OS の内部用のフォントで、画面からは指定できない。
            continue;
        }
        let label = names
            .iter()
            .find(|(_, language)| *language == Language::Japanese_Japan)
            .map(|(name, _)| name.clone())
            .unwrap_or_else(|| family.clone());
        families
            .entry(family.clone())
            .and_modify(|entry| {
                entry.monospace |= monospace;
                entry.kind = entry.kind.or(kind);
            })
            .or_insert(FontFamily {
                family: family.clone(),
                label,
                monospace,
                kind,
            });
    }
    families.into_values().collect()
}

fn system_fonts() -> Vec<FontFamily> {
    let mut database = Database::new();
    database.load_system_fonts();
    collect(database.faces().map(|face| {
        let kind = database
            .with_face_data(face.id, |data, index| {
                os2_table(data, index).and_then(classify)
            })
            .flatten();
        (face.families.as_slice(), face.monospaced, kind)
    }))
}

/// 端末に入っているフォントの一覧を返す。フォントのファイルを読むので、別のスレッドで調べる。
#[tauri::command]
pub(crate) async fn list_fonts() -> Result<Vec<FontFamily>, String> {
    tauri::async_runtime::spawn_blocking(system_fonts)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[(&str, Language)]) -> Vec<(String, Language)> {
        list.iter()
            .map(|(name, language)| (name.to_string(), *language))
            .collect()
    }

    #[test]
    fn 同じ名前のフォントをまとめて日本語の名前を出す() {
        let gothic = names(&[
            ("Yu Gothic", Language::English_UnitedStates),
            ("游ゴシック", Language::Japanese_Japan),
        ]);
        let mono = names(&[("Consolas", Language::English_UnitedStates)]);
        let hidden = names(&[(".SF NS", Language::English_UnitedStates)]);
        let fonts = collect(
            [
                (gothic.as_slice(), false, None),
                (gothic.as_slice(), false, Some("sans")),
                (mono.as_slice(), true, None),
                (hidden.as_slice(), false, None),
            ]
            .into_iter(),
        );
        assert_eq!(
            fonts,
            vec![
                FontFamily {
                    family: "Consolas".into(),
                    label: "Consolas".into(),
                    monospace: true,
                    kind: None,
                },
                FontFamily {
                    family: "Yu Gothic".into(),
                    label: "游ゴシック".into(),
                    monospace: false,
                    kind: Some("sans"),
                },
            ]
        );
    }

    fn os2(panose: [u8; 2], family_class: u8) -> Vec<u8> {
        let mut table = vec![0u8; 96];
        table[30] = family_class;
        table[32] = panose[0];
        table[33] = panose[1];
        table
    }

    #[test]
    fn 書体の分類を読む() {
        assert_eq!(classify(&os2([2, 2], 0)), Some("serif"));
        assert_eq!(classify(&os2([2, 11], 0)), Some("sans"));
        assert_eq!(classify(&os2([3, 0], 0)), Some("script"));
        assert_eq!(classify(&os2([0, 0], 8)), Some("sans"));
        assert_eq!(classify(&os2([0, 0], 1)), Some("serif"));
        assert_eq!(classify(&os2([0, 0], 0)), None);
        assert_eq!(classify(&[0u8; 10]), None);
    }

    #[test]
    fn ファイルから_os2_テーブルを探す() {
        let table = os2([2, 11], 0);
        // 表が 1 つだけの、最小のフォントのファイル。
        let mut data = vec![0u8; 12];
        data[4..6].copy_from_slice(&1u16.to_be_bytes());
        data.extend_from_slice(b"OS/2");
        data.extend_from_slice(&[0; 4]);
        data.extend_from_slice(&(28u32).to_be_bytes());
        data.extend_from_slice(&(table.len() as u32).to_be_bytes());
        data.extend_from_slice(&table);
        assert_eq!(os2_table(&data, 0).and_then(classify), Some("sans"));
        assert_eq!(os2_table(&data[..20], 0), None);
    }
}
