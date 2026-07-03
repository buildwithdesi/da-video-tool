import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";

const COOKIES_GUIDE_URL =
  "https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp";
import "./App.css";

type FormatId = "best" | "4k" | "1440" | "1080" | "720" | "audio";
type JobStatus = "queued" | "running" | "done" | "error";

interface VideoMetadata {
  title: string;
  thumbnail: string | null;
  duration: number | null;
  channel: string | null;
  uploader: string | null;
  view_count: number | null;
  video_id: string | null;
  extractor: string | null;
  webpage_url: string | null;
}

interface PlaylistEntry {
  id: string | null;
  title: string;
  url: string | null;
  duration: number | null;
  thumbnail: string | null;
  uploader: string | null;
  channel: string | null;
}

interface PlaylistMetadata {
  title: string;
  entry_count: number;
  entries: PlaylistEntry[];
  uploader: string | null;
  webpage_url: string | null;
}

type FetchResult =
  | ({ kind: "video" } & VideoMetadata)
  | ({ kind: "playlist" } & PlaylistMetadata);

type JobKind = "download" | "transcribe";

interface Job {
  id: string;
  url: string;
  kind: JobKind;
  format: FormatId;
  outputDir: string;
  subs: boolean;
  thumbnail: boolean;
  instagramSafe: boolean;
  browserCookies: boolean;
  browser: string;
  cookiesFile: string | null;
  status: JobStatus;
  progress: number;
  log: string[];
  message?: string;
  outputFile: string | null;
  title: string;
  thumbnailUrl: string | null;
  channel: string | null;
  startedAt: number;
}

const FORMATS: { id: FormatId; label: string; sub: string }[] = [
  { id: "best", label: "best quality", sub: "the prettiest available" },
  { id: "4k", label: "4K", sub: "if the video has it" },
  { id: "1440", label: "1440p", sub: "QHD" },
  { id: "1080", label: "1080p", sub: "Full HD, smaller" },
  { id: "720", label: "720p", sub: "tiny file" },
  { id: "audio", label: "just audio", sub: "MP3 only, no video" },
];

const STORAGE = {
  output: "da-video-tool:outputDir",
  format: "da-video-tool:format",
  subs: "da-video-tool:subs",
  thumb: "da-video-tool:thumb",
  instagramSafe: "da-video-tool:instagramSafe",
  browserCookies: "da-video-tool:browserCookies",
  browser: "da-video-tool:browser",
  cookiesFile: "da-video-tool:cookiesFile",
  transcribe: "da-video-tool:transcribe",
  keepVideo: "da-video-tool:keepVideo",
};

const BROWSERS = ["chrome", "firefox", "edge", "brave", "opera", "vivaldi"];

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function statusText(s: JobStatus): string {
  switch (s) {
    case "queued": return "waiting";
    case "running": return "getting it";
    case "done": return "saved";
    case "error": return "didn't work";
  }
}

function statusColor(s: JobStatus): string {
  switch (s) {
    case "queued": return "text-da-muted";
    case "running": return "text-da-blue";
    case "done": return "text-da-green";
    case "error": return "text-da-gold";
  }
}

function formatDuration(s: number | null): string {
  if (s == null || !isFinite(s)) return "";
  const sec = Math.floor(s);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const rs = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(rs).padStart(2, "0")}`;
  return `${m}:${String(rs).padStart(2, "0")}`;
}

function formatViews(n: number | null): string | null {
  if (n == null) return null;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B views`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  return `${n} views`;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(s.trim());
}

function parseUrls(input: string): string[] {
  const seen = new Set<string>();
  return input
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!looksLikeUrl(item) || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function isInstagramUrl(input: string): boolean {
  try {
    const host = new URL(input.trim()).hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return /instagram\.com/i.test(input);
  }
}

function titleFromUrl(input: string): string {
  try {
    const parsed = new URL(input);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const reelIndex = parts.findIndex((part) => part === "reel" || part === "p" || part === "tv");
    if (reelIndex >= 0 && parts[reelIndex + 1]) return `Instagram ${parts[reelIndex + 1]}`;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "untitled";
  }
}

function parseProgressLine(line: string): number | null {
  const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  return m ? Math.min(100, parseFloat(m[1])) : null;
}

function parseOutputPath(line: string): string | null {
  const merger = line.match(/\[Merger\]\s+Merging formats into\s+"(.+?)"/);
  if (merger) return merger[1];
  const extract = line.match(/\[ExtractAudio\]\s+Destination:\s+(.+?)$/);
  if (extract) return extract[1].trim();
  return null;
}

function parseFallbackDestination(line: string): string | null {
  const dest = line.match(/\[download\]\s+Destination:\s+(.+?)$/);
  return dest ? dest[1].trim() : null;
}

function shortenPath(p: string, maxLen = 36): string {
  if (p.length <= maxLen) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length < 2) return p.slice(0, maxLen - 1) + "…";
  const last = parts[parts.length - 1];
  const first = parts[0];
  return `${first}/…/${last}`.slice(0, maxLen);
}

