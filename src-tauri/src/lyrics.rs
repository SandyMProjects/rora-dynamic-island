// lyrics.rs — Lirik lewat lrclib.net (API publik, tanpa login).
// Urutan fallback yang sudah disepakati:
//   1. syncedLyrics (LRC) -> frontend menyorot per baris
//   2. plainLyrics -> frontend tampil teks scroll
//   3. tidak ada / instrumental -> frontend tampil pesan jelas, TIDAK dikarang.
// Hasil sukses di-cache lokal di app_data_dir/lyrics-cache/ supaya pemutaran
// berikutnya tidak perlu internet lagi. Hasil "tidak ditemukan" tidak di-cache.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsResult {
    pub kind: String, // "synced" | "plain" | "not_found" | "instrumental"
    pub synced_lrc: Option<String>,
    pub plain: Option<String>,
    pub from_cache: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct LrclibTrack {
    #[serde(rename = "trackName")]
    track_name: Option<String>,
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    duration: Option<f64>,
    instrumental: Option<bool>,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn cache_path(app: &tauri::AppHandle, title: &str, artist: &str, duration_secs: f64) -> Option<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("lyrics-cache");
    let _ = std::fs::create_dir_all(&dir);
    let name = format!(
        "{}_{}_{}.json",
        sanitize(title),
        sanitize(artist),
        duration_secs as i64
    );
    Some(dir.join(name))
}

fn to_result(track: &LrclibTrack, from_cache: bool) -> LyricsResult {
    let synced = track.synced_lyrics.clone().filter(|v| !v.trim().is_empty());
    let plain = track.plain_lyrics.clone().filter(|v| !v.trim().is_empty());
    if track.instrumental.unwrap_or(false) && synced.is_none() && plain.is_none() {
        return LyricsResult {
            kind: "instrumental".to_string(),
            synced_lrc: None,
            plain: None,
            from_cache,
        };
    }
    if synced.is_some() {
        LyricsResult {
            kind: "synced".to_string(),
            synced_lrc: synced,
            plain,
            from_cache,
        }
    } else if plain.is_some() {
        LyricsResult {
            kind: "plain".to_string(),
            synced_lrc: None,
            plain,
            from_cache,
        }
    } else {
        LyricsResult {
            kind: "not_found".to_string(),
            synced_lrc: None,
            plain: None,
            from_cache,
        }
    }
}

pub async fn get_lyrics(
    app: &tauri::AppHandle,
    title: &str,
    artist: &str,
    duration_secs: f64,
) -> LyricsResult {
    // 1. Cache dulu.
    if let Some(path) = cache_path(app, title, artist, duration_secs) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cached) = serde_json::from_str::<LyricsResult>(&text) {
                if cached.kind == "synced" || cached.kind == "plain" {
                    return LyricsResult { from_cache: true, ..cached };
                }
            }
        }
    }

    let client = match reqwest::Client::builder()
        .user_agent("RORA-Island/0.1")
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return LyricsResult {
                kind: "not_found".to_string(),
                synced_lrc: None,
                plain: None,
                from_cache: false,
            }
        }
    };

    // 2. Cocok persis: /api/get?track_name=&artist_name=&duration=
    // (durasi dibulatkan ke detik, sesuai API lrclib).
    let mut found: Option<LrclibTrack> = None;
    let get_url = "https://lrclib.net/api/get";
    if let Ok(resp) = client
        .get(get_url)
        .query(&[
            ("track_name", title),
            ("artist_name", artist),
            ("duration", &format!("{}", duration_secs as i64)),
        ])
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(track) = resp.json::<LrclibTrack>().await {
                found = Some(track);
            }
        }
    }

    // 3. Fallback pencarian: /api/search?track_name=&artist_name=
    // Ambil hasil pertama yang punya lirik dan durasinya paling dekat.
    if found.is_none() {
        if let Ok(resp) = client
            .get("https://lrclib.net/api/search")
            .query(&[("track_name", title), ("artist_name", artist)])
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(list) = resp.json::<Vec<LrclibTrack>>().await {
                    let mut best: Option<&LrclibTrack> = None;
                    let mut best_diff = f64::MAX;
                    for t in &list {
                        let has = t
                            .synced_lyrics
                            .as_ref()
                            .map(|v| !v.trim().is_empty())
                            .unwrap_or(false)
                            || t.plain_lyrics
                                .as_ref()
                                .map(|v| !v.trim().is_empty())
                                .unwrap_or(false)
                            || t.instrumental.unwrap_or(false);
                        if !has {
                            continue;
                        }
                        let diff = (t.duration.unwrap_or(0.0) - duration_secs).abs();
                        if diff < best_diff {
                            best_diff = diff;
                            best = Some(t);
                        }
                    }
                    if let Some(t) = best {
                        // Clone lewat JSON supaya tidak ribet lifetime.
                        if let Ok(cloned) = serde_json::to_value(t) {
                            if let Ok(parsed) =
                                serde_json::from_value::<LrclibTrack>(cloned)
                            {
                                found = Some(parsed);
                            }
                        }
                    }
                }
            }
        }
    }

    let Some(track) = found else {
        return LyricsResult {
            kind: "not_found".to_string(),
            synced_lrc: None,
            plain: None,
            from_cache: false,
        };
    };

    let result = to_result(&track, false);
    // 4. Cache hanya hasil sukses.
    if result.kind == "synced" || result.kind == "plain" {
        if let Some(path) = cache_path(app, title, artist, duration_secs) {
            let _ = std::fs::write(path, serde_json::to_string(&result).unwrap_or_default());
        }
    }
    result
}
