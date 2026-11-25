// media.rs — Baca & kontrol pemutaran lewat Windows SMTC (System Media Transport Controls).
// Prinsip pasif: kode ini HANYA membaca sesi media sistem dan mengirim perintah media
// standar (play/pause/next/prev), sama seperti tombol media di keyboard.
// Ia TIDAK menyentuh proses game, TIDAK membaca memori game, TIDAK injeksi DLL.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct NowPlaying {
    // `playing` berarti sesi media memiliki item/metadata aktif, bukan status play/pause.
    // Status playback aktual disimpan terpisah pada `is_playing`.
    pub playing: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub source: Option<String>,
    // Posisi dan durasi relatif terhadap StartTime item media.
    pub position_secs: f64,
    pub duration_secs: f64,
    pub is_playing: bool,
    // Timestamp Unix dalam milidetik ketika posisi SMTC terakhir diperbarui.
    // Dipakai frontend untuk mengompensasi umur snapshot sebelum interpolasi.
    pub position_updated_at_ms: f64,
}

impl NowPlaying {
    fn none() -> Self {
        Self {
            playing: false,
            title: None,
            artist: None,
            album: None,
            source: None,
            position_secs: 0.0,
            duration_secs: 0.0,
            is_playing: false,
            position_updated_at_ms: 0.0,
        }
    }
}

// ---------------- Windows: implementasi SMTC asli ----------------
#[cfg(windows)]
mod windows_impl {
    use super::NowPlaying;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    const WINDOWS_EPOCH_TO_UNIX_TICKS: i64 = 116_444_736_000_000_000;

    fn secs_from_timespan(v: i64) -> f64 {
        // TimeSpan.Duration memakai satuan 100-nanodetik.
        (v as f64) / 10_000_000.0
    }

    fn is_spotify_session(session: &GlobalSystemMediaTransportControlsSession) -> bool {
        session
            .SourceAppUserModelId()
            .ok()
            .map(|id| id.to_string().to_ascii_lowercase().contains("spotify"))
            .unwrap_or(false)
    }

    fn session_is_playing(session: &GlobalSystemMediaTransportControlsSession) -> bool {
        session
            .GetPlaybackInfo()
            .ok()
            .and_then(|info| info.PlaybackStatus().ok())
            .map(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
            .unwrap_or(false)
    }

    // RORA hanya memilih sesi Spotify. GetCurrentSession() memilih aplikasi
    // yang dianggap Windows paling relevan (misalnya Chrome/Netflix), sehingga
    // kita enumerasi semua SMTC sessions dan memfilter SourceAppUserModelId.
    async fn current_session() -> Option<GlobalSystemMediaTransportControlsSession> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()?
            .get()
            .ok()?;
        let sessions = manager.GetSessions().ok()?;
        let count = sessions.Size().ok()?;
        let mut paused_spotify: Option<GlobalSystemMediaTransportControlsSession> = None;

        for index in 0..count {
            let Ok(session) = sessions.GetAt(index) else { continue };
            if !is_spotify_session(&session) {
                continue;
            }

            // Prioritaskan Spotify yang sedang memutar musik. Bila sedang pause,
            // simpan sesi pertama supaya tampilan paused tetap mempertahankan lagu.
            if session_is_playing(&session) {
                return Some(session);
            }
            if paused_spotify.is_none() {
                paused_spotify = Some(session);
            }
        }

        paused_spotify
    }

    pub async fn get_now_playing() -> NowPlaying {
        let Some(session) = current_session().await else {
            return NowPlaying::none();
        };
        let Ok(props) = session.TryGetMediaPropertiesAsync() else {
            return NowPlaying::none();
        };
        let Ok(props) = props.get() else {
            return NowPlaying::none();
        };

        let title = props.Title().ok().map(|v| v.to_string()).filter(|v| !v.is_empty());
        let artist = props.Artist().ok().map(|v| v.to_string()).filter(|v| !v.is_empty());
        let album = props.AlbumTitle().ok().map(|v| v.to_string()).filter(|v| !v.is_empty());
        if title.is_none() && artist.is_none() {
            return NowPlaying::none();
        }

        let source = session
            .SourceAppUserModelId()
            .ok()
            .map(|v| v.to_string())
            .filter(|v| !v.is_empty());

        let mut is_playing = false;
        if let Ok(info) = session.GetPlaybackInfo() {
            if let Ok(status) = info.PlaybackStatus() {
                is_playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
            }
        }

        let mut position_secs = 0.0;
        let mut duration_secs = 0.0;
        let mut position_updated_at_ms = 0.0;
        if let Ok(timeline) = session.GetTimelineProperties() {
            // StartTime dan EndTime adalah timestamp timeline, bukan selalu durasi.
            // Durasi serta posisi UI harus dihitung relatif terhadap StartTime.
            let mut start_secs = 0.0;
            if let Ok(start) = timeline.StartTime() {
                start_secs = secs_from_timespan(start.Duration);
            }

            let mut end_secs = 0.0;
            if let Ok(end) = timeline.EndTime() {
                end_secs = secs_from_timespan(end.Duration);
            }

            let mut raw_position_secs = start_secs;
            if let Ok(pos) = timeline.Position() {
                raw_position_secs = secs_from_timespan(pos.Duration);
            }

            duration_secs = (end_secs - start_secs).max(0.0);
            position_secs = (raw_position_secs - start_secs).max(0.0);
            if duration_secs > 0.0 {
                position_secs = position_secs.min(duration_secs);
            }

            // DateTime.UniversalTime adalah 100-ns ticks sejak 1601-01-01 UTC.
            // Ubah menjadi Unix milliseconds untuk perhitungan umur snapshot di JS.
            if let Ok(updated) = timeline.LastUpdatedTime() {
                let unix_ticks = updated.UniversalTime - WINDOWS_EPOCH_TO_UNIX_TICKS;
                if unix_ticks > 0 {
                    position_updated_at_ms = unix_ticks as f64 / 10_000.0;
                }
            }
        }

        NowPlaying {
            // Item media/session ada walaupun playback sedang pause.
            playing: true,
            title,
            artist,
            album,
            source,
            position_secs,
            duration_secs,
            is_playing,
            position_updated_at_ms,
        }
    }

    pub async fn toggle() -> bool {
        let Some(session) = current_session().await else {
            return false;
        };
        match session.TryTogglePlayPauseAsync() {
            Ok(op) => op.get().is_ok(),
            Err(_) => false,
        }
    }

    pub async fn next() -> bool {
        let Some(session) = current_session().await else {
            return false;
        };
        match session.TrySkipNextAsync() {
            Ok(op) => op.get().is_ok(),
            Err(_) => false,
        }
    }

    pub async fn prev() -> bool {
        let Some(session) = current_session().await else {
            return false;
        };
        match session.TrySkipPreviousAsync() {
            Ok(op) => op.get().is_ok(),
            Err(_) => false,
        }
    }
}

// Re-ekspor Windows di bawah cfg(windows) saja.
#[cfg(windows)]
pub use windows_impl::{get_now_playing, next, prev, toggle};

// ---------------- Non-Windows: stub jujur ----------------
#[cfg(not(windows))]
pub async fn get_now_playing() -> NowPlaying {
    // Bukan Windows = tidak ada SMTC. Frontend akan menampilkan
    // "Tidak ada lagu yang diputar", bukan data palsu.
    NowPlaying::none()
}

#[cfg(not(windows))]
pub async fn toggle() -> bool {
    false
}

#[cfg(not(windows))]
pub async fn next() -> bool {
    false
}

#[cfg(not(windows))]
pub async fn prev() -> bool {
    false
}