function loadBool(key: string, def: boolean): boolean {
  const v = localStorage.getItem(key);
  return v == null ? def : v === "1";
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function Sparkle({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 1.5l1.6 8.9L22.5 12l-8.9 1.6L12 22.5l-1.6-8.9L1.5 12l8.9-1.6L12 1.5z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function App() {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<FormatId>(
    () => (localStorage.getItem(STORAGE.format) as FormatId) || "best"
  );
  const [outputDir, setOutputDir] = useState<string>(
    () => localStorage.getItem(STORAGE.output) || ""
  );
  const [subs, setSubs] = useState<boolean>(() => loadBool(STORAGE.subs, false));
  const [embedThumb, setEmbedThumb] = useState<boolean>(() => loadBool(STORAGE.thumb, false));
  const [instagramSafe, setInstagramSafe] = useState<boolean>(() => loadBool(STORAGE.instagramSafe, true));
  const [browserCookies, setBrowserCookies] = useState<boolean>(() => loadBool(STORAGE.browserCookies, false));
  const [browser, setBrowser] = useState<string>(() => localStorage.getItem(STORAGE.browser) || "firefox");
  const [cookiesFile, setCookiesFile] = useState<string | null>(() => localStorage.getItem(STORAGE.cookiesFile) || null);
  const [transcribe, setTranscribe] = useState<boolean>(() => loadBool(STORAGE.transcribe, false));
  const [keepVideo, setKeepVideo] = useState<boolean>(() => loadBool(STORAGE.keepVideo, false));
  const [groqKeySaved, setGroqKeySaved] = useState<boolean>(false);
  const [groqKeyInput, setGroqKeyInput] = useState<string>("");
  const [showSettings, setShowSettings] = useState<boolean>(false);

  const [fetchResult, setFetchResult] = useState<FetchResult | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [playlistSel, setPlaylistSel] = useState<Set<number>>(new Set());

  const [jobs, setJobs] = useState<Job[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const metadataReqId = useRef(0);
  const jobsRef = useRef<Job[]>([]);
  const queueRunningRef = useRef(false);
  jobsRef.current = jobs;

  useEffect(() => { if (outputDir) localStorage.setItem(STORAGE.output, outputDir); }, [outputDir]);
  useEffect(() => { localStorage.setItem(STORAGE.format, format); }, [format]);
  useEffect(() => { localStorage.setItem(STORAGE.subs, subs ? "1" : "0"); }, [subs]);
  useEffect(() => { localStorage.setItem(STORAGE.thumb, embedThumb ? "1" : "0"); }, [embedThumb]);
  useEffect(() => { localStorage.setItem(STORAGE.instagramSafe, instagramSafe ? "1" : "0"); }, [instagramSafe]);
  useEffect(() => { localStorage.setItem(STORAGE.browserCookies, browserCookies ? "1" : "0"); }, [browserCookies]);
  useEffect(() => { localStorage.setItem(STORAGE.browser, browser); }, [browser]);
  useEffect(() => { localStorage.setItem(STORAGE.transcribe, transcribe ? "1" : "0"); }, [transcribe]);
  useEffect(() => { localStorage.setItem(STORAGE.keepVideo, keepVideo ? "1" : "0"); }, [keepVideo]);
  useEffect(() => {
    if (cookiesFile) localStorage.setItem(STORAGE.cookiesFile, cookiesFile);
    else localStorage.removeItem(STORAGE.cookiesFile);
  }, [cookiesFile]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<boolean>("groq_key_status").then(setGroqKeySaved).catch(() => setGroqKeySaved(false));
  }, []);

  async function saveGroqKey() {
    const key = groqKeyInput.trim();
    if (!key) return;
    try {
      await invoke("set_groq_key", { key });
      setGroqKeySaved(true);
      setGroqKeyInput("");
    } catch (e) {
      console.error("save groq key failed", e);
    }
  }

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const unP = listen<{ id: string; line: string }>("download-progress", (e) => {
      const { id, line } = e.payload;
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== id) return j;
          const pct = parseProgressLine(line);
          const final = parseOutputPath(line);
          const fallback = !j.outputFile && !final ? parseFallbackDestination(line) : null;
          return {
            ...j,
            status: "running",
            log: [...j.log, line],
            progress: pct != null ? pct : j.progress,
            outputFile: final || fallback || j.outputFile,
          };
        })
      );
    });
    const unC = listen<{ id: string; success: boolean; message: string }>(
      "download-complete",
      (e) => {
        const { id, success, message } = e.payload;
        setJobs((prev) =>
          prev.map((j) =>
            j.id === id
              ? { ...j, status: success ? "done" : "error", message, progress: success ? 100 : j.progress }
              : j
          )
        );
      }
    );
    return () => { unP.then((u) => u()); unC.then((u) => u()); };
  }, []);

  useEffect(() => {
    setFetchError(null);
    const urls = parseUrls(url);
    if (urls.length !== 1) {
      setFetchResult(null);
      setPlaylistSel(new Set());
      setFetchLoading(false);
      return;
    }
    if (!isTauriRuntime()) {
      setFetchResult(null);
      setPlaylistSel(new Set());
      setFetchLoading(false);
      return;
    }
    const myReq = ++metadataReqId.current;
    setFetchLoading(true);
    const t = setTimeout(async () => {
      try {
        const data = await invoke<FetchResult>("fetch_metadata", {
          url: urls[0],
          browserCookies,
          browser,
          cookiesFile,
        });
        if (myReq !== metadataReqId.current) return;
        setFetchResult(data);
        setFetchError(null);
        if (data.kind === "playlist") {
          setPlaylistSel(new Set(data.entries.map((_, i) => i)));
        } else {
          setPlaylistSel(new Set());
        }
      } catch (err) {
        if (myReq !== metadataReqId.current) return;
        setFetchResult(null);
        setPlaylistSel(new Set());
        setFetchError(String(err));
      } finally {
        if (myReq === metadataReqId.current) setFetchLoading(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [url, browserCookies, browser, cookiesFile]);

  async function pickFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Pick a folder to save to",
      defaultPath: outputDir || undefined,
    });
    if (typeof picked === "string") setOutputDir(picked);
  }

  async function pickCookiesFile() {
    const picked = await open({
      directory: false,
      multiple: false,
      title: "Pick your cookies.txt file",
      filters: [{ name: "Cookies", extensions: ["txt"] }],
    });
    if (typeof picked === "string") setCookiesFile(picked);
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch (e) { console.error("clipboard read failed", e); }
  }

  function buildJob(opts: { url: string; title: string; thumb: string | null; channel: string | null; kind?: JobKind }): Job {
    return {
      id: newId(),
      url: opts.url,
      kind: opts.kind || "download",
      format,
      outputDir,
      subs,
      thumbnail: embedThumb,
      instagramSafe: instagramSafe || isInstagramUrl(opts.url),
      browserCookies,
      browser,
      cookiesFile,
      status: "queued",
      progress: 0,
      log: [],
      outputFile: null,
      title: opts.title,
      thumbnailUrl: opts.thumb,
      channel: opts.channel,
      startedAt: Date.now(),
    };
  }

  // Turn one target into the right job(s): transcribe, download, or both.
  function jobsForTarget(opts: { url: string; title: string; thumb: string | null; channel: string | null }): Job[] {
    if (transcribe) {
      const out = [buildJob({ ...opts, kind: "transcribe" })];
      if (keepVideo) out.push(buildJob({ ...opts, kind: "download" }));
      return out;
    }
    return [buildJob({ ...opts, kind: "download" })];
  }

  async function runJob(job: Job) {
    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "running" } : j)));
    try {
      if (job.kind === "transcribe") {
        await invoke("transcribe", {
          id: job.id,
          url: job.url,
          outputDir: job.outputDir,
          browserCookies: job.browserCookies,
          browser: job.browser,
          cookiesFile: job.cookiesFile,
        });
      } else {
        await invoke("download_video", {
          id: job.id,
          url: job.url,
          format: job.format,
          outputDir: job.outputDir,
          subs: job.subs,
          thumbnail: job.thumbnail,
          instagramSafe: job.instagramSafe,
          browserCookies: job.browserCookies,
          browser: job.browser,
          cookiesFile: job.cookiesFile,
        });
      }
    } catch (err) {
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, status: "error", message: String(err) } : j))
      );
    }
  }

  async function processQueue(initialJobs: Job[]) {
    if (queueRunningRef.current) return;
    queueRunningRef.current = true;
    try {
      for (const job of initialJobs) {
        await runJob(job);
      }
      while (true) {
        const next = jobsRef.current.find((j) => j.status === "queued");
        if (!next) break;
        await runJob(next);
      }
    } finally {
      queueRunningRef.current = false;
    }
  }

  async function startSingleDownload() {
    const urls = parseUrls(url);
    if (urls.length !== 1 || !outputDir) return;
    if (fetchResult?.kind === "playlist") return;
    const meta = fetchResult?.kind === "video" ? fetchResult : null;
    const targetUrl = urls[0];
    const newJobs = jobsForTarget({
      url: targetUrl,
      title: meta?.title || titleFromUrl(targetUrl),
      thumb: meta?.thumbnail || null,
      channel: meta?.channel || meta?.uploader || (isInstagramUrl(targetUrl) ? "Instagram" : null),
    });
    setJobs((prev) => [...newJobs, ...prev]);
    setUrl("");
    setFetchResult(null);
    setPlaylistSel(new Set());
    void processQueue(newJobs);
  }

  async function startUrlListDownload() {
    const urls = parseUrls(url);
    if (urls.length === 0 || !outputDir) return;
    if (urls.length === 1 && fetchResult?.kind !== "playlist") {
      await startSingleDownload();
      return;
    }
    const newJobs = urls.flatMap((u) =>
      jobsForTarget({
        url: u,
        title: titleFromUrl(u),
        thumb: null,
        channel: isInstagramUrl(u) ? "Instagram" : null,
      })
    );
    setJobs((prev) => [...newJobs, ...prev]);
    setUrl("");
    setFetchResult(null);
    setPlaylistSel(new Set());
    void processQueue(newJobs);
  }

  async function startPlaylistDownload() {
    if (fetchResult?.kind !== "playlist" || !outputDir) return;
    const picked = fetchResult.entries
      .map((e, i) => ({ e, i }))
      .filter(({ i }) => playlistSel.has(i));
    if (picked.length === 0) return;
    const newJobs: Job[] = picked.flatMap(({ e }) => {
      const u = e.url && /^https?:\/\//i.test(e.url)
        ? e.url
        : (e.id ? `https://www.youtube.com/watch?v=${e.id}` : (e.url || ""));
      return jobsForTarget({
        url: u,
        title: e.title,
        thumb: e.thumbnail,
        channel: e.channel || e.uploader,
      });
    });
    setJobs((prev) => [...newJobs, ...prev]);
    setUrl("");
    setFetchResult(null);
    setPlaylistSel(new Set());
    void processQueue(newJobs);
  }

  async function handleOpenFile(path: string) {
    try { await openPath(path); } catch (e) { console.error(e); }
  }
  async function handleRevealFile(path: string) {
    try { await revealItemInDir(path); } catch (e) { console.error(e); }
  }

  const urlList = parseUrls(url);
  const hasInstagramUrls = urlList.some(isInstagramUrl);
  const canSubmitSingle =
    fetchResult?.kind === "video" && urlList.length === 1 && outputDir.length > 0;
  const canSubmitPlaylist =
    fetchResult?.kind === "playlist" && playlistSel.size > 0 && outputDir.length > 0;
  const canSubmitNoMeta =
    !fetchResult && !fetchLoading && urlList.length > 0 && outputDir.length > 0;
  const queuedCount = canSubmitPlaylist ? playlistSel.size : urlList.length;

  return (
    <main className="min-h-screen relative px-6 py-10 max-w-2xl mx-auto">
      {/* Decorative sparkles */}
      <Sparkle className="absolute top-12 right-8 w-5 h-5 text-da-green/40" />
      <Sparkle className="absolute top-32 left-6 w-3 h-3 text-da-purple/40" />
      <Sparkle className="absolute top-20 left-20 w-2 h-2 text-da-gold/40" />

      {/* Settings toggle */}
      <button
        onClick={() => setShowSettings((s) => !s)}
        className="absolute top-6 right-6 text-xs text-da-muted hover:text-da-green transition-colors flex items-center gap-1.5 z-10"
        title="Settings"
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${groqKeySaved ? "bg-da-green" : "bg-da-muted/50"}`} />
        settings
      </button>

      {showSettings && (
        <div className="absolute top-14 right-6 w-80 bg-da-card border border-da-edge rounded-2xl p-4 shadow-[0_8px_40px_rgba(0,0,0,0.5)] z-20">
          <div className="text-sm font-medium mb-1">Groq API key</div>
          <div className="text-[11px] text-da-muted mb-3 leading-relaxed">
            Needed for transcription. Free at{" "}
            <button
              type="button"
              onClick={() => { void openUrl("https://console.groq.com/keys"); }}
              className="text-da-blue hover:text-da-blue/80 underline underline-offset-2"
            >
              console.groq.com/keys
            </button>
            . Stored locally, never leaves your machine.
          </div>
          <input
            type="password"
            value={groqKeyInput}
            onChange={(e) => setGroqKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveGroqKey(); }}
            placeholder={groqKeySaved ? "key saved — paste a new one to replace" : "gsk_..."}
            className="w-full bg-da-bg/70 border border-da-edge rounded-xl px-3 py-2 text-sm placeholder:text-da-muted/60 focus:outline-none focus:border-da-green transition-colors"
          />
          <div className="mt-3 flex items-center justify-between">
            <span className={`text-[11px] ${groqKeySaved ? "text-da-green" : "text-da-muted"}`}>
              {groqKeySaved ? "✓ key saved" : "no key yet"}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setShowSettings(false)}
                className="text-[11px] px-3 py-1.5 rounded-full text-da-muted hover:text-da-text transition-colors"
              >
                close
              </button>
              <button
                onClick={saveGroqKey}
                disabled={!groqKeyInput.trim()}
                className="text-[11px] px-3 py-1.5 rounded-full bg-da-green text-da-bg font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:brightness-110 transition-all"
              >
                save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="text-center mb-10 pt-4">
        <div className="text-[11px] tracking-[0.4em] uppercase text-da-muted mb-3">
          digital alchemy
        </div>
        <h1 className="text-5xl font-bold leading-none">
          video <span className="italic text-da-green">lab</span>
        </h1>
        <p className="mt-4 text-sm text-da-muted max-w-md mx-auto">
          drop a link, get the file. that's it.
        </p>
      </header>

      {/* Main card */}
      <section className="bg-da-card border border-da-edge rounded-[28px] p-6 shadow-[0_8px_40px_rgba(64,255,120,0.06)] mb-8">
        {/* URL input */}
        <label className="block text-xs text-da-muted ml-2 mb-2">drop links</label>
        <div className="relative">
          <textarea
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !e.ctrlKey) return;
              if (canSubmitPlaylist) startPlaylistDownload();
              else if (canSubmitSingle || canSubmitNoMeta) startUrlListDownload();
            }}
            placeholder="paste one video URL or a list of Instagram Reel URLs..."
            rows={4}
            className="w-full min-h-32 resize-y bg-da-bg/70 border border-da-edge rounded-2xl px-5 py-4 pr-20 text-sm placeholder:text-da-muted/70 focus:outline-none focus:border-da-green focus:shadow-[0_0_0_4px_rgba(64,255,120,0.08)] transition-all"
          />
          <button
            onClick={pasteFromClipboard}
            className="absolute right-2 top-3 px-3 py-1.5 text-xs text-da-muted hover:text-da-green hover:bg-da-green/10 rounded-lg transition-colors"
          >
            paste
          </button>
        </div>
        {urlList.length > 1 && (
          <div className="mt-2 ml-2 text-xs text-da-muted">
            {urlList.length} links ready {hasInstagramUrls && <span className="text-da-green">with Instagram safety on</span>}
          </div>
        )}

        {/* Preview / playlist picker */}
        {(fetchLoading || fetchResult || fetchError) && urlList.length === 1 && (
          <div className="mt-3 bg-da-bg/40 border border-da-edge/60 rounded-2xl overflow-hidden">
            {fetchLoading && !fetchResult && (
              <div className="p-4 flex items-center gap-3 text-da-muted text-sm">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-da-blue animate-pulse" />
                looking it up...
              </div>
            )}
            {!fetchLoading && fetchError && (
              <div className="p-4 text-da-gold text-xs space-y-1">
                <div className="font-medium">couldn't read that link</div>
                <div className="text-da-muted break-words leading-relaxed">{fetchError}</div>
                {/instagram|login|cookie|empty media|rate.?limit/i.test(fetchError) && (
                  <div className="text-da-blue/90 pt-1">
                    Instagram needs your login — turn on <span className="text-da-blue">browser login</span> below
                    (pick the browser you're logged into IG on) or load a <span className="text-da-blue">cookies.txt</span>.
                  </div>
                )}
              </div>
            )}

            {fetchResult?.kind === "video" && (
              <div className="p-3 flex gap-3 items-center">
                {fetchResult.thumbnail && (
                  <img
                    src={fetchResult.thumbnail}
                    alt=""
                    className="w-24 h-14 object-cover rounded-xl flex-shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate" title={fetchResult.title}>
                    {fetchResult.title}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-da-muted">
                    {(fetchResult.channel || fetchResult.uploader) && (
                      <span className="truncate">{fetchResult.channel || fetchResult.uploader}</span>
                    )}
                    {fetchResult.duration != null && (
                      <span className="text-da-blue">·  {formatDuration(fetchResult.duration)}</span>
                    )}
                    {formatViews(fetchResult.view_count) && (
                      <span>·  {formatViews(fetchResult.view_count)}</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {fetchResult?.kind === "playlist" && (
              <div>
                <div className="px-4 py-3 border-b border-da-edge/50 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] tracking-widest uppercase px-2 py-0.5 rounded-full bg-da-purple/15 text-da-purple">
                        playlist
                      </span>
                      <span className="text-xs text-da-muted">
                        {fetchResult.entry_count} videos
                      </span>
                    </div>
                    <div className="text-sm font-medium truncate mt-1">{fetchResult.title}</div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0 ml-3">
                    <button
                      onClick={() => setPlaylistSel(new Set(fetchResult.entries.map((_, i) => i)))}
                      className="text-[10px] px-3 py-1.5 rounded-full bg-da-bg/60 hover:bg-da-green/15 hover:text-da-green text-da-muted transition-colors"
                    >all</button>
                    <button
                      onClick={() => setPlaylistSel(new Set())}
                      className="text-[10px] px-3 py-1.5 rounded-full bg-da-bg/60 hover:bg-da-gold/15 hover:text-da-gold text-da-muted transition-colors"
                    >none</button>
                  </div>
                </div>
                <div className="max-h-72 overflow-auto">
                  {fetchResult.entries.map((entry, i) => {
                    const checked = playlistSel.has(i);
                    return (
                      <label
                        key={`${entry.id || i}`}
                        className={`flex gap-3 items-center px-3 py-2 cursor-pointer transition-colors ${
                          checked ? "bg-da-green/5" : "hover:bg-da-edge/20"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(playlistSel);
                            if (checked) next.delete(i); else next.add(i);
                            setPlaylistSel(next);
                          }}
                          className="w-4 h-4 accent-da-green flex-shrink-0 rounded"
                        />
                        {entry.thumbnail ? (
                          <img src={entry.thumbnail} alt="" className="w-14 h-8 object-cover rounded-lg flex-shrink-0" />
                        ) : (
                          <div className="w-14 h-8 bg-da-edge/40 rounded-lg flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-xs truncate" title={entry.title}>{entry.title}</div>
                          {entry.duration != null && (
                            <div className="text-[10px] text-da-muted mt-0.5">{formatDuration(entry.duration)}</div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div className="px-4 py-2 border-t border-da-edge/50 text-xs text-da-muted text-center">
                  {playlistSel.size} of {fetchResult.entry_count} picked
                </div>
              </div>
            )}
          </div>
        )}

        {/* Quality + Folder */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5">
          <div>
            <label className="block text-xs text-da-muted ml-2 mb-2">quality</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as FormatId)}
              className="w-full bg-da-bg/70 border border-da-edge rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-da-green transition-colors cursor-pointer"
            >
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-da-muted ml-2 mb-2">save to</label>
            <button
              onClick={pickFolder}
              className="w-full bg-da-bg/70 border border-da-edge rounded-2xl px-4 py-3 text-sm text-left hover:border-da-green transition-colors truncate"
              title={outputDir || "Pick a folder"}
            >
              {outputDir ? (
                <span>{shortenPath(outputDir, 32)}</span>
              ) : (
                <span className="text-da-muted">pick a folder...</span>
              )}
            </button>
          </div>
        </div>

        {/* Extras */}
        <div className="mt-4 flex gap-2 flex-wrap">
          <button
            onClick={() => setSubs(!subs)}
            disabled={format === "audio"}
            className={`text-xs px-4 py-2 rounded-full border transition-all ${
              subs && format !== "audio"
                ? "bg-da-purple/15 border-da-purple text-da-purple"
                : "bg-da-bg/40 border-da-edge text-da-muted hover:border-da-purple/50 hover:text-da-purple"
            } disabled:opacity-30 disabled:cursor-not-allowed`}
          >
            subtitles
          </button>
          <button
            onClick={() => setEmbedThumb(!embedThumb)}
            className={`text-xs px-4 py-2 rounded-full border transition-all ${
              embedThumb
                ? "bg-da-gold/15 border-da-gold text-da-gold"
                : "bg-da-bg/40 border-da-edge text-da-muted hover:border-da-gold/50 hover:text-da-gold"
            }`}
          >
            cover image
          </button>
          <button
            onClick={() => setInstagramSafe(!instagramSafe)}
            className={`text-xs px-4 py-2 rounded-full border transition-all ${
              instagramSafe
                ? "bg-da-green/15 border-da-green text-da-green"
                : "bg-da-bg/40 border-da-edge text-da-muted hover:border-da-green/50 hover:text-da-green"
            }`}
          >
            Instagram safe mode
          </button>
          <button
            onClick={() => setBrowserCookies(!browserCookies)}
            className={`text-xs px-4 py-2 rounded-full border transition-all ${
              browserCookies
                ? "bg-da-blue/15 border-da-blue text-da-blue"
                : "bg-da-bg/40 border-da-edge text-da-muted hover:border-da-blue/50 hover:text-da-blue"
            }`}
            title="Use your logged-in browser session (needed for Instagram)"
          >
            browser login
          </button>
          {browserCookies && (
            <select
              value={browser}
              onChange={(e) => setBrowser(e.target.value)}
              className="text-xs px-3 py-2 rounded-full border border-da-blue/60 bg-da-bg/40 text-da-blue focus:outline-none focus:border-da-blue cursor-pointer"
              title="Pick the browser you're logged into Instagram on"
            >
              {BROWSERS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          )}
          <button
            onClick={cookiesFile ? () => setCookiesFile(null) : pickCookiesFile}
            className={`text-xs px-4 py-2 rounded-full border transition-all ${
              cookiesFile
                ? "bg-da-green/15 border-da-green text-da-green"
                : "bg-da-bg/40 border-da-edge text-da-muted hover:border-da-green/50 hover:text-da-green"
            }`}
            title={cookiesFile || "Load a cookies.txt file — the most reliable way past logins"}
          >
            {cookiesFile ? `cookies.txt ✓ (clear)` : "cookies.txt"}
          </button>
          <span className="w-px h-6 bg-da-edge/60 self-center mx-1" />
          <button
            onClick={() => setTranscribe(!transcribe)}
            className={`text-xs px-4 py-2 rounded-full border transition-all ${
              transcribe
                ? "bg-da-purple/15 border-da-purple text-da-purple"
                : "bg-da-bg/40 border-da-edge text-da-muted hover:border-da-purple/50 hover:text-da-purple"
            }`}
            title="Transcribe the audio to text with Groq"
          >
            transcribe
          </button>
          {transcribe && (
            <button
              onClick={() => setKeepVideo(!keepVideo)}
              className={`text-xs px-4 py-2 rounded-full border transition-all ${
                keepVideo
                  ? "bg-da-green/15 border-da-green text-da-green"
                  : "bg-da-bg/40 border-da-edge text-da-muted hover:border-da-green/50 hover:text-da-green"
              }`}
              title="Also keep the video file, not just the transcript"
            >
              keep video too
            </button>
          )}
        </div>
        {transcribe && !groqKeySaved && (
          <p className="mt-2 ml-2 text-[10px] text-da-gold leading-relaxed">
            transcribe needs a Groq API key —{" "}
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="text-da-gold underline underline-offset-2 hover:brightness-125"
            >
              add it in settings
            </button>{" "}
            (free at console.groq.com)
          </p>
        )}
        {(browserCookies || cookiesFile) && (
          <p className="mt-2 ml-2 text-[10px] text-da-muted/70 leading-relaxed">
            {cookiesFile
              ? "using your cookies.txt — most reliable for Instagram"
              : `pulling login from ${browser} — close ${browser} first if it errors, or use a cookies.txt`}
          </p>
        )}
        <p className="mt-2 ml-2 text-[10px] text-da-muted/60 leading-relaxed">
          Instagram &amp; other logins need your cookies.{" "}
          <button
            type="button"
            onClick={() => { void openUrl(COOKIES_GUIDE_URL); }}
            className="text-da-blue/80 hover:text-da-blue underline underline-offset-2 transition-colors"
          >
            how do I get a cookies.txt?
          </button>
        </p>

        {/* Primary button */}
        {(() => {
          const isReady = canSubmitSingle || canSubmitPlaylist || canSubmitNoMeta;
          return (
            <button
              onClick={() => {
                if (canSubmitPlaylist) startPlaylistDownload();
                else startUrlListDownload();
              }}
              disabled={!isReady}
              className={`mt-6 w-full font-semibold py-4 rounded-2xl text-base transition-all ${
                isReady
                  ? "bg-da-green text-da-bg hover:shadow-[0_8px_28px_rgba(64,255,120,0.35)] hover:-translate-y-0.5"
                  : "bg-da-edge/40 text-da-muted cursor-not-allowed border border-da-edge"
              }`}
            >
              {(() => {
                const noun = transcribe ? (keepVideo ? "video + transcript" : "transcript") : "video";
                const nounPl = transcribe ? (keepVideo ? "videos + transcripts" : "transcripts") : "videos";
                if (!outputDir) return "pick a folder to save to";
                if (canSubmitPlaylist)
                  return `get ${playlistSel.size} ${playlistSel.size === 1 ? noun : nounPl}`;
                if (canSubmitSingle || canSubmitNoMeta)
                  return queuedCount > 1 ? `get ${queuedCount} ${nounPl}` : transcribe ? `get ${noun}` : "get it";
                return "paste a link to start";
              })()}
            </button>
          );
        })()}
      </section>

      {/* Recent */}
      <section>
        <div className="flex items-center justify-between mb-3 px-2">
          <h2 className="text-xs text-da-muted">
            recent {jobs.length > 0 && <span className="text-da-text">· {jobs.length}</span>}
          </h2>
          {jobs.some((j) => j.status === "done" || j.status === "error") && (
            <button
              onClick={() => setJobs((prev) => prev.filter((j) => j.status === "running" || j.status === "queued"))}
              className="text-xs text-da-muted hover:text-da-gold transition-colors"
            >
              clear finished
            </button>
          )}
        </div>

        {jobs.length === 0 ? (
          <div className="text-center text-da-muted text-sm py-14 border border-dashed border-da-edge/60 rounded-[28px]">
            <Sparkle className="w-4 h-4 text-da-green/30 mx-auto mb-3" />
            nothing here yet
            <div className="text-xs text-da-muted/70 mt-1">drop a link above to start</div>
          </div>
        ) : (
          <ul className="space-y-2">
            {jobs.map((job) => {
              const expanded = expandedId === job.id;
              const showProgress = job.status === "running" || job.status === "done";
              const isRunning = job.status === "running";
              return (
                <li
                  key={job.id}
                  className={`bg-da-card border rounded-2xl overflow-hidden transition-all ${
                    isRunning ? "border-da-blue/40 shadow-[0_0_0_3px_rgba(0,200,255,0.05)]" : "border-da-edge"
                  }`}
                >
                  <div className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {job.thumbnailUrl ? (
                        <img src={job.thumbnailUrl} alt="" className="w-20 h-12 object-cover rounded-xl flex-shrink-0" />
                      ) : (
                        <div className="w-20 h-12 bg-da-edge/40 rounded-xl flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`text-[11px] ${statusColor(job.status)}`}>
                            {statusText(job.status)}
                          </span>
                          {job.kind === "transcribe" && (
                            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-da-purple/15 text-da-purple">
                              transcript
                            </span>
                          )}
                          {isRunning && (
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-da-blue animate-pulse" />
                          )}
                          {job.channel && (
                            <span className="text-da-muted text-[11px] truncate">· {job.channel}</span>
                          )}
                        </div>
                        <div className="text-sm truncate" title={job.title}>{job.title}</div>

                        {showProgress && (
                          <div className="mt-2 flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-da-bg/80 rounded-full overflow-hidden">
                              <div
                                className={`h-full transition-all duration-200 ${
                                  job.status === "done" ? "bg-da-green" : "bg-da-blue"
                                }`}
                                style={{ width: `${job.progress}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-da-muted tabular-nums w-9 text-right">
                              {Math.floor(job.progress)}%
                            </span>
                          </div>
                        )}

                        <div className="mt-2 flex gap-1.5 flex-wrap items-center">
                          {job.status === "done" && job.outputFile && (
                            <>
                              <button
                                onClick={() => handleOpenFile(job.outputFile!)}
                                className="text-[11px] px-3 py-1.5 rounded-full bg-da-green text-da-bg font-medium hover:brightness-110 transition-all"
                              >open file</button>
                              <button
                                onClick={() => handleRevealFile(job.outputFile!)}
                                className="text-[11px] px-3 py-1.5 rounded-full bg-da-bg/60 hover:bg-da-edge text-da-text transition-colors"
                              >show in folder</button>
                            </>
                          )}
                          <button
                            onClick={() => setExpandedId(expanded ? null : job.id)}
                            className="ml-auto text-[11px] px-2 py-1 text-da-muted hover:text-da-text transition-colors"
                          >{expanded ? "hide details" : "details"}</button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-da-edge bg-da-bg/60 px-4 py-3 max-h-56 overflow-auto">
                      {job.log.length === 0 ? (
                        <div className="text-da-muted text-xs">waiting for output...</div>
                      ) : (
                        <pre className="text-[10px] font-mono text-da-muted whitespace-pre-wrap break-words leading-relaxed">
                          {job.log.slice(-200).join("\n")}
                        </pre>
                      )}
                      {job.message && (
                        <div className={`mt-2 text-xs ${statusColor(job.status)}`}>
                          {job.message}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Footer */}
      <footer className="mt-12 text-center pb-4">
        <a
          href="https://beacons.ai/dbcreations"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-da-muted hover:text-da-green transition-colors"
        >
          beacons.ai/dbcreations
        </a>
        <p className="mt-2 text-[10px] text-da-muted/60">
          for personal use · respect creators · don't redistribute
        </p>
      </footer>
    </main>
  );
}
