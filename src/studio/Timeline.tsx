import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { LuCrosshair, LuZoomIn, LuX } from "react-icons/lu";
import { parseTimecode, timecode, type StudioInterest } from "../shared/studio";
import {
  clampWindow,
  zoomWindow,
  type TimelineWindow,
} from "../shared/timeline-window";
export interface Selection {
  interestId?: string;
  title: string;
  startSec: number;
  endSec: number;
}
export function TimeField({
  label,
  value,
  onCommit,
  max,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  max: number;
}) {
  const [text, setText] = useState(timecode(value, true)),
    [error, setError] = useState("");
  const id = useId();
  useEffect(() => {
    setText(timecode(value, true));
    setError("");
  }, [value]);
  const commit = () => {
    const n = parseTimecode(text);
    if (n === null || n > max) {
      setError("请输入范围内的 HH:MM:SS.mmm");
      return;
    }
    setError("");
    onCommit(n);
  };
  return (
    <div className="time-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        spellCheck={false}
        value={text}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setError("");
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit();
          }
        }}
      />
      {error && (
        <small role="alert" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}
export function Timeline({
  duration,
  time,
  interests,
  selection,
  onSeek,
  onSelect,
  onChange,
}: {
  duration: number;
  time: number;
  interests: StudioInterest[];
  selection: Selection | null;
  onSeek: (n: number) => void;
  onSelect: (i: StudioInterest) => void;
  onChange: (s: Selection) => void;
}) {
  const [editing, setEditing] = useState<"startSec" | "endSec">("startSec");
  const [viewport, setViewport] = useState<TimelineWindow | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    x: number;
    value: number;
    span: number;
    width: number;
    key?: "startSec" | "endSec";
    view: TimelineWindow;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    timeInput = useRef<HTMLInputElement>(null);
  const [entry, setEntry] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setViewport(null);
    gesture.current = null;
  }, [selection?.interestId, selection?.title, duration]);
  const fitted: TimelineWindow = selection
    ? [
        Math.max(0, selection.startSec - 30),
        Math.min(duration, selection.endSec + 30),
      ]
    : [0, duration];
  const [low, high] = viewport ?? fitted;
  const span = high - low;
  const focusTime = (n: number) =>
    setViewport(clampWindow(n - span / 2, span, duration));
  const zoomAt = (factor: number, ratio = 0.5) =>
    setViewport(zoomWindow([low, high], factor, ratio, duration));
  const pan = (delta: number) =>
    setViewport(clampWindow(low + delta, span, duration));
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || gesture.current) return; // Preserve browser zoom.
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const delta = (e.deltaX || e.deltaY) * unit;
        setViewport(
          clampWindow(low + (delta / rect.width) * span, span, duration),
        );
      } else
        setViewport(
          zoomWindow(
            [low, high],
            Math.exp(Math.max(-0.7, Math.min(0.7, e.deltaY * unit * 0.002))),
            (e.clientX - rect.left) / rect.width,
            duration,
          ),
        );
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [low, high, duration, !!selection]);
  const percent = (n: number) => ((n - low) / (high - low)) * 100;
  const change = (key: "startSec" | "endSec", n: number) => {
    if (!selection) return;
    const next = Math.max(
      0,
      Math.min(
        duration,
        key === "startSec"
          ? Math.min(n, selection.endSec - 0.1)
          : Math.max(n, selection.startSec + 0.1),
      ),
    );
    onChange({ ...selection, [key]: next });
    onSeek(next);
  };
  const edit = (key: "startSec" | "endSec") => {
    if (!selection) return;
    setEditing(key);
    setEntry(timecode(selection[key], true));
    setError("");
    dialog.current?.showModal();
    setTimeout(() => timeInput.current?.select(), 0);
  };
  return (
    <section className="timeline" aria-label="切片时间轴">
      <div className="timeline-title">
        <span>
          <LuCrosshair /> 全片定位 <small>{interests.length} 个兴趣点</small>
        </span>
        <span className="legend">
          <i /> 手动标记 <i className="blue" /> 自动发现
        </span>
      </div>
      <div className="overview-markers">
        {interests.map((i) => (
          <button
            key={i.id}
            aria-label={`${i.id} ${i.title}`}
            title={`${timecode(i.startSec ?? i.markerSec)} · ${i.title}`}
            className={`marker ${i.id.startsWith("A") ? "auto" : ""} ${i.id === selection?.interestId ? "selected" : ""}`}
            style={{
              left: `${((i.startSec ?? i.markerSec) / duration) * 100}%`,
            }}
            onClick={() => onSelect(i)}
          >
            <span />
          </button>
        ))}
      </div>
      <input
        className="seek-range"
        type="range"
        aria-label="全片播放位置"
        min="0"
        max={duration}
        step=".01"
        value={time}
        aria-valuetext={timecode(time, true)}
        style={{ "--fill": `${(time / duration) * 100}%` } as CSSProperties}
        onChange={(e) => onSeek(+e.target.value)}
      />
      <div className="time-ruler">
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n}>{timecode((duration * n) / 4)}</span>
        ))}
      </div>
      {selection && (
        <>
          <div className="trim-heading">
            <strong>
              {selection.interestId || "自选"} <span>{selection.title}</span>
            </strong>
            <div className="trim-tools">
              <button
                className="text-button"
                aria-label="缩小时间轴"
                onClick={() => zoomAt(2)}
              >
                −
              </button>
              <button
                className="text-button"
                aria-label="放大时间轴"
                onClick={() => zoomAt(0.5)}
              >
                <LuZoomIn /> 放大
              </button>
              <button
                className="text-button"
                onClick={() => setViewport(fitted)}
              >
                适合选段
              </button>
              <button
                className="text-button"
                onClick={() => setViewport([0, duration])}
              >
                全片范围
              </button>
              <button
                className="text-button"
                onClick={() => focusTime(selection.startSec)}
              >
                定位入点
              </button>
              <button
                className="text-button"
                onClick={() => focusTime(selection.endSec)}
              >
                定位出点
              </button>
            </div>
          </div>
          <div
            className="trim-track"
            ref={track}
            data-low={low}
            data-high={high}
          >
            <div className="trim-base" />
            <button
              className="trim-pan"
              aria-label="平移时间轴"
              aria-describedby="trim-help"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                gesture.current = {
                  x: e.clientX,
                  value: 0,
                  span,
                  width: track.current!.getBoundingClientRect().width,
                  view: [low, high],
                };
                setViewport([low, high]);
              }}
              onPointerMove={(e) => {
                const g = gesture.current;
                if (
                  g &&
                  !g.key &&
                  e.currentTarget.hasPointerCapture(e.pointerId)
                )
                  setViewport(
                    clampWindow(
                      g.view[0] - ((e.clientX - g.x) / g.width) * g.span,
                      g.span,
                      duration,
                    ),
                  );
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onLostPointerCapture={() => {
                gesture.current = null;
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  pan(span * (e.key === "ArrowLeft" ? -0.1 : 0.1));
                }
              }}
            />
            <div
              className="trim-fill"
              style={{
                left: `${Math.max(0, Math.min(100, percent(selection.startSec)))}%`,
                width: `${Math.max(0, Math.min(100, percent(selection.endSec)) - Math.max(0, percent(selection.startSec)))}%`,
              }}
            />
            {(["startSec", "endSec"] as const).map((key, index) => (
              <div key={key} className={`trim-control ${index ? "out" : "in"}`}>
                <button
                  className="handle-label"
                  style={{
                    left: `${selection.endSec < low || selection.startSec > high ? index * 100 : Math.max(0, Math.min(100, percent(selection[key])))}%`,
                  }}
                  onClick={() => edit(key)}
                  aria-label={`精确设置${index ? "出点" : "入点"}`}
                >
                  {selection[key] < low
                    ? "← "
                    : selection[key] > high
                      ? "→ "
                      : ""}
                  {index ? "出" : "入"} {timecode(selection[key], true)}
                </button>
                {selection[key] >= low && selection[key] <= high && (
                  <input
                    className="trim-range"
                    type="range"
                    aria-label={index ? "出点拨钮" : "入点拨钮"}
                    min={low}
                    max={high}
                    step=".001"
                    value={selection[key]}
                    aria-valuetext={timecode(selection[key], true)}
                    aria-describedby="trim-help"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.currentTarget.focus();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      gesture.current = {
                        x: e.clientX,
                        value: selection[key],
                        span,
                        width: track.current!.getBoundingClientRect().width,
                        key,
                        view: [low, high],
                      };
                      setViewport([low, high]);
                    }}
                    onPointerMove={(e) => {
                      const g = gesture.current;
                      if (
                        g?.key === key &&
                        e.currentTarget.hasPointerCapture(e.pointerId)
                      ) {
                        const value =
                          g.value +
                          ((e.clientX - g.x) / g.width) *
                            g.span *
                            (e.shiftKey ? 0.1 : 1);
                        change(
                          key,
                          Math.round(
                            Math.max(low, Math.min(high, value)) * 1000,
                          ) / 1000,
                        );
                      }
                    }}
                    onPointerUp={(e) => {
                      if (e.currentTarget.hasPointerCapture(e.pointerId))
                        e.currentTarget.releasePointerCapture(e.pointerId);
                    }}
                    onLostPointerCapture={() => {
                      gesture.current = null;
                    }}
                    onKeyDown={(e) => {
                      if (
                        [
                          "ArrowLeft",
                          "ArrowDown",
                          "ArrowRight",
                          "ArrowUp",
                        ].includes(e.key)
                      ) {
                        e.preventDefault();
                        const sign =
                          e.key === "ArrowLeft" || e.key === "ArrowDown"
                            ? -1
                            : 1;
                        const value =
                          selection[key] + sign * (e.shiftKey ? 0.001 : 0.01);
                        change(key, Math.round(value * 1000) / 1000);
                        if (value < low || value > high) focusTime(value);
                      }
                    }}
                    onChange={(e) => change(key, +e.target.value)}
                  />
                )}
              </div>
            ))}
            {time >= low && time <= high && (
              <div className="playhead" style={{ left: `${percent(time)}%` }} />
            )}
          </div>
          <div className="trim-foot">
            <button
              className="text-button"
              aria-label="时间轴向前平移"
              onClick={() => pan(-span * 0.25)}
            >
              ← {timecode(low, true)}
            </button>
            <span id="trim-help">
              滚轮缩放 · Shift＋滚轮或拖动底轨平移 · Shift＋拖钮精调 · 方向键
              0.01 秒（Shift 0.001 秒） · 已选{" "}
              {(selection.endSec - selection.startSec).toFixed(2)} 秒 · 视窗{" "}
              {span.toFixed(2)} 秒
            </span>
            <button
              className="text-button"
              aria-label="时间轴向后平移"
              onClick={() => pan(span * 0.25)}
            >
              {timecode(high, true)} →
            </button>
          </div>
        </>
      )}
      <dialog
        ref={dialog}
        className="time-dialog"
        aria-labelledby="time-dialog-title"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseTimecode(entry);
            if (
              n === null ||
              n < 0 ||
              n > duration ||
              (selection &&
                (editing === "startSec"
                  ? n >= selection.endSec
                  : n <= selection.startSec))
            ) {
              setError("时间须在原片范围内，且入点早于出点");
              return;
            }
            change(editing, n);
            if (n < low || n > high) focusTime(n);
            dialog.current?.close();
          }}
        >
          <div className="section-heading">
            <h2 id="time-dialog-title">
              精确设置{editing === "startSec" ? "入点" : "出点"}
            </h2>
            <button
              type="button"
              aria-label="关闭时间设置"
              onClick={() => dialog.current?.close()}
            >
              <LuX />
            </button>
          </div>
          <label htmlFor="precise-time">原片时间 · HH:MM:SS.mmm</label>
          <input
            ref={timeInput}
            id="precise-time"
            name="time"
            value={entry}
            onChange={(e) => {
              setEntry(e.target.value);
              setError("");
            }}
            aria-invalid={!!error}
            aria-describedby="time-error"
            required
            autoFocus
          />
          <p id="time-error" className="inline-error">
            {error}
          </p>
          <button className="primary" type="submit">
            设置并跳转
          </button>
        </form>
      </dialog>
    </section>
  );
}
