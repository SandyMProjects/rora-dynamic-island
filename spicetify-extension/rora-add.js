// rora-add.js — RORA Island / Spicetify
// v0.7: push status lagu otomatis (songchange), paginasi playlist besar,
// normalisasi URI playlist, jalur check/add terpisah, dan kontrol volume Spotify.

(function roraAdd() {
    // ===== KONFIGURASI DEFAULT (FALLBACK) =====
    const DEFAULT_PLAYLIST_NAME = "My Playlist";
    const DEFAULT_PLAYLIST_ID = "";

    const ENABLE_RORA_BRIDGE = true;
    const RORA_BRIDGE_URL = "http://127.0.0.1:8899/rora-command";
    const RORA_RESULT_URL = "http://127.0.0.1:8899/rora-result";
    const RORA_PLAYLISTS_URL = "http://127.0.0.1:8899/rora-playlists";
    const RORA_TRACK_STATE_URL = "http://127.0.0.1:8899/rora-track-state";
    const POLL_MS = 300;
    const STORAGE_KEY = "rora_active_playlist_v1";
    // ==========================================

    if (
        !window.Spicetify ||
        !Spicetify.Player ||
        !Spicetify.Topbar ||
        !Spicetify.CosmosAsync ||
        !Spicetify.Platform
    ) {
        setTimeout(roraAdd, 250);
        return;
    }

    function normalizePlaylistId(value) {
        const input = String(value || "").trim();
        if (!input) return null;

        const uriMatch = input.match(/spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]{22})/);
        if (uriMatch) return uriMatch[1];

        const urlMatch = input.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})/i);
        if (urlMatch) return urlMatch[1];

        const bareMatch = input.match(/^([A-Za-z0-9]{22})(?:[?#].*)?$/);
        if (bareMatch) return bareMatch[1];

        return null;
    }

    function normalizePlaylistUri(value) {
        const id = normalizePlaylistId(value);
        return id ? "spotify:playlist:" + id : null;
    }

    function getDefaultPlaylist() {
        const id = normalizePlaylistId(DEFAULT_PLAYLIST_ID);
        if (!id) return null;
        return {
            id,
            uri: "spotify:playlist:" + id,
            name: DEFAULT_PLAYLIST_NAME || "My Playlist"
        };
    }

    function loadInitialPlaylist() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            if (saved && saved.uri) {
                const uri = normalizePlaylistUri(saved.uri);
                const id = normalizePlaylistId(saved.uri);
                if (uri && id) {
                    return { id, uri, name: saved.name || "My Playlist" };
                }
            }
        } catch (_) {}
        return getDefaultPlaylist();
    }

    let activePlaylist = loadInitialPlaylist();
    let addBusy = false;
    let checkSeq = 0;
    let lastCommandId = null;
    let lastPlaylistSyncAt = 0;
    let lastStatePushAt = 0;
    let playlistSyncInFlight = false;

    // Cache sementara (15 detik) agar cache internal PlaylistAPI Spotify tidak menimpa status lagu yang baru di-add
    const recentlyAdded = new Map();

    function saveActivePlaylist(pl) {
        if (!pl || !pl.uri) return false;
        const uri = normalizePlaylistUri(pl.uri);
        const id = normalizePlaylistId(pl.uri);
        if (!uri || !id) return false;

        const nextName = String(pl.name || "My Playlist").trim() || "My Playlist";
        const changed = !activePlaylist || activePlaylist.uri !== uri || activePlaylist.name !== nextName;
        activePlaylist = { id, uri, name: nextName };

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                uri: activePlaylist.uri,
                name: activePlaylist.name
            }));
        } catch (_) {}

        return changed;
    }

    function notify(message, isError = false) {
        try {
            Spicetify.showNotification(message, isError);
        } catch (e) {
            console.log("[RORA]", message, e || "");
        }
    }

    function currentTrack() {
        const item = Spicetify.Player?.data?.item;
        if (!item) return null;

        const uri = item.uri || item.metadata?.uri || null;
        const name = item.name || item.metadata?.title || "lagu";
        if (!uri) return null;

        return { uri, name };
    }

    function getPlaylistConfig() {
        if (!activePlaylist || !activePlaylist.uri) {
            const fallback = getDefaultPlaylist();
            if (!fallback) {
                throw new Error("Playlist tujuan belum diatur.");
            }
            activePlaylist = fallback;
        }
        return activePlaylist;
    }

    function unwrapResponse(raw) {
        return raw && raw.body ? raw.body : raw;
    }

    function collectPlaylistsFromTree(items, out = []) {
        if (!Array.isArray(items)) return out;
        for (const entry of items) {
            if (!entry) continue;
            if (entry.type === "folder" && Array.isArray(entry.items)) {
                collectPlaylistsFromTree(entry.items, out);
                continue;
            }
            const rawUri = entry.uri || entry.link || "";
            const uri = normalizePlaylistUri(rawUri);
            const name = String(entry.name || "").trim();
            if (uri && name) {
                if (!out.some((p) => p.uri === uri)) {
                    out.push({ uri, name });
                }
            }
        }
        return out;
    }

    async function fetchUserPlaylists() {
        const list = [];
        const fallback = getDefaultPlaylist();
        if (fallback) {
            list.push({ uri: fallback.uri, name: fallback.name });
        }

        try {
            const rootlistAPI = Spicetify.Platform?.RootlistAPI;
            if (rootlistAPI && typeof rootlistAPI.getContents === "function") {
                const raw = await rootlistAPI.getContents();
                const res = unwrapResponse(raw);
                const items = res?.items || (Array.isArray(res) ? res : []);
                collectPlaylistsFromTree(items, list);
            }
        } catch (e) {
            console.warn("[RORA] Gagal membaca RootlistAPI:", e);
        }

        if (activePlaylist && !list.some((p) => p.uri === activePlaylist.uri)) {
            list.unshift({ uri: activePlaylist.uri, name: activePlaylist.name });
        }

        return list;
    }

    async function pushPlaylistsToBridge() {
        if (!ENABLE_RORA_BRIDGE || playlistSyncInFlight) return;
        playlistSyncInFlight = true;
        try {
            const playlists = await fetchUserPlaylists();
            const current = getPlaylistConfig();
            await fetch(RORA_PLAYLISTS_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    playlists,
                    active_uri: current.uri
                })
            });
            lastPlaylistSyncAt = Date.now();
        } catch (_) {
            // Bridge belum aktif
        } finally {
            playlistSyncInFlight = false;
        }
    }

    function extractUrisFromItems(items, uris) {
        if (!Array.isArray(items)) return;
        for (const entry of items) {
            const uri =
                entry?.uri ||
                entry?.item?.uri ||
                entry?.track?.uri ||
                null;
            if (typeof uri === "string" && uri.startsWith("spotify:track:")) {
                uris.push(uri);
            }
        }
    }

    async function fetchPlaylistPage(playlistAPI, playlistUri, offset, limit) {
        try {
            return await playlistAPI.getContents(playlistUri, { offset, limit });
        } catch (_) {
            if (offset === 0) {
                return await playlistAPI.getContents(playlistUri);
            }
            throw _;
        }
    }

    async function getPlaylistTrackUris(playlistUri) {
        const playlistAPI = Spicetify.Platform?.PlaylistAPI;
        if (!playlistAPI || typeof playlistAPI.getContents !== "function") {
            throw new Error(
                "PlaylistAPI.getContents tidak tersedia pada versi Spotify/Spicetify ini."
            );
        }

        const pageSize = 500;
        let raw;
        try {
            raw = await fetchPlaylistPage(playlistAPI, playlistUri, 0, pageSize);
        } catch (error) {
            const detail = (error && error.message) || String(error);
            throw new Error("PlaylistAPI.getContents gagal: " + detail);
        }

        const response = unwrapResponse(raw);
        const items = response?.items;

        if (!Array.isArray(items)) {
            let keys = "tidak ada";
            try {
                keys = Object.keys(response || {}).slice(0, 15).join(", ") || "tidak ada";
            } catch (_) {}
            throw new Error(
                "Respons getContents tidak memiliki items[] (properti: " + keys + ")"
            );
        }

        const uris = [];
        extractUrisFromItems(items, uris);

        // Jika playlist memiliki lebih dari 1 halaman lagu, ambil sisa halamannya
        const total = Number(response?.totalLength ?? response?.unfilteredTotalLength ?? items.length) || items.length;
        if (items.length > 0 && total > items.length) {
            const maxTracks = Math.min(total, 5000);
            for (let offset = items.length; offset < maxTracks; offset += pageSize) {
                try {
                    const nextRaw = await fetchPlaylistPage(playlistAPI, playlistUri, offset, pageSize);
                    const nextRes = unwrapResponse(nextRaw);
                    const nextItems = nextRes?.items;
                    if (!Array.isArray(nextItems) || nextItems.length === 0) break;
                    extractUrisFromItems(nextItems, uris);
                } catch (_) {
                    break;
                }
            }
        }

        return uris;
    }

    async function isInPlaylist(playlistUri, trackUri) {
        const cacheKey = `${playlistUri}|||${trackUri}`;
        const addedAt = recentlyAdded.get(cacheKey);
        if (addedAt && Date.now() - addedAt < 15000) {
            return true;
        }
        const trackUris = await getPlaylistTrackUris(playlistUri);
        const found = trackUris.includes(trackUri);
        if (found) {
            recentlyAdded.delete(cacheKey);
        }
        return found;
    }

    async function evaluateCurrentTrackState() {
        const playlist = getPlaylistConfig();
        const track = currentTrack();
        if (!track) {
            return {
                track_uri: "",
                track_title: "",
                playlist_uri: playlist.uri,
                playlist_name: playlist.name,
                state: "idle",
                reason: "Tidak ada lagu Spotify yang sedang diputar."
            };
        }

        try {
            const exists = await isInPlaylist(playlist.uri, track.uri);
            return {
                track_uri: track.uri,
                track_title: track.name,
                playlist_uri: playlist.uri,
                playlist_name: playlist.name,
                state: exists ? "in" : "out",
                reason: exists
                    ? `'${track.name}' sudah ada di playlist '${playlist.name}'.`
                    : `'${track.name}' belum ada di playlist '${playlist.name}'.`
            };
        } catch (e) {
            const msg = (e && e.message) || String(e);
            return {
                track_uri: track.uri,
                track_title: track.name,
                playlist_uri: playlist.uri,
                playlist_name: playlist.name,
                state: "error",
                reason: msg
            };
        }
    }

    async function pushCurrentTrackState() {
        if (!ENABLE_RORA_BRIDGE) return;
        const seq = ++checkSeq;
        const payload = await evaluateCurrentTrackState();
        // Abaikan hasil jika sudah ada pengecekan yang lebih baru
        if (seq !== checkSeq) return;

        try {
            await fetch(RORA_TRACK_STATE_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            lastStatePushAt = Date.now();
        } catch (_) {
            // Bridge belum aktif
        }
        return payload;
    }

    async function addCurrentToPlaylist() {
        if (addBusy) return "Masih ada proses penambahan lagu yang berjalan. Tunggu sebentar.";
        addBusy = true;

        try {
            const playlist = getPlaylistConfig();
            const track = currentTrack();
            if (!track) return "Tidak ada lagu Spotify yang sedang diputar.";

            const playlistAPI = Spicetify.Platform?.PlaylistAPI;
            if (!playlistAPI || typeof playlistAPI.add !== "function") {
                throw new Error("PlaylistAPI.add tidak tersedia pada versi Spotify/Spicetify ini.");
            }

            const cacheKey = `${playlist.uri}|||${track.uri}`;
            const exists = await isInPlaylist(playlist.uri, track.uri);
            if (exists) {
                recentlyAdded.set(cacheKey, Date.now());
                void pushCurrentTrackState();
                return "Tidak ditambahkan: '" + track.name + "' sudah ada di playlist '" + playlist.name + "'.";
            }

            await playlistAPI.add(playlist.uri, [track.uri], { after: "end" }, { silent: true });
            recentlyAdded.set(cacheKey, Date.now());
            void pushCurrentTrackState();
            return "Berhasil: '" + track.name + "' ditambahkan ke playlist '" + playlist.name + "'.";
        } catch (e) {
            const msg = (e && e.message) || String(e);
            return "Gagal menambahkan lagu: " + msg;
        } finally {
            addBusy = false;
        }
    }

    async function onAddClick() {
        const message = await addCurrentToPlaylist();
        notify(message, message.startsWith("Gagal"));
    }

    async function onCheckClick() {
        const res = await evaluateCurrentTrackState();
        notify(res.reason, res.state === "error");
        void pushCurrentTrackState();
    }

    try {
        const addButton = new Spicetify.Topbar.Button(
            "RORA Tambah",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>',
            onAddClick
        );
        addButton.element.title = "Cek playlist tujuan terlebih dahulu, lalu tambahkan jika belum ada";
    } catch (e) {
        console.error("[RORA] Gagal membuat tombol tambah:", e);
    }

    try {
        const checkButton = new Spicetify.Topbar.Button(
            "RORA Cek",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
            onCheckClick
        );
        checkButton.element.title = "Periksa apakah lagu yang sedang diputar sudah ada di target playlist";
    } catch (e) {
        console.error("[RORA] Gagal membuat tombol cek:", e);
    }

    function readSpotifyVolume() {
        try {
            if (typeof Spicetify.Player.getMute === "function" && Spicetify.Player.getMute()) {
                return 0;
            }
            if (typeof Spicetify.Player.getVolume === "function") {
                const v = Spicetify.Player.getVolume();
                if (typeof v === "number" && isFinite(v)) {
                    return Math.max(0, Math.min(1, v));
                }
            }
        } catch (_) {}
        return null;
    }

    function applySpotifyVolume(targetVol) {
        try {
            const clamped = Math.max(0, Math.min(1, Number(targetVol) || 0));
            if (clamped > 0 && typeof Spicetify.Player.getMute === "function" && Spicetify.Player.getMute()) {
                Spicetify.Player.setMute(false);
            }
            if (typeof Spicetify.Player.setVolume === "function") {
                Spicetify.Player.setVolume(clamped);
            }
        } catch (e) {
            console.warn("[RORA] Gagal mengatur volume Spotify:", e);
        }
    }

    // Event listener langsung dari Spotify saat lagu berganti
    try {
        Spicetify.Player.addEventListener("songchange", () => {
            setTimeout(() => {
                void pushCurrentTrackState();
            }, 120);
        });
    } catch (e) {
        console.warn("[RORA] Gagal mendaftarkan listener songchange:", e);
    }

    async function pollRora() {
        if (!ENABLE_RORA_BRIDGE) return;

        try {
            const curVol = readSpotifyVolume();
            const url = curVol !== null
                ? `${RORA_BRIDGE_URL}?vol=${curVol.toFixed(3)}`
                : RORA_BRIDGE_URL;

            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) return;

            const command = await response.json();
            if (!command) return;

            // Sinkronkan playlist aktif jika diubah dari RORA Island
            if (command.target_playlist && command.target_playlist.uri) {
                const changed = saveActivePlaylist(command.target_playlist);
                if (changed) {
                    void pushCurrentTrackState();
                }
            }

            // Kirim daftar playlist ke bridge jika diminta atau setiap 30 detik
            if (command.need_playlists || Date.now() - lastPlaylistSyncAt > 30000) {
                void pushPlaylistsToBridge();
            }

            // Heartbeat status lagu setiap 15 detik (berguna jika RORA Island baru dibuka ulang)
            if (Date.now() - lastStatePushAt > 15000) {
                void pushCurrentTrackState();
            }

            // Terapkan volume dari RORA Island secara instan
            if (typeof command.volume === "number" && isFinite(command.volume)) {
                applySpotifyVolume(command.volume);
            }

            if (!command.id || command.id === lastCommandId) return;
            if (command.action !== "add" && command.action !== "check") return;

            lastCommandId = command.id;
            let message;
            if (command.action === "check") {
                const result = await pushCurrentTrackState();
                message = result?.state || "error";
            } else {
                message = await addCurrentToPlaylist();
            }

            try {
                await fetch(RORA_RESULT_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: command.id, message })
                });
            } catch (e) {
                console.warn("[RORA] Tidak dapat mengirim hasil ke bridge:", e);
            }
        } catch (e) {
            // Server bridge belum aktif; tombol manual tetap berfungsi.
        }
    }

    if (ENABLE_RORA_BRIDGE) {
        setTimeout(() => {
            void pushPlaylistsToBridge();
            void pushCurrentTrackState();
        }, 500);
        setInterval(pollRora, POLL_MS);
    }

    console.log(
        "[RORA] Extension aktif (v0.7). Target playlist:",
        activePlaylist?.name,
        activePlaylist?.uri
    );
})();