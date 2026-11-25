// RORA Bridge — server localhost untuk menghubungkan RORA Island (Tauri)
// dengan extension Spicetify di Spotify desktop.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct BridgeCommand {
    pub id: String,
    pub action: String,
}

#[derive(Clone, Debug)]
pub struct BridgeResult {
    pub id: String,
    pub message: String,
}

#[derive(Clone, Debug, Default)]
pub struct ProgressPush {
    pub position_ms: f64,
    pub duration_ms: f64,
    pub is_playing: bool,
    pub received_at_ms: u128,
}

#[derive(Clone, Debug)]
pub struct VolumeState {
    pub level: f64, // 0.0 .. 1.0
    #[allow(dead_code)]
    pub updated_at_ms: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaylistItem {
    pub uri: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackPlaylistState {
    pub track_uri: String,
    pub track_title: String,
    pub playlist_uri: String,
    pub playlist_name: String,
    pub state: String, // "in" | "out" | "idle" | "error"
    pub reason: String,
    pub updated_at_ms: u128,
}

#[derive(Clone, Default)]
pub struct BridgeState {
    pub pending: Arc<Mutex<Option<BridgeCommand>>>,
    pub result: Arc<Mutex<Option<BridgeResult>>>,
    pub progress: Arc<Mutex<Option<ProgressPush>>>,
    pub pending_volume: Arc<Mutex<Option<f64>>>,
    pub spotify_volume: Arc<Mutex<Option<VolumeState>>>,
    pub playlists: Arc<Mutex<Vec<PlaylistItem>>>,
    pub active_playlist: Arc<Mutex<Option<PlaylistItem>>>,
    pub track_state: Arc<Mutex<Option<TrackPlaylistState>>>,
    pub last_seen_ms: Arc<Mutex<u128>>,
}

impl BridgeState {
    pub fn touch_spicetify(&self) {
        *self.last_seen_ms.lock().unwrap() = now_ms();
    }

    pub fn is_spicetify_connected(&self) -> bool {
        let last = *self.last_seen_ms.lock().unwrap();
        last > 0 && now_ms().saturating_sub(last) < 90_000
    }

    pub fn send_add(&self) -> String {
        let c = COUNTER.fetch_add(1, Ordering::SeqCst);
        let id = format!("rora-{}-{}", now_ms(), c);
        *self.pending.lock().unwrap() = Some(BridgeCommand {
            id: id.clone(),
            action: "add".to_string(),
        });
        *self.result.lock().unwrap() = None;
        id
    }

    pub fn send_check(&self) -> String {
        let c = COUNTER.fetch_add(1, Ordering::SeqCst);
        let id = format!("rora-{}-{}", now_ms(), c);
        *self.pending.lock().unwrap() = Some(BridgeCommand {
            id: id.clone(),
            action: "check".to_string(),
        });
        *self.result.lock().unwrap() = None;
        id
    }

    pub fn set_volume(&self, level: f64) {
        let clamped = level.clamp(0.0, 1.0);
        *self.pending_volume.lock().unwrap() = Some(clamped);
        *self.spotify_volume.lock().unwrap() = Some(VolumeState {
            level: clamped,
            updated_at_ms: now_ms(),
        });
    }

    pub fn get_volume(&self) -> Option<f64> {
        self.spotify_volume.lock().unwrap().as_ref().map(|v| v.level)
    }

    pub fn set_target_playlist(&self, uri: String, name: String) {
        if uri.trim().is_empty() {
            return;
        }
        *self.active_playlist.lock().unwrap() = Some(PlaylistItem { uri, name });
        // Bersihkan status track lama agar UI tidak menampilkan status dari playlist sebelumnya
        *self.track_state.lock().unwrap() = None;
    }

    pub fn get_playlists_snapshot(&self) -> (Vec<PlaylistItem>, Option<PlaylistItem>) {
        let list = self.playlists.lock().unwrap().clone();
        let active = self.active_playlist.lock().unwrap().clone();
        (list, active)
    }

    pub fn get_track_state_snapshot(&self) -> (Option<TrackPlaylistState>, bool) {
        let st = self.track_state.lock().unwrap().clone();
        let connected = self.is_spicetify_connected();
        (st, connected)
    }

    /// Tunggu hasil extension, maksimal `timeout`.
    pub fn wait_for_result(&self, id: &str, timeout: Duration) -> Option<String> {
        let step = Duration::from_millis(200);
        let mut waited = Duration::from_secs(0);
        while waited < timeout {
            if let Some(r) = self.result.lock().unwrap().clone() {
                if r.id == id {
                    return Some(r.message);
                }
            }
            thread::sleep(step);
            waited += step;
        }
        None
    }
}

fn json_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body
    )
}

