use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hidden_command(program: &std::path::Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Locate a sidecar binary placed next to the running executable.
/// Falls back to the bare name (will resolve via PATH) when the sidecar
/// is not present — useful for `cargo run` outside the Tauri build pipeline.
fn binary_path(name: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    let filename = format!("{}.exe", name);
    #[cfg(not(target_os = "windows"))]
    let filename = name.to_string();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(&filename);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from(name)
}

fn yt_dlp_path() -> PathBuf {
    binary_path("yt-dlp")
}

fn ffmpeg_path() -> PathBuf {
    binary_path("ffmpeg")
}

#[derive(serde::Serialize, Clone)]
struct ProgressEvent {
    id: String,
    line: String,
}

#[derive(serde::Serialize, Clone)]
struct CompleteEvent {
    id: String,
    success: bool,
    message: String,
}

#[derive(serde::Serialize, Clone, Debug)]
struct VideoMetadata {
    title: String,
    thumbnail: Option<String>,
    duration: Option<f64>,
    channel: Option<String>,
    uploader: Option<String>,
    view_count: Option<u64>,
    video_id: Option<String>,
    extractor: Option<String>,
    webpage_url: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
struct PlaylistEntry {
    id: Option<String>,
    title: String,
    url: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    uploader: Option<String>,
    channel: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
struct PlaylistMetadata {
    title: String,
    entry_count: usize,
    entries: Vec<PlaylistEntry>,
    uploader: Option<String>,
    webpage_url: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FetchResult {
    Video(VideoMetadata),
    Playlist(PlaylistMetadata),
}

fn is_instagram(url: &str) -> bool {
    url.contains("instagram.com")
}

fn pick_thumbnail(entry: &serde_json::Value) -> Option<String> {
    if let Some(t) = entry.get("thumbnail").and_then(|v| v.as_str()) {
        return Some(t.to_string());
    }
    entry
        .get("thumbnails")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .map(String::from)
}

/// Append cookie-related args shared by fetch + download.
/// A `cookies.txt` file wins over browser extraction when both are set —
/// it's the reliable path (no DB locks, no app-bound encryption).
fn push_cookie_args(
    args: &mut Vec<String>,
    browser_cookies: bool,
    browser: &str,
    cookies_file: &Option<String>,
) {
    if let Some(file) = cookies_file {
        if !file.trim().is_empty() {
            args.push("--cookies".into());
            args.push(file.clone());
            return;
        }
    }
    if browser_cookies {
        let b = if browser.trim().is_empty() { "chrome" } else { browser.trim() };
        args.push("--cookies-from-browser".into());
        args.push(b.to_string());
    }
}

/// Pull the most useful line out of yt-dlp's stderr — the last `ERROR:` line
/// if there is one, otherwise the last non-empty line. Beats a generic message.
fn extract_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let last_error = text
        .lines()
        .rev()
        .find(|l| l.contains("ERROR:"))
        .map(|l| l.trim().trim_start_matches("ERROR:").trim().to_string());
    if let Some(msg) = last_error {
        return msg;
    }
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "Could not fetch info — check the URL".into())
}

#[tauri::command]
async fn fetch_metadata(
    url: String,
    browser_cookies: bool,
    browser: String,
    cookies_file: Option<String>,
) -> Result<FetchResult, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Empty URL".into());
    }

    let mut args: Vec<String> = vec![
        "--dump-single-json".into(),
        "--no-warnings".into(),
        "--flat-playlist".into(),
        "--skip-download".into(),
    ];
    push_cookie_args(&mut args, browser_cookies, &browser, &cookies_file);
    args.push(trimmed.to_string());

    let output = hidden_command(&yt_dlp_path())
        .args(&args)
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if !output.status.success() {
        return Err(extract_error(&output.stderr));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse metadata: {}", e))?;

    let is_playlist = json.get("_type").and_then(|v| v.as_str()) == Some("playlist");

    if is_playlist {
        let entries: Vec<PlaylistEntry> = json
            .get("entries")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|e| PlaylistEntry {
                        id: e.get("id").and_then(|v| v.as_str()).map(String::from),
                        title: e
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Untitled")
                            .to_string(),
                        url: e.get("url").and_then(|v| v.as_str()).map(String::from),
                        duration: e.get("duration").and_then(|v| v.as_f64()),
                        thumbnail: pick_thumbnail(e),
                        uploader: e
                            .get("uploader")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        channel: e.get("channel").and_then(|v| v.as_str()).map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let entry_count = entries.len();

        Ok(FetchResult::Playlist(PlaylistMetadata {
            title: json
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Playlist")
                .to_string(),
            entry_count,
            entries,
            uploader: json
                .get("uploader")
                .and_then(|v| v.as_str())
                .map(String::from),
            webpage_url: json
                .get("webpage_url")
                .and_then(|v| v.as_str())
                .map(String::from),
        }))
    } else {
        Ok(FetchResult::Video(VideoMetadata {
            title: json
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string(),
            thumbnail: pick_thumbnail(&json),
            duration: json.get("duration").and_then(|v| v.as_f64()),
            channel: json
                .get("channel")
                .and_then(|v| v.as_str())
                .map(String::from),
            uploader: json
                .get("uploader")
                .and_then(|v| v.as_str())
                .map(String::from),
            view_count: json.get("view_count").and_then(|v| v.as_u64()),
            video_id: json.get("id").and_then(|v| v.as_str()).map(String::from),
            extractor: json
                .get("extractor")
                .and_then(|v| v.as_str())
                .map(String::from),
            webpage_url: json
                .get("webpage_url")
                .and_then(|v| v.as_str())
                .map(String::from),
        }))
    }
}

#[tauri::command]
async fn download_video(
    app: AppHandle,
    id: String,
    url: String,
    format: String,
    output_dir: String,
    subs: bool,
    thumbnail: bool,
    instagram_safe: bool,
    browser_cookies: bool,
    browser: String,
    cookies_file: Option<String>,
) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("URL is empty".into());
    }
    if output_dir.trim().is_empty() {
        return Err("Output folder not picked".into());
    }

    let mut args: Vec<String> = vec![
        "--newline".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "--add-metadata".into(),
        "-P".into(),
        output_dir.clone(),
        "-o".into(),
        "%(title).200B [%(id)s].%(ext)s".into(),
    ];

    // Polite pacing ONLY for real Instagram URLs — IG rate-limits bulk reel pulls.
    // Never applies to TikTok/YouTube (no need), and we deliberately do NOT use
    // --download-archive: it silently skips anything downloaded before, which reads
    // as "it didn't download" when you actually want the file again.
    if instagram_safe && is_instagram(&url) {
        args.extend([
            "--sleep-interval".into(),
            "8".into(),
            "--max-sleep-interval".into(),
            "20".into(),
        ]);
    }

    push_cookie_args(&mut args, browser_cookies, &browser, &cookies_file);

    // If the bundled ffmpeg sidecar exists, tell yt-dlp where to find it.
    // (When falling back to PATH lookup, yt-dlp finds ffmpeg itself.)
    let ffmpeg = ffmpeg_path();
    if ffmpeg.is_absolute() && ffmpeg.exists() {
        args.push("--ffmpeg-location".into());
        args.push(ffmpeg.to_string_lossy().to_string());
    }

    let merger_args = "Merger:-c:v copy -c:a aac -b:a 192k";

    match format.as_str() {
        "best" => {
            args.extend([
                "-f".into(),
                "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b".into(),
                "--merge-output-format".into(),
                "mp4".into(),
                "--postprocessor-args".into(),
                merger_args.into(),
            ]);
        }
        "4k" => {
            args.extend([
                "-f".into(),
                "bv*[height<=2160]+ba/b[height<=2160]".into(),
                "--merge-output-format".into(),
                "mp4".into(),
                "--postprocessor-args".into(),
                merger_args.into(),
            ]);
        }
        "1440" => {
            args.extend([
                "-f".into(),
                "bv*[height<=1440]+ba/b[height<=1440]".into(),
                "--merge-output-format".into(),
                "mp4".into(),
                "--postprocessor-args".into(),
                merger_args.into(),
            ]);
        }
        "1080" => {
            args.extend([
                "-f".into(),
                "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]".into(),
                "--merge-output-format".into(),
                "mp4".into(),
                "--postprocessor-args".into(),
                merger_args.into(),
            ]);
        }
        "720" => {
            args.extend([
                "-f".into(),
                "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]".into(),
                "--merge-output-format".into(),
                "mp4".into(),
                "--postprocessor-args".into(),
                merger_args.into(),
            ]);
        }
        "audio" => {
            args.extend(["-x".into(), "--audio-format".into(), "mp3".into()]);
        }
        other => return Err(format!("Unknown format: {}", other)),
    }

    if subs && format != "audio" {
        args.extend([
            "--write-subs".into(),
            "--write-auto-subs".into(),
            "--sub-langs".into(),
            "en.*".into(),
            "--convert-subs".into(),
            "srt".into(),
            "--embed-subs".into(),
        ]);
    }

    if thumbnail {
        args.extend(["--write-thumbnail".into(), "--embed-thumbnail".into()]);
    }

    args.push(url);

    let mut child = hidden_command(&yt_dlp_path())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_o = app.clone();
    let id_o = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_o.emit(
                "download-progress",
                ProgressEvent {
                    id: id_o.clone(),
                    line,
                },
            );
        }
    });

    let app_e = app.clone();
    let id_e = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_e.emit(
                "download-progress",
                ProgressEvent {
                    id: id_e.clone(),
                    line,
                },
            );
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Wait failed: {}", e))?;

    let success = status.success();
    let _ = app.emit(
        "download-complete",
        CompleteEvent {
            id: id.clone(),
            success,
            message: if success {
                "Done".into()
            } else {
                format!("yt-dlp exited with code {:?}", status.code())
            },
        },
    );

    if success {
        Ok(())
    } else {
        Err(format!("yt-dlp exited with code {:?}", status.code()))
    }
}

