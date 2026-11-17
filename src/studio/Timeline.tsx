import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { LuCrosshair, LuZoomIn, LuX } from "react-icons/lu";
import { parseTimecode, timecode, type StudioInterest } from "../shared/studio";
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
  const [zoom, setZoom] = useState(true),
    [editing, setEditing] = useState<"startSec" | "endSec">("startSec");
  const dialog = useRef<HTMLDialogElement>(null),
    timeInput = useRef<HTMLInputElement>(null);
  const [entry, setEntry] = useState(""),
    [error, setError] = useState("");
  const min = selection && zoom ? Math.max(0, selection.startSec - 30) : 0,
    max =
      selection && zoom ? Math.min(duration, selection.endSec + 30) : duration;
  // Freeze viewport while dragging so the thumb does not chase a moving range.
  const [dragBounds, setDragBounds] = useState<[number, number] | null>(null);
  const low = dragBounds?.[0] ?? min,
    high = dragBounds?.[1] ?? max;
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
            <button
              className="text-button"
              aria-pressed={zoom}
              onClick={() => setZoom(!zoom)}
            >
              <LuZoomIn />
              {zoom ? "局部精调" : "全片范围"}
            </button>
          </div>
          <div className="trim-track">
            <div className="trim-base" />
            <div
              className="trim-fill"
              style={{
                left: `${percent(selection.startSec)}%`,
                width: `${percent(selection.endSec) - percent(selection.startSec)}%`,
              }}
            />
            {(["startSec", "endSec"] as const).map((key, index) => (
              <div key={key} className={`trim-control ${index ? "out" : "in"}`}>
                <button
                  className="handle-label"
                  style={{ left: `${percent(selection[key])}%` }}
                  onClick={() => edit(key)}
                  aria-label={`精确设置${index ? "出点" : "入点"}`}
                >
                  {index ? "出" : "入"} {timecode(selection[key], true)}
                </button>
                <input
                  className="trim-range"
                  type="range"
                  aria-label={index ? "出点拨钮" : "入点拨钮"}
                  min={low}
                  max={high}
                  step=".01"
                  value={selection[key]}
                  aria-valuetext={timecode(selection[key], true)}
                  onPointerDown={() => setDragBounds([low, high])}
                  onPointerUp={() => setDragBounds(null)}
                  onPointerCancel={() => setDragBounds(null)}
                  onBlur={() => setDragBounds(null)}
                  onChange={(e) => change(key, +e.target.value)}
                />
              </div>
            ))}
            {time >= low && time <= high && (
              <div className="playhead" style={{ left: `${percent(time)}%` }} />
            )}
          </div>
          <div className="trim-foot">
            <span>{timecode(low)}</span>
            <span>
              拖动拨钮微调 · 点击时间精确输入 · 已选{" "}
              {(selection.endSec - selection.startSec).toFixed(2)} 秒
            </span>
            <span>{timecode(high)}</span>
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
