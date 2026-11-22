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
}

/// フォントの名前の組 (名前, 言語) と等幅かどうかから、一覧を作る。
/// 同じ名前のフォント (太さ違いなど) は 1 つにまとめ、名前順に並べる。
fn collect<'a>(faces: impl Iterator<Item = (&'a [(String, Language)], bool)>) -> Vec<FontFamily> {
    let mut families: BTreeMap<String, FontFamily> = BTreeMap::new();
    for (names, monospace) in faces {
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
            .and_modify(|entry| entry.monospace |= monospace)
            .or_insert(FontFamily {
                family: family.clone(),
                label,
                monospace,
            });
    }
    families.into_values().collect()
}

fn system_fonts() -> Vec<FontFamily> {
    let mut database = Database::new();
    database.load_system_fonts();
    collect(
        database
            .faces()
            .map(|face| (face.families.as_slice(), face.monospaced)),
    )
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
                (gothic.as_slice(), false),
                (gothic.as_slice(), false),
                (mono.as_slice(), true),
                (hidden.as_slice(), false),
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
                },
                FontFamily {
                    family: "Yu Gothic".into(),
                    label: "游ゴシック".into(),
                    monospace: false,
                },
            ]
        );
    }
}