// ---------------------------------------------------------------------------
// Transcription (Groq whisper-large-v3-turbo)
// The API key lives native-side in the app config dir — the webview never
// holds it. Audio is pulled with yt-dlp, uploaded to Groq, and a .txt/.srt
// is written next to the download. The audio scratch file is always cleaned up.
// ---------------------------------------------------------------------------

fn groq_key_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No config dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Can't create config dir: {}", e))?;
    Ok(dir.join("groq_key.txt"))
}

#[tauri::command]
fn set_groq_key(app: AppHandle, key: String) -> Result<(), String> {
    let path = groq_key_file(&app)?;
    std::fs::write(&path, key.trim()).map_err(|e| format!("Couldn't save key: {}", e))?;
    Ok(())
}

/// Whether a non-empty key is saved. Never returns the key itself.
#[tauri::command]
fn groq_key_status(app: AppHandle) -> Result<bool, String> {
    let path = groq_key_file(&app)?;
    Ok(std::fs::read_to_string(&path)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false))
}

fn read_groq_key(app: &AppHandle) -> Result<String, String> {
    let path = groq_key_file(app)?;
    let key = std::fs::read_to_string(&path)
        .map_err(|_| "No Groq API key saved — add it in settings.".to_string())?
        .trim()
        .to_string();
    if key.is_empty() {
        return Err("No Groq API key saved — add it in settings.".into());
    }
    Ok(key)
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    let truncated: String = trimmed.chars().take(150).collect();
    if truncated.trim().is_empty() {
        "transcript".into()
    } else {
        truncated.trim().to_string()
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

fn srt_time(t: f64) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as i64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        (ms % 3_600_000) / 60_000,
        (ms % 60_000) / 1000,
        ms % 1000
    )
}

