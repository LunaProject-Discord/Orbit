//! 画面の自動更新 (docs/app-update.md)。
//!
//! 画面 (apps/web の静的出力) は、ふだんはアプリに同梱したものを配信する。サーバーに新しい画面が
//! 配置されると、画面側 (apps/web/src/lib/app-update) が一覧の署名を確かめ、このモジュールに
//! ファイルの取得を頼む。取得したファイルは <アプリのデータフォルダ>/web-bundle/<版>/ に置き、
//! 次に起動したときからそこを配信する。配信の URL (tauri://localhost / http://tauri.localhost) は
//! 変わらないので、ログインの状態や IndexedDB はそのまま使える。
//!
//! 新しい版で起動して、画面から「問題なく起動した」(app_update_ready) と伝えられないまま終わったら、
//! 次に起動したときはその版を使わずに前の版へ戻す。アプリ本体の版が変わったら、取得した画面は消す
//! (新しいアプリには新しい画面が同梱されている)。

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{App, AppHandle, Assets, Manager, Runtime, State};

/// アプリ側の機能の版。画面から使うコマンドを足したら 1 増やし、
/// apps/web/app-update.json の minNativeApi も合わせる。
pub const NATIVE_API: u32 = 2;

/// 一覧の署名を確かめる公開鍵 (Ed25519、32 バイトの Base64)。ビルド時に渡す。
/// 無いビルドでは画面を更新しない。
const PUBLIC_KEY: Option<&str> = option_env!("ORBIT_APP_UPDATE_PUBLIC_KEY");

const STATE_FILE: &str = "state.json";
const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// 取得した画面の記録 (web-bundle/state.json)。
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BundleState {
    /// この記録を作ったアプリ本体の版。
    native: String,
    /// 問題なく起動できた版。
    current: Option<String>,
    /// 取得済みで、次に起動したときに使う版。
    pending: Option<String>,
    /// いま試している版 (起動したが、まだ問題なく起動したと伝えられていない)。
    trying: Option<String>,
    /// 起動できなかった版。もう取得しない。
    bad: Vec<String>,
}

/// 起動するときに、どの版を配信するか決める。None は同梱の画面。
fn select(state: &mut BundleState, native: &str, exists: impl Fn(&str) -> bool) -> Option<String> {
    if state.native != native {
        *state = BundleState {
            native: native.to_owned(),
            ..Default::default()
        };
        return None;
    }
    // 前回試した版が、問題なく起動したと伝えられないまま終わった。
    if let Some(failed) = state.trying.take() {
        if !state.bad.contains(&failed) {
            state.bad.push(failed);
        }
    }
    if let Some(next) = state.pending.take() {
        if exists(&next) {
            state.trying = Some(next.clone());
            return Some(next);
        }
    }
    match state.current.clone() {
        Some(current) if exists(&current) => Some(current),
        _ => {
            state.current = None;
            None
        }
    }
}

fn is_version(value: &str) -> bool {
    value.len() == 14 && value.bytes().all(|b| b.is_ascii_digit())
}

