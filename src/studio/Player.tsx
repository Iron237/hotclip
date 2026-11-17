import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LuPlay,
  LuPause,
  LuVolume2,
  LuVolumeX,
  LuMaximize,
  LuCaptions,
  LuMessageSquare,
  LuRotateCcw,
  LuRotateCw,
} from "react-icons/lu";
import {
  scheduleChat,
  visibleChat,
  subtitleFile,
  hostCaptionLines,
  timecode,
  type StudioProject,
  type StudioClip,
  type StudioSettings,
  type StudioLine,
} from "../shared/studio";
import { stripCaptionPunctuation } from "../shared/caption-text";
export interface PlayerHandle {
  seek: (sec: number) => void;
  pause: () => void;
  playRange: (start: number, end: number) => void;
}
interface Props {
  project: StudioProject;
  ready: boolean;
  initialTime: number;
  clip?: StudioClip;
  linesOverride?: StudioLine[];
  settings: StudioSettings;
  onTime: (time: number) => void;
  onEdit?: (line: StudioLine, text: string) => void;
}
export const Player = forwardRef<PlayerHandle, Props>(function Player(
  {
    project,
    ready,
    initialTime,
    clip,
    linesOverride,
    settings,
    onTime,
    onEdit,
  },
  ref,
) {
  const video = useRef<HTMLVideoElement>(null),
    stage = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false),
    [seeking, setSeeking] = useState(false),
    [time, setTime] = useState(initialTime),
    [volume, setVolume] = useState(0.8),
    [rate, setRate] = useState(1),
    [chatEnabled, setChatEnabled] = useState(true),
    [captions, setCaptions] = useState(true),
    [error, setError] = useState("");
  const [shortcuts, setShortcuts] = useState(() => {
    try {
      return localStorage.getItem("hotclip-studio-shortcuts") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "hotclip-studio-shortcuts",
        shortcuts ? "on" : "off",
      );
    } catch {
      /* Private storage may be unavailable. */
    }
  }, [shortcuts]);
  const beforeMute = useRef(0.8);
  const latest = useRef({ onTime, clip, chatEnabled, settings });
  latest.current = { onTime, clip, chatEnabled, settings };
  const initial = useRef(initialTime);
  const audition = useRef<{ startSec: number; endSec: number } | null>(null);
  const sourceLines = linesOverride ?? clip?.subtitles ?? project.lines;
  const lines = useMemo(() => hostCaptionLines(sourceLines), [sourceLines]);
  const active = lines.find((l) => l.startSec <= time && l.endSec > time);
  const cues = useMemo(
    () => scheduleChat(project.chat, settings.danmakuSize),
    [project.chat, settings.danmakuSize],
  );
  const vtt = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([subtitleFile(lines, 0, true)], { type: "text/vtt" }),
      ),
    [lines],
  );
  useEffect(() => () => URL.revokeObjectURL(vtt), [vtt]);
  const seek = (sec: number) => {
    audition.current = null;
    if (video.current) {
      const bounded = Math.max(
        clip?.startSec ?? 0,
        Math.min(clip?.endSec ?? project.durationSec - 0.01, sec),
      );
      initial.current = bounded;
      video.current.currentTime = bounded;
      // The video clock, not the requested slider position, owns every overlay.
      setTime(video.current.currentTime);
      onTime(video.current.currentTime);
    }
  };
  useImperativeHandle(ref, () => ({
    seek,
    pause: () => video.current?.pause(),
    playRange: (start, end) => {
      seek(start);
      audition.current = { startSec: start, endSec: end };
      void video.current?.play().catch((e) => setError(e.message));
    },
  }));
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let id = 0,
      stopped = false,
      last = 0,
      drawn = "";
    const draw = () => {
      if (stopped) return;
      let now = v.currentTime;
      const current = latest.current;
      const boundary = audition.current ?? current.clip;
      if (boundary && now >= boundary.endSec && !v.paused) {
        v.pause();
        v.currentTime = boundary.endSec;
        now = boundary.endSec;
      }
      if (now !== last) {
        last = now;
        setTime(now);
        current.onTime(now);
      }
      const ctx = canvas.current?.getContext("2d");
      const signature = `${now}:${v.seeking}:${current.chatEnabled}:${current.settings.danmakuSize}:${current.settings.danmakuOpacity}`;
      if (ctx && signature !== drawn) {
        drawn = signature;
        ctx.clearRect(0, 0, 1920, 1080);
        if (current.chatEnabled && !v.seeking) {
          ctx.font = `bold ${current.settings.danmakuSize}px "Microsoft YaHei", sans-serif`;
          ctx.textBaseline = "top";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#111";
          ctx.fillStyle = "#fff";
          ctx.globalAlpha = current.settings.danmakuOpacity;
          for (const c of visibleChat(cues, now)) {
            const x = 1920 - ((now - c.startSec) / 9) * (1920 + c.width),
              y = 28 + c.lane * (current.settings.danmakuSize + 16);
            ctx.strokeText(c.text, x, y);
            ctx.fillText(c.text, x, y);
          }
          ctx.globalAlpha = 1;
        }
      }
      // RAF also draws paused seeks and setting changes, unlike frame callbacks.
      id = requestAnimationFrame(draw);
    };
    id = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(id);
    };
  }, [cues, ready]);
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      audition.current = null;
      if (
        clip &&
        (v.currentTime >= clip.endSec - 0.05 || v.currentTime < clip.startSec)
      )
        seek(clip.startSec);
      void v.play().catch((e) => setError(e.message));
    } else v.pause();
  };
  const setPlayerVolume = (n: number) => {
    const value = Math.max(0, Math.min(1, n));
    setVolume(value);
    if (video.current) video.current.volume = value;
  };
  const mute = () => {
    if (volume > 0) {
      beforeMute.current = volume;
      setPlayerVolume(0);
    } else setPlayerVolume(beforeMute.current || 0.8);
  };
  const fullscreen = () => {
    const task = document.fullscreenElement
      ? document.exitFullscreen()
      : stage.current?.requestFullscreen();
    void task?.catch(() => setError("当前浏览器不支持全屏"));
  };
  useEffect(() => {
    if (!shortcuts || !ready) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        document.querySelector("dialog[open]")
      )
        return;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role=slider], .trim-pan",
        )
      )
        return;
      if ((e.key === " " || e.key === "Enter") && target?.closest("button, a"))
        return;
      const v = video.current;
      if (!v) return;
      const key = e.key.toLowerCase();
      if (
        ![
          " ",
          "k",
          "arrowleft",
          "arrowright",
          "arrowup",
          "arrowdown",
          "m",
          "f",
          "j",
          "l",
          ",",
          ".",
          "c",
          "d",
        ].includes(key)
      )
        return;
      e.preventDefault();
      if ([" ", "k", "m", "f", "c", "d"].includes(key) && e.repeat) return;
      if (key === " " || key === "k") toggle();
      else if (key === "arrowleft" || key === "arrowright")
        seek(
          v.currentTime + (key === "arrowleft" ? -1 : 1) * (e.shiftKey ? 1 : 5),
        );
      else if (key === "j" || key === "l")
        seek(v.currentTime + (key === "j" ? -10 : 10));
      else if (key === "arrowup" || key === "arrowdown")
        setPlayerVolume(v.volume + (key === "arrowup" ? 0.05 : -0.05));
      else if (key === "m") mute();
      else if (key === "f") fullscreen();
      else if (key === "c") setCaptions((x) => !x);
      else if (key === "d") setChatEnabled((x) => !x);
      else {
        v.pause();
        seek(v.currentTime + (key === "," ? -1 : 1) / (project.fps || 30));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  return (
    <section className="player" aria-label="视频播放器">
      <div className="video-stage" ref={stage}>
        <video
          ref={video}
          src={ready ? `/api/projects/${project.id}/media` : undefined}
          preload="metadata"
          playsInline
          aria-label={clip?.title || project.title}
          onLoadedMetadata={() => {
            if (video.current) {
              video.current.volume = volume;
              video.current.playbackRate = rate;
              seek(initial.current);
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onSeeking={() => {
            setSeeking(true);
            if (video.current) {
              setTime(video.current.currentTime);
              onTime(video.current.currentTime);
            }
          }}
          onSeeked={() => {
            setSeeking(false);
            if (video.current) {
              setTime(video.current.currentTime);
              onTime(video.current.currentTime);
            }
          }}
          onError={() => setError("视频读取失败，请检查预览准备状态后刷新")}
          onClick={toggle}
        >
          <track kind="captions" srcLang="zh" label="校核字幕" src={vtt} />
        </video>
        <canvas
          ref={canvas}
          width="1920"
          height="1080"
          className="danmaku-canvas"
          aria-hidden="true"
        />
        {!ready && (
          <div className="video-placeholder">
            <LuPlay />
            <strong>正在准备原片预览</strong>
            <span>只转换封装，不重新压制画质</span>
          </div>
        )}
        {!playing && ready && !onEdit && (
          <button
            className="center-play"
            aria-label="播放视频"
            onClick={toggle}
          >
            <LuPlay />
          </button>
        )}
        {captions &&
          !seeking &&
          active &&
          (onEdit ? (
            <textarea
              className="editable-caption"
              aria-label="画面上的当前字幕"
              value={active.text}
              rows={1}
              onFocus={() => video.current?.pause()}
              onChange={(e) => onEdit(active, e.target.value)}
              onBlur={(e) =>
                onEdit(active, stripCaptionPunctuation(e.target.value))
              }
            />
          ) : (
            <div className="caption-overlay">
              {stripCaptionPunctuation(active.text)}
            </div>
          ))}
        <span className="source-badge">
          {seeking ? "定位画面…" : clip ? "切片预览" : "原片"} <i />{" "}
          {project.height}P
        </span>
      </div>
      <div className="player-controls">
        <button
          aria-label={playing ? "暂停" : "播放"}
          onClick={toggle}
          disabled={!ready}
        >
          {playing ? <LuPause /> : <LuPlay />}
        </button>
        <button aria-label="后退五秒" onClick={() => seek(time - 5)}>
          <LuRotateCcw />
        </button>
        <button aria-label="前进五秒" onClick={() => seek(time + 5)}>
          <LuRotateCw />
        </button>
        <span className="player-clock">
          {timecode(time)} <span>/ {timecode(project.durationSec)}</span>
        </span>
        <div className="control-spacer" />
        <button
          aria-label="弹幕"
          aria-pressed={chatEnabled}
          className={chatEnabled ? "on" : ""}
          onClick={() => setChatEnabled(!chatEnabled)}
        >
          <LuMessageSquare />
          <span>弹幕</span>
        </button>
        <button
          aria-label="字幕"
          aria-pressed={captions}
          className={captions ? "on" : ""}
          onClick={() => setCaptions(!captions)}
        >
          <LuCaptions />
        </button>
        <label className="rate-control">
          <span className="sr-only">播放倍速</span>
          <select
            value={rate}
            onChange={(e) => {
              setRate(+e.target.value);
              if (video.current) video.current.playbackRate = +e.target.value;
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
        </label>
        <button aria-label={volume ? "静音" : "恢复音量"} onClick={mute}>
          {volume ? <LuVolume2 /> : <LuVolumeX />}
        </button>
        <label className="volume">
          <span className="sr-only">音量</span>
          <input
            type="range"
            min="0"
            max="1"
            step=".01"
            value={volume}
            onChange={(e) => {
              setVolume(+e.target.value);
              if (video.current) video.current.volume = +e.target.value;
            }}
          />
        </label>
        <button aria-label="全屏" onClick={fullscreen}>
          <LuMaximize />
        </button>
      </div>
      <details className="keyboard-help">
        <summary>播放快捷键</summary>
        <label>
          <input
            type="checkbox"
            checked={shortcuts}
            onChange={(e) => setShortcuts(e.target.checked)}
          />{" "}
          启用播放快捷键
        </label>
        <p>
          空格 / K 播放暂停 · ← → 5 秒（Shift 1 秒）· J / L 10 秒 · ↑ ↓ 音量 · M
          静音 · F 全屏 · C 字幕 · D 弹幕 · , / . 暂停逐帧定位
        </p>
        <p>
          输入框、字幕编辑和时间轴拨钮优先处理自己的按键；逐帧步长按原片帧率计算。
        </p>
      </details>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
});