fn build_srt(segments: &[serde_json::Value]) -> String {
    let mut out = String::new();
    for (i, seg) in segments.iter().enumerate() {
        let start = seg.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let end = seg.get("end").and_then(|v| v.as_f64()).unwrap_or(start);
        let text = seg.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            srt_time(start),
            srt_time(end),
            text
        ));
    }
    out
}

/// Best-effort title lookup so the transcript file has a human name.
async fn fetch_title(
    url: &str,
    browser_cookies: bool,
    browser: &str,
    cookies_file: &Option<String>,
) -> Option<String> {
    let mut args: Vec<String> = vec![
        "--no-warnings".into(),
        "--skip-download".into(),
        "--no-playlist".into(),
        "--print".into(),
        "%(title)s".into(),
    ];
    push_cookie_args(&mut args, browser_cookies, browser, cookies_file);
    args.push(url.to_string());
    let out = hidden_command(&yt_dlp_path())
        .args(&args)
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

#[tauri::command]
async fn transcribe(
    app: AppHandle,
    id: String,
    url: String,
    output_dir: String,
    browser_cookies: bool,
    browser: String,
    cookies_file: Option<String>,
) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("URL is empty".into());
    }
    if output_dir.trim().is_empty() {
        return Err("Output folder not picked".into());
    }

    let key = read_groq_key(&app)?;

    let emit = |line: &str| {
        let _ = app.emit(
            "download-progress",
            ProgressEvent {
                id: id.clone(),
                line: line.to_string(),
            },
        );
    };

    // 1. Pull audio only (small + fast) to a predictable scratch file.
    emit("[transcribe] pulling audio…");
    let audio_stem = format!("da-transcribe-{}", id);
    let mut args: Vec<String> = vec![
        "--no-warnings".into(),
        "--no-playlist".into(),
        "-x".into(),
        "--audio-format".into(),
        "mp3".into(),
        "-P".into(),
        output_dir.clone(),
        "-o".into(),
        format!("{}.%(ext)s", audio_stem),
    ];
    push_cookie_args(&mut args, browser_cookies, &browser, &cookies_file);
    let ffmpeg = ffmpeg_path();
    if ffmpeg.is_absolute() && ffmpeg.exists() {
        args.push("--ffmpeg-location".into());
        args.push(ffmpeg.to_string_lossy().to_string());
    }
    args.push(url.clone());

    let out = hidden_command(&yt_dlp_path())
        .args(&args)
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;
    if !out.status.success() {
        return Err(extract_error(&out.stderr));
    }

    let audio_path = std::path::Path::new(&output_dir).join(format!("{}.mp3", audio_stem));
    if !audio_path.exists() {
        return Err("Audio extraction produced no file".into());
    }

    // 2. Upload to Groq.
    emit("[transcribe] transcribing with Groq…");
    let title = fetch_title(&url, browser_cookies, &browser, &cookies_file)
        .await
        .unwrap_or_else(|| id.clone());

    let bytes = tokio::fs::read(&audio_path)
        .await
        .map_err(|e| format!("Couldn't read audio: {}", e))?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("audio.mp3")
        .mime_str("audio/mpeg")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", "whisper-large-v3-turbo")
        .text("response_format", "verbose_json");

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(&key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq request failed: {}", e));

    // Always clean up the audio scratch, success or fail.
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let _ = tokio::fs::remove_file(&audio_path).await;
            return Err(e);
        }
    };

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let _ = tokio::fs::remove_file(&audio_path).await;

    if !status.is_success() {
        return Err(format!(
            "Groq error {} — {}",
            status.as_u16(),
            truncate(body.trim(), 300)
        ));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad Groq response: {}", e))?;
    let text = json
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("Groq returned an empty transcript (no speech detected?)".into());
    }

    // 3. Write .txt (+ .srt when segments are present).
    let safe = sanitize_filename(&title);
    let txt_path = std::path::Path::new(&output_dir).join(format!("{} [{}].txt", safe, id));
    tokio::fs::write(&txt_path, &text)
        .await
        .map_err(|e| format!("Couldn't write transcript: {}", e))?;

    if let Some(segments) = json.get("segments").and_then(|v| v.as_array()) {
        let srt = build_srt(segments);
        if !srt.is_empty() {
            let srt_path =
                std::path::Path::new(&output_dir).join(format!("{} [{}].srt", safe, id));
            let _ = tokio::fs::write(&srt_path, srt).await;
        }
    }

    // Emit the destination first (UI captures outputFile), then completion.
    let _ = app.emit(
        "download-progress",
        ProgressEvent {
            id: id.clone(),
            line: format!("[download] Destination: {}", txt_path.to_string_lossy()),
        },
    );
    let _ = app.emit(
        "download-complete",
        CompleteEvent {
            id: id.clone(),
            success: true,
            message: "Transcript saved".into(),
        },
    );

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            download_video,
            fetch_metadata,
            transcribe,
            set_groq_key,
            groq_key_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