/// 一覧のパス ("/" で始まり、"." や ".." を含まない) を、フォルダの中の相対パスにする。
fn relative_path(path: &str) -> Option<PathBuf> {
    let rest = path.strip_prefix('/')?;
    if rest.is_empty() || path.len() > 512 {
        return None;
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._-/@+~%()[]".contains(c);
    if !rest.chars().all(allowed) {
        return None;
    }
    let mut relative = PathBuf::new();
    for part in rest.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        relative.push(part);
    }
    Some(relative)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// アプリの中で共有する、画面の更新の状態。
pub struct WebBundles {
    root: PathBuf,
    native: String,
    /// この起動で配信している版。None は同梱の画面。
    serving: Option<String>,
    state: Mutex<BundleState>,
    downloading: AtomicBool,
}

impl WebBundles {
    fn dir(&self, version: &str) -> PathBuf {
        self.root.join(version)
    }

    fn save(&self, state: &BundleState) -> Result<(), String> {
        let text = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
        let temp = self.root.join(format!("{STATE_FILE}.tmp"));
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        std::fs::write(&temp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, self.root.join(STATE_FILE)).map_err(|e| e.to_string())
    }

    /// 記録に無い版のフォルダ (古い版、取得の途中で止まったもの) を消す。
    fn clean(&self, state: &BundleState) {
        let keep: HashSet<&str> = [
            state.current.as_deref(),
            state.pending.as_deref(),
            state.trying.as_deref(),
            self.serving.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_dir() && !keep.contains(name.as_str()) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn load_state(root: &Path) -> BundleState {
    std::fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 同梱の画面 (generate_context! が埋め込んだもの) を包み、取得した版があればそちらを配信する。
pub struct OverlayAssets<R: Runtime> {
    embedded: Box<dyn Assets<R>>,
    serving: OnceLock<Option<PathBuf>>,
}

impl<R: Runtime> OverlayAssets<R> {
    pub fn new(embedded: Box<dyn Assets<R>>) -> Self {
        Self {
            embedded,
            serving: OnceLock::new(),
        }
    }
}

impl<R: Runtime> Assets<R> for OverlayAssets<R> {
    fn setup(&self, app: &App<R>) {
        let root = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("web-bundle"))
            .unwrap_or_else(|_| PathBuf::from("web-bundle"));
        let native = app.package_info().version.to_string();
        let mut state = load_state(&root);
        let serving = select(&mut state, &native, |version| {
            is_version(version) && root.join(version).join("index.html").is_file()
        });
        let bundles = WebBundles {
            root,
            native,
            serving: serving.clone(),
            state: Mutex::new(BundleState::default()),
            downloading: AtomicBool::new(false),
        };
        let _ = bundles.save(&state);
        bundles.clean(&state);
        *bundles.state.lock().expect("state") = state;
        let _ = self
            .serving
            .set(serving.map(|version| bundles.dir(&version)));
        app.manage(bundles);
        self.embedded.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match self.serving.get() {
            // 取得した版を使うときは、同梱の画面と混ぜない (版の違うファイルが混ざると壊れる)。
            Some(Some(root)) => {
                let relative = relative_path(key.as_ref())?;
                std::fs::read(root.join(relative)).ok().map(Cow::Owned)
            }
            _ => self.embedded.get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

/// 同梱の画面を取り出すあいだだけ入れておく、中身の無い置き場。
pub struct Empty;

impl<R: Runtime> Assets<R> for Empty {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

// ---- 画面から呼ぶコマンド ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    native_version: String,
    native_api: u32,
    public_key: Option<String>,
    running: Option<String>,
    pending: Option<String>,
}

#[tauri::command]
pub fn app_update_info(bundles: State<'_, WebBundles>) -> Result<UpdateInfo, String> {
    let state = bundles.state.lock().map_err(|e| e.to_string())?;
    Ok(UpdateInfo {
        native_version: bundles.native.clone(),
        native_api: NATIVE_API,
        public_key: PUBLIC_KEY
            .filter(|key| !key.trim().is_empty())
            .map(str::to_owned),
        running: bundles.serving.clone(),
        pending: state.pending.clone(),
    })
}

/// 取得してよい URL か。https だけ (同じ端末での確認用に、localhost の http は許す)。
fn allowed_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "URL の形が正しくありません。".to_owned())?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if local => Ok(parsed),
        _ => Err("https の URL だけを使えます。".to_owned()),
    }
}

/// 一覧のファイルの URL。base (末尾は /) からの相対で組み立てる
/// (パスは "/" で始まるので、そのまま join するとサーバーの直下を指してしまう)。
fn file_url(base: &reqwest::Url, path: &str) -> Result<reqwest::Url, String> {
    let mut base = base.clone();
    if !base.path().ends_with('/') {
        let with_slash = format!("{}/", base.path());
        base.set_path(&with_slash);
    }
    base.join(path.trim_start_matches('/'))
        .map_err(|e| e.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch(client: &reqwest::Client, url: reqwest::Url, limit: u64) -> Result<Vec<u8>, String> {
    let response = client
        .get(url.clone())
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!("{url}: 大きすぎます"));
    }
    let bytes = response.bytes().await.map_err(|e| format!("{url}: {e}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{url}: 大きすぎます"));
    }
    Ok(bytes.to_vec())
}

#[tauri::command]
pub async fn app_update_fetch_manifest(url: String) -> Result<String, String> {
    let url = allowed_url(&url)?;
    let bytes = fetch(&client()?, url, MAX_MANIFEST_BYTES as u64).await?;
    String::from_utf8(bytes).map_err(|_| "一覧を読み取れませんでした。".to_owned())
}

#[derive(Deserialize)]
pub struct BundleFile {
    path: String,
    sha256: String,
    size: u64,
}

struct DownloadGuard<'a>(&'a AtomicBool);

impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 一覧のファイルを用意する。中身が同じファイルは、いま配信している画面 (同梱、または取得済み) から
/// 写し、変わったものだけをサーバーから取得する。すべて SHA-256 を確かめる。
#[tauri::command]
pub async fn app_update_download<R: Runtime>(
    app: AppHandle<R>,
    bundles: State<'_, WebBundles>,
    version: String,
    base_url: String,
    files: Vec<BundleFile>,
) -> Result<(), String> {
    if !is_version(&version) {
        return Err("版の形が正しくありません。".to_owned());
    }
    {
        let state = bundles.state.lock().map_err(|e| e.to_string())?;
        if state.bad.contains(&version) {
            return Err("この版は前に起動できなかったので使いません。".to_owned());
        }
        if state.pending.as_deref() == Some(version.as_str()) {
            return Ok(());
        }
    }
    let base = allowed_url(&base_url)?;
    if bundles.downloading.swap(true, Ordering::SeqCst) {
        return Err("ほかの取得が進んでいます。".to_owned());
    }
    let _guard = DownloadGuard(&bundles.downloading);

    let temp = bundles.root.join(format!(".tmp-{version}"));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let result = async {
        let client = client()?;
        let resolver = app.asset_resolver();
        let mut has_index = false;
        for file in &files {
            let relative = relative_path(&file.path)
                .ok_or_else(|| format!("{}: パスが正しくありません", file.path))?;
            if file.size > MAX_FILE_BYTES || file.sha256.len() != 64 {
                return Err(format!("{}: 一覧の内容が正しくありません", file.path));
            }
            has_index |= file.path == "/index.html";
            let reused = resolver
                .get(file.path.clone())
                .map(|asset| asset.bytes)
                .filter(|bytes| sha256_hex(bytes) == file.sha256);
            let bytes = match reused {
                Some(bytes) => bytes,
                None => {
                    let url = file_url(&base, &file.path)?;
                    let bytes = fetch(&client, url, MAX_FILE_BYTES).await?;
                    if sha256_hex(&bytes) != file.sha256 {
                        return Err(format!("{}: 内容が一覧と一致しません", file.path));
                    }
                    bytes
                }
            };
            let target = temp.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
        }
        if !has_index {
            return Err("一覧に index.html がありません。".to_owned());
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }

    let target = bundles.dir(&version);
    if bundles.serving.as_deref() != Some(version.as_str()) {
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    } else {
        let _ = std::fs::remove_dir_all(&temp);
    }
    let mut state = bundles.state.lock().map_err(|e| e.to_string())?;
    state.pending = Some(version);
    bundles.save(&state)?;
    bundles.clean(&state);
    Ok(())
}

/// 画面が問題なく起動した。試している版なら、これからはその版を使う。
#[tauri::command]
pub fn app_update_ready(bundles: State<'_, WebBundles>) -> Result<(), String> {
    let mut state = bundles.state.lock().map_err(|e| e.to_string())?;
    if state.trying.is_some() && state.trying == bundles.serving {
        state.current = state.trying.take();
        bundles.save(&state)?;
        bundles.clean(&state);
    }
    Ok(())
}

/// 取得済みの版に切り替えるため、アプリを再起動する。
#[tauri::command]
pub fn app_update_apply<R: Runtime>(
    app: AppHandle<R>,
    bundles: State<'_, WebBundles>,
) -> Result<(), String> {
    let pending = bundles
        .state
        .lock()
        .map_err(|e| e.to_string())?
        .pending
        .is_some();
    if !pending {
        return Err("切り替える版がありません。".to_owned());
    }
    app.restart();
}

/// 取得した画面を消し、次に起動したときから同梱の画面を使う。
#[tauri::command]
pub fn app_update_reset(bundles: State<'_, WebBundles>) -> Result<(), String> {
    let mut state = bundles.state.lock().map_err(|e| e.to_string())?;
    state.current = None;
    state.pending = None;
    state.trying = None;
    bundles.save(&state)?;
    bundles.clean(&state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(native: &str) -> BundleState {
        BundleState {
            native: native.to_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn 取得済みの版を試し_問題なければ使い続ける() {
        let mut s = state("0.1.0");
        s.pending = Some("20261125000000".into());
        assert_eq!(
            select(&mut s, "0.1.0", |_| true).as_deref(),
            Some("20261125000000")
        );
        assert_eq!(s.trying.as_deref(), Some("20261125000000"));
        assert_eq!(s.pending, None);
        // 問題なく起動した (app_update_ready) あとは current になる。
        s.current = s.trying.take();
        assert_eq!(
            select(&mut s, "0.1.0", |_| true).as_deref(),
            Some("20261125000000")
        );
    }

    #[test]
    fn 起動できなかった版は使わず_前の版に戻す() {
        let mut s = state("0.1.0");
        s.current = Some("20261124000000".into());
        s.trying = Some("20261125000000".into());
        assert_eq!(
            select(&mut s, "0.1.0", |_| true).as_deref(),
            Some("20261124000000")
        );
        assert_eq!(s.bad, vec!["20261125000000".to_owned()]);
        assert_eq!(s.trying, None);
    }

    #[test]
    fn アプリ本体の版が変わったら同梱の画面に戻す() {
        let mut s = state("0.1.0");
        s.current = Some("20261124000000".into());
        assert_eq!(select(&mut s, "0.2.0", |_| true), None);
        assert_eq!(s, state("0.2.0"));
    }

    #[test]
    fn フォルダが無い版は使わない() {
        let mut s = state("0.1.0");
        s.current = Some("20261124000000".into());
        s.pending = Some("20261125000000".into());
        assert_eq!(select(&mut s, "0.1.0", |_| false), None);
        assert_eq!(s.current, None);
    }

    #[test]
    fn フォルダの外を指すパスは使わない() {
        assert_eq!(
            relative_path("/index.html"),
            Some(PathBuf::from("index.html"))
        );
        assert_eq!(
            relative_path("/_next/static/a.js"),
            Some(["_next", "static", "a.js"].iter().collect())
        );
        assert_eq!(relative_path("index.html"), None);
        assert_eq!(relative_path("/../a"), None);
        assert_eq!(relative_path("/a//b"), None);
        assert_eq!(relative_path("/a\\b"), None);
        assert_eq!(relative_path("/C:/a"), None);
    }

    #[test]
    fn ファイルの_url_は取得元の下に組み立てる() {
        let base = reqwest::Url::parse("https://orbit.example.com/app-update/files/").unwrap();
        assert_eq!(
            file_url(&base, "/_next/static/a.js").unwrap().as_str(),
            "https://orbit.example.com/app-update/files/_next/static/a.js"
        );
        let no_slash = reqwest::Url::parse("https://orbit.example.com/app-update/files").unwrap();
        assert_eq!(
            file_url(&no_slash, "/index.html").unwrap().as_str(),
            "https://orbit.example.com/app-update/files/index.html"
        );
    }

    #[test]
    fn 版の形() {
        assert!(is_version("20261125000000"));
        assert!(!is_version("2026112500000"));
        assert!(!is_version("../../../etc"));
    }
}