fn handle_connection(mut stream: std::net::TcpStream, state: BridgeState) {
    let mut buf = vec![0u8; 65536];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    if n == 0 {
        return;
    }
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let mut lines = req.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("");
    let path = raw_path.split('?').next().unwrap_or("");
    let query = raw_path.split('?').nth(1).unwrap_or("");

    let body = req.split("\r\n\r\n").nth(1).unwrap_or("").to_string();

    if method == "OPTIONS" {
        let _ = stream.write_all(json_response("204 No Content", "").as_bytes());
        return;
    }

    if method == "GET" && path == "/rora-command" {
        state.touch_spicetify();

        for param in query.split('&') {
            if let Some(val_str) = param.strip_prefix("vol=") {
                if let Ok(v) = val_str.parse::<f64>() {
                    if state.pending_volume.lock().unwrap().is_none() {
                        *state.spotify_volume.lock().unwrap() = Some(VolumeState {
                            level: v.clamp(0.0, 1.0),
                            updated_at_ms: now_ms(),
                        });
                    }
                }
            }
        }

        let pending = state.pending.lock().unwrap().clone();
        let vol_cmd = state.pending_volume.lock().unwrap().take();
        let need_playlists = state.playlists.lock().unwrap().is_empty();
        let active_pl = state.active_playlist.lock().unwrap().clone();

        let mut resp_obj = match pending {
            Some(cmd) => serde_json::json!({"id": cmd.id, "action": cmd.action}),
            None => serde_json::json!({"id": null, "action": "none"}),
        };
        if let Some(v) = vol_cmd {
            resp_obj["volume"] = serde_json::json!(v);
        }
        if need_playlists {
            resp_obj["need_playlists"] = serde_json::json!(true);
        }
        if let Some(pl) = active_pl {
            resp_obj["target_playlist"] = serde_json::json!(pl);
        }

        let body = resp_obj.to_string();
        let _ = stream.write_all(json_response("200 OK", &body).as_bytes());
        return;
    }

    if method == "POST" && path == "/rora-track-state" {
        state.touch_spicetify();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let track_uri = parsed.get("track_uri").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let track_title = parsed.get("track_title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let playlist_uri = parsed.get("playlist_uri").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let playlist_name = parsed.get("playlist_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let status_str = parsed.get("state").and_then(|v| v.as_str()).unwrap_or("error").to_string();
        let reason = parsed.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();

        *state.track_state.lock().unwrap() = Some(TrackPlaylistState {
            track_uri,
            track_title,
            playlist_uri,
            playlist_name,
            state: status_str,
            reason,
            updated_at_ms: now_ms(),
        });

        let _ = stream.write_all(json_response("200 OK", "{\"ok\":true}").as_bytes());
        return;
    }

    if method == "POST" && path == "/rora-playlists" {
        state.touch_spicetify();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        if let Some(arr) = parsed.get("playlists").and_then(|v| v.as_array()) {
            let mut list = Vec::new();
            for item in arr {
                let uri = item.get("uri").and_then(|v| v.as_str()).unwrap_or("").trim();
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
                if !uri.is_empty() && !name.is_empty() {
                    list.push(PlaylistItem {
                        uri: uri.to_string(),
                        name: name.to_string(),
                    });
                }
            }
            if !list.is_empty() {
                let mut active_guard = state.active_playlist.lock().unwrap();
                if active_guard.is_none() {
                    let active_uri = parsed.get("active_uri").and_then(|v| v.as_str()).unwrap_or("");
                    let chosen = list
                        .iter()
                        .find(|p| p.uri == active_uri)
                        .cloned()
                        .unwrap_or_else(|| list[0].clone());
                    *active_guard = Some(chosen);
                }
                *state.playlists.lock().unwrap() = list;
            }
        }
        let _ = stream.write_all(json_response("200 OK", "{\"ok\":true}").as_bytes());
        return;
    }

    if method == "POST" && path == "/rora-result" {
        state.touch_spicetify();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let message = parsed
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !id.is_empty() {
            let matches = state
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|c| c.id == id)
                .unwrap_or(false);
            if matches {
                *state.pending.lock().unwrap() = None;
            }
            *state.result.lock().unwrap() = Some(BridgeResult { id, message });
        }
        let _ = stream.write_all(json_response("200 OK", "{\"ok\":true}").as_bytes());
        return;
    }

    if method == "POST" && path == "/rora-progress" {
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let push = ProgressPush {
            position_ms: parsed.get("position_ms").and_then(|v| v.as_f64()).unwrap_or(0.0),
            duration_ms: parsed.get("duration_ms").and_then(|v| v.as_f64()).unwrap_or(0.0),
            is_playing: parsed.get("is_playing").and_then(|v| v.as_bool()).unwrap_or(false),
            received_at_ms: now_ms(),
        };
        *state.progress.lock().unwrap() = Some(push);
        let _ = stream.write_all(json_response("200 OK", "{\"ok\":true}").as_bytes());
        return;
    }

    if method == "GET" && path == "/callback" {
        let code = raw_path
            .split("code=")
            .nth(1)
            .unwrap_or("")
            .split('&')
            .next()
            .unwrap_or("")
            .to_string();
        let html = format!(
            "<html><body><h2>RORA Island</h2><p>Salin code ini ke aplikasi RORA, lalu klik Selesaikan Login:</p><code>{}</code></body></html>",
            code
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    let _ = stream.write_all(json_response("404 Not Found", "{\"ok\":false}").as_bytes());
}

pub fn start_server(state: BridgeState) {
    thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:8899") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[RORA Bridge] Port 8899 tidak bisa dibuka: {}", e);
                return;
            }
        };
        eprintln!("[RORA Bridge] Mendengarkan di http://127.0.0.1:8899");
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    let st = state.clone();
                    thread::spawn(move || handle_connection(s, st));
                }
                Err(_) => continue,
            }
        }
    });
}