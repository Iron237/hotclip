import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import { createRoot } from "react-dom/client";
import {
  LuScissors,
  LuCaptions,
  LuDownload,
  LuChevronRight,
  LuPlus,
  LuTrash2,
  LuCheck,
  LuCircleAlert,
  LuSearch,
  LuArrowLeft,
  LuFolderOpen,
  LuSave,
  LuFilm,
  LuArrowUp,
  LuArrowDown,
  LuPanelRight,
  LuRefreshCw,
  LuX,
} from "react-icons/lu";
import {
  clipLines,
  resizeClip,
  editClipLine,
  replaceClipCaptions,
  timecode,
  type StudioProject,
  type StudioDraft,
  type StudioClip,
  type StudioInterest,
  type StudioLine,
  type StudioJob,
} from "../shared/studio";
import { stripCaptionPunctuation } from "../shared/caption-text";
import { api } from "./api";
import { Player, type PlayerHandle } from "./Player";
import { Timeline, TimeField, type Selection } from "./Timeline";
import "./studio.css";

function useDraft(initial: StudioDraft, base: string) {
  const [draft, setDraft] = useState(initial),
    [status, setStatus] = useState("已保存"),
    [saveError, setSaveError] = useState("");
  const current = useRef(initial),
    revision = useRef(initial.revision),
    generation = useRef(0),
    saved = useRef(0),
    flight = useRef<Promise<void> | null>(null);
  const change = useCallback((fn: (d: StudioDraft) => StudioDraft) => {
    const next = fn(current.current);
    current.current = next;
    generation.current++;
    setDraft(next);
    setStatus("有未保存修改");
  }, []);
  const flush = useCallback(async () => {
    while (flight.current) await flight.current;
    if (saved.current === generation.current)
      return { ...current.current, revision: revision.current };
    const work = async () => {
      while (saved.current !== generation.current) {
        const target = generation.current,
          payload = { ...current.current, revision: revision.current };
        setStatus("保存中…");
        const result = await api<{ revision: number }>(
          base + "/draft",
          "PUT",
          payload,
        );
        revision.current = result.revision;
        saved.current = target;
      }
      setStatus("已保存");
      setSaveError("");
    };
    flight.current = work();
    try {
      await flight.current;
    } catch (e) {
      setStatus("保存失败");
      setSaveError(String(e));
      throw e;
    } finally {
      flight.current = null;
    }
    return { ...current.current, revision: revision.current };
  }, [base]);
  useEffect(() => {
    const t = setTimeout(() => {
      void flush().catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [draft, flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (generation.current !== saved.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return { draft, change, flush, status, saveError };
}
const steps = [
  { title: "选片段", icon: LuScissors, hint: "定位精彩瞬间" },
  { title: "字幕审核", icon: LuCaptions, hint: "把每句话说准确" },
  { title: "导出设置", icon: LuDownload, hint: "准备好，出片" },
];
function Studio({ project }: { project: StudioProject }) {
  const base = `/api/projects/${project.id}`,
    first = project.interests.find((i) => i.startSec !== null);
  const { draft, change, flush, status, saveError } = useDraft(
    project.draft,
    base,
  );
  const [page, setPage] = useState(0),
    [selection, setSelection] = useState<Selection | null>(
      first
        ? {
            interestId: first.id,
            title: first.title,
            startSec: first.startSec!,
            endSec: first.endSec!,
          }
        : null,
    ),
    [editingId, setEditingId] = useState<string | null>(null);
  const [time, setTime] = useState(first?.startSec ?? 0),
    [preview, setPreview] = useState({
      status: "preparing",
      progress: 0,
      error: "",
    }),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [reviewId, setReviewId] = useState<string | null>(
      draft.clips[0]?.id ?? null,
    ),
    [onlyUncertain, setOnlyUncertain] = useState(false),
    [subSearch, setSubSearch] = useState(""),
    [jobs, setJobs] = useState<StudioJob[]>([]),
    [exporting, setExporting] = useState(false);
  const [aligning, setAligning] = useState(false),
    [alignmentProgress, setAlignmentProgress] = useState({ done: 0, total: 0 });
  const alignmentController = useRef<AbortController | null>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  useEffect(() => () => alignmentController.current?.abort(), []);
  const player = useRef<PlayerHandle>(null),
    heading = useRef<HTMLHeadingElement>(null),
    previousPage = useRef(page);
  const activeClip =
      draft.clips.find((c) => c.id === reviewId) ?? draft.clips[0],
    activeInterest = project.interests.find(
      (i) => i.id === selection?.interestId,
    );
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [p, j] = await Promise.all([
          api<typeof preview>(base + "/preview"),
          api<StudioJob[]>(base + "/jobs"),
        ]);
        if (active) {
          setPreview(p);
          setJobs(j);
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [base]);
  const navigate = (n: number) => {
    player.current?.pause();
    setPage(n);
    if (n === 1 && activeClip) setTime(activeClip.startSec);
  };
  useEffect(() => {
    document.title = `${steps[page].title} · HotClip Studio`;
    if (previousPage.current !== page)
      heading.current?.focus({ preventScroll: true });
    previousPage.current = page;
  }, [page]);
  const seek = (n: number) => {
    setTime(n);
    player.current?.seek(n);
  };
  const pick = (i: StudioInterest) => {
    setEditingId(null);
    setSelection({
      interestId: i.id,
      title: i.title,
      startSec: i.startSec ?? Math.max(0, i.markerSec - 15),
      endSec: i.endSec ?? Math.min(project.durationSec, i.markerSec + 15),
    });
    seek(i.startSec ?? i.markerSec);
    if (i.startSec === null)
      setMessage("此标记尚未可靠定位，已打开标记前后 15 秒供你手动试听");
  };
  const add = () => {
    if (!selection) return;
    const old = draft.clips.find((c) => c.id === editingId);
    const clip = resizeClip(project.lines, old, {
      ...selection,
      id: editingId ?? crypto.randomUUID(),
    });
    change((d) => ({
      ...d,
      clips: editingId
        ? d.clips.map((c) => (c.id === editingId ? clip : c))
        : [...d.clips, clip],
    }));
    setReviewId(clip.id);
    setMessage(editingId ? "切片范围已更新" : "已添加到切片输出列表");
    setEditingId(null);
  };
  const editClip = (c: StudioClip) => {
    setEditingId(c.id);
    setSelection({
      interestId: c.interestId,
      title: c.title,
      startSec: c.startSec,
      endSec: c.endSec,
    });
    seek(c.startSec);
  };
  const updateLine = (id: string, patch: Partial<StudioLine>) => {
    if (!activeClip) return;
    if (patch.startSec !== undefined || patch.endSec !== undefined) {
      const line = activeClip.subtitles.find((l) => l.id === id)!;
      const updated = { ...line, ...patch };
      if (
        activeClip.subtitles.some(
          (l) =>
            l.id !== id &&
            l.startSec < updated.endSec - 0.001 &&
            l.endSec > updated.startSec + 0.001,
        )
      ) {
        setError("字幕时间不能与前后句重叠，请先调整相邻句");
        return;
      }
    }
    change((d) => ({
      ...d,
      clips: d.clips.map((c) =>
        c.id === activeClip.id ? editClipLine(c, id, patch) : c,
      ),
    }));
  };
  const realign = async () => {
    if (!activeClip || aligning) return;
    player.current?.pause();
    const snapshot = structuredClone(activeClip),
      controller = new AbortController();
    alignmentController.current = controller;
    setAligning(true);
    setError("");
    setAlignmentProgress({ done: 0, total: 0 });
    const timer = setInterval(() => {
      void api<{ done: number; total: number }>(base + "/alignment")
        .then(setAlignmentProgress)
        .catch(() => {});
    }, 1000);
    try {
      const { lines } = await api<{ lines: StudioLine[] }>(
        base + "/alignment",
        "POST",
        { ...draft, clips: [snapshot] },
        controller.signal,
      );
      const current = latestDraft.current.clips.find(
        (c) => c.id === snapshot.id,
      );
      if (JSON.stringify(current) !== JSON.stringify(snapshot))
        throw new Error("对齐期间此切片已修改，未覆盖你的编辑；请重新运行对齐");
      change((d) => ({
        ...d,
        clips: d.clips.map((c) =>
          c.id === snapshot.id ? replaceClipCaptions(c, lines) : c,
        ),
      }));
      setMessage(`原声对齐完成 · ${lines.length} 条字幕 · 请回听确认`);
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e));
      else setMessage("已取消对齐，保留原字幕");
    } finally {
      clearInterval(timer);
      setAligning(false);
      alignmentController.current = null;
    }
  };
  const moveClip = (id: string, direction: number) =>
    change((d) => {
      const clips = [...d.clips],
        i = clips.findIndex((c) => c.id === id),
        next = i + direction;
      if (next < 0 || next >= clips.length) return d;
      [clips[i], clips[next]] = [clips[next], clips[i]];
      return { ...d, clips };
    });
  const patchSetting = (patch: Partial<StudioDraft["settings"]>) =>
    change((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
  const total = draft.clips.reduce((sum, c) => sum + c.endSec - c.startSec, 0),
    doubtful = draft.clips.reduce(
      (sum, c) =>
        sum + c.subtitles.filter((l) => l.uncertain && !l.reviewed).length,
      0,
    );
  const filtered = project.interests.filter(
    (i) =>
      (filter === "all" ||
        (filter === "manual" ? i.id.startsWith("M") : i.id.startsWith("A"))) &&
      `${i.title} ${i.id} ${i.why}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const exportNow = async () => {
    setExporting(true);
    setError("");
    try {
      const savedDraft = await flush();
      await api(base + "/jobs", "POST", savedDraft);
      setJobs(await api(base + "/jobs"));
      setMessage("导出已开始，可以留在页面查看进度");
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };
  const selectionPreview = useMemo(
    () =>
      selection && editingId
        ? resizeClip(
            project.lines,
            draft.clips.find((c) => c.id === editingId),
            { ...selection, id: editingId },
          ).subtitles
        : undefined,
    [selection, editingId, draft.clips, project.lines],
  );
  const playerView = (
    <Player
      key={`${page}-${page === 1 ? activeClip?.id : "source"}`}
      ref={player}
      project={project}
      ready={preview.status === "ready"}
      initialTime={time}
      clip={page === 1 ? activeClip : undefined}
      linesOverride={page === 0 ? selectionPreview : undefined}
      settings={draft.settings}
      onTime={setTime}
      onEdit={
        page === 1
          ? (l, text) => updateLine(l.id, { text, reviewed: false })
          : undefined
      }
    />
  );
  return (
    <div className="studio-shell">
      <a href="#page-title" className="skip-link">
        跳到工作区
      </a>
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <LuScissors />
          </span>
          <strong>
            HotClip<span>STUDIO</span>
          </strong>
        </a>
        <div className="top-divider" />
        <span className="project-crumb">
          <LuFolderOpen /> 录播工作区 <LuChevronRight /> {project.streamer}
        </span>
        <span className="local-badge">
          <i /> 本地运行
        </span>
        <span className={`save-state ${saveError ? "warning-text" : ""}`}>
          <LuSave />
          {status}
        </span>
      </header>
      <nav className="workflow" aria-label="切片工作流程">
        <ol>
          {steps.map((s, i) => (
            <li key={s.title}>
              <button
                aria-current={page === i ? "step" : undefined}
                className={page === i ? "active" : ""}
                onClick={() => navigate(i)}
              >
                <span className="step-number">0{i + 1}</span>
                <s.icon />
                <span>
                  {s.title}
                  <small>{s.hint}</small>
                </span>
                {i === 1 && draft.clips.length > 0 && (
                  <b>{draft.clips.length}</b>
                )}
              </button>
              {i < 2 && <LuChevronRight className="step-chevron" />}
            </li>
          ))}
        </ol>
      </nav>
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">
              {page === 0
                ? "FIND YOUR MOMENT"
                : page === 1
                  ? "EVERY WORD MATTERS"
                  : "READY TO SHARE"}
            </p>
            <h1 id="page-title" tabIndex={-1} ref={heading}>
              {steps[page].title}
              <span>
                {page === 0
                  ? "把精彩留在时间线上"
                  : page === 1
                    ? "听一句，确认一句"
                    : "让成片恰到好处"}
              </span>
            </h1>
          </div>
          <div className="source-meta">
            <strong>{project.title}</strong>
            <span>
              {timecode(project.durationSec)} · {project.width} ×{" "}
              {project.height} · {project.fps} FPS
            </span>
          </div>
        </div>
        {(error || saveError) && (
          <div className="alert" role="alert">
            <LuCircleAlert />
            <span>{error || saveError}</span>
            <button
              onClick={() => {
                setError("");
                void flush().catch(() => {});
              }}
            >
              重试保存
            </button>
          </div>
        )}
        {preview.status !== "ready" && (
          <div className="preview-progress">
            <span>
              {preview.status === "failed"
                ? `预览准备失败：${preview.error}`
                : "正在为浏览器准备原片预览"}
            </span>
            <progress
              aria-label="原片预览准备"
              max="1"
              value={preview.progress}
            />
            <span>{Math.round(preview.progress * 100)}%</span>
          </div>
        )}
        {page === 0 && (
          <>
            <div className="select-layout">
              <div className="editor-column">
                {playerView}
                <Timeline
                  duration={project.durationSec}
                  time={time}
                  interests={project.interests}
                  selection={selection}
                  onSeek={seek}
                  onSelect={pick}
                  onChange={setSelection}
                />
                <div className="selection-actions">
                  {selection ? (
                    <>
                      <label className="clip-name-label">
                        切片标题
                        <input
                          aria-label="当前切片标题"
                          value={selection.title}
                          maxLength={200}
                          onChange={(e) =>
                            setSelection({
                              ...selection,
                              title: e.target.value,
                            })
                          }
                        />
                      </label>
                      <button
                        className="secondary"
                        onClick={() => {
                          player.current?.playRange(
                            selection.startSec,
                            Math.min(selection.endSec, selection.startSec + 10),
                          );
                        }}
                      >
                        试听入点
                      </button>
                      <button
                        className="secondary"
                        onClick={() =>
                          player.current?.playRange(
                            Math.max(selection.startSec, selection.endSec - 5),
                            selection.endSec,
                          )
                        }
                      >
                        试听结尾
                      </button>
                      <button
                        className="primary"
                        disabled={!selection.title.trim()}
                        onClick={add}
                      >
                        <LuPlus />
                        {editingId ? "更新切片" : "加入输出列表"}
                      </button>
                    </>
                  ) : (
                    <button
                      className="primary"
                      onClick={() =>
                        setSelection({
                          title: "自选片段",
                          startSec: time,
                          endSec: Math.min(project.durationSec, time + 60),
                        })
                      }
                    >
                      新建切片
                    </button>
                  )}
                </div>
              </div>
              <aside className="interest-panel">
                <div className="section-heading">
                  <h2>
                    兴趣点{" "}
                    <span className="count">{project.interests.length}</span>
                  </h2>
                  <LuPanelRight />
                </div>
                <label className="search-box">
                  <LuSearch />
                  <span className="sr-only">搜索兴趣点</span>
                  <input
                    type="search"
                    placeholder="搜索标题、内容或编号"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="filter-tabs" aria-label="兴趣点筛选">
                  {[
                    ["all", "全部"],
                    ["manual", "手动标记"],
                    ["auto", "AI 发现"],
                  ].map(([id, title]) => (
                    <button
                      key={id}
                      aria-pressed={filter === id}
                      className={filter === id ? "active" : ""}
                      onClick={() => setFilter(id)}
                    >
                      {title}
                    </button>
                  ))}
                </div>
                <ol className="interest-list">
                  {filtered.map((i) => (
                    <li key={i.id}>
                      <button
                        className={`interest-card ${selection?.interestId === i.id ? "active" : ""}`}
                        onClick={() => pick(i)}
                      >
                        <div className="interest-meta">
                          <span
                            className={
                              i.id.startsWith("M")
                                ? "manual-label"
                                : "auto-label"
                            }
                          >
                            {i.id.startsWith("M") ? "手动" : "AI"} · {i.id}
                          </span>
                          <time>{timecode(i.startSec ?? i.markerSec)}</time>
                        </div>
                        <strong>{i.title}</strong>
                        <p>{i.why}</p>
                        <footer>
                          <span>
                            {i.startSec !== null
                              ? `${Math.round(i.endSec! - i.startSec)} 秒`
                              : "需手动定位"}
                          </span>
                          {i.needsReview && (
                            <span className="review-label">
                              <LuCircleAlert /> 待听核
                            </span>
                          )}
                          {draft.clips.some((c) => c.interestId === i.id) && (
                            <span className="added-label">
                              <LuCheck /> 已添加
                            </span>
                          )}
                        </footer>
                      </button>
                    </li>
                  ))}
                  {!filtered.length && (
                    <li className="empty-small">没有符合条件的兴趣点</li>
                  )}
                </ol>
              </aside>
            </div>
            {activeInterest && (
              <details className="evidence">
                <summary>查看 {activeInterest.id} 的上下文与待核事项</summary>
                <p>{activeInterest.why}</p>
                <ul>
                  {activeInterest.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
                <p>
                  当前入出点是建议范围，添加前可试听气口与结尾，避免带入下一段游戏剧情。
                </p>
              </details>
            )}
            <section className="output-section">
              <div className="section-heading">
                <h2>
                  切片输出列表{" "}
                  <span className="count">{draft.clips.length}</span>
                </h2>
                <span className="muted">
                  按列表顺序导出 · 总时长 {timecode(total)}
                </span>
              </div>
              <div className="output-layout">
                <div>
                  {draft.clips.length ? (
                    <ol className="queue-list">
                      {draft.clips.map((c, index) => (
                        <li className="queue-row" key={c.id}>
                          <span className="queue-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <button
                            className="thumbnail"
                            onClick={() => editClip(c)}
                            aria-label={`编辑 ${c.title}`}
                          >
                            <img
                              loading="lazy"
                              src={`${base}/thumbnail?time=${c.startSec}`}
                              alt=""
                            />
                            <span>{Math.round(c.endSec - c.startSec)}s</span>
                          </button>
                          <div className="queue-info">
                            <button onClick={() => editClip(c)}>
                              {c.title}
                            </button>
                            <p>
                              {timecode(c.startSec, true)} <span>→</span>{" "}
                              {timecode(c.endSec, true)}
                            </p>
                            <small>
                              {c.subtitles.length} 条字幕 ·{" "}
                              {c.subtitles.filter((l) => l.reviewed).length}{" "}
                              条已核
                            </small>
                          </div>
                          <div className="queue-tools">
                            <button
                              aria-label={`上移 ${c.title}`}
                              disabled={index === 0}
                              onClick={() => moveClip(c.id, -1)}
                            >
                              <LuArrowUp />
                            </button>
                            <button
                              aria-label={`下移 ${c.title}`}
                              disabled={index === draft.clips.length - 1}
                              onClick={() => moveClip(c.id, 1)}
                            >
                              <LuArrowDown />
                            </button>
                            <button
                              aria-label={`移除 ${c.title}`}
                              onClick={() =>
                                change((d) => ({
                                  ...d,
                                  clips: d.clips.filter((x) => x.id !== c.id),
                                }))
                              }
                            >
                              <LuTrash2 />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="empty-queue">
                      <LuFilm />
                      <div>
                        <strong>精彩片段，等你来选</strong>
                        <p>点击右侧兴趣点，调整入出点，再加入输出列表。</p>
                      </div>
                    </div>
                  )}
                </div>
                <aside className="queue-summary">
                  <span className="eyebrow">NEXT STEP</span>
                  <h3>让字幕更准确</h3>
                  <p>在视频上直接改字，对照原始转写，把疑点逐句听清。</p>
                  <button
                    className="primary"
                    disabled={!draft.clips.length}
                    onClick={() => navigate(1)}
                  >
                    审核字幕 <LuChevronRight />
                  </button>
                  <button className="text-button" onClick={() => navigate(2)}>
                    前往导出设置 <LuChevronRight />
                  </button>
                </aside>
              </div>
            </section>
          </>
        )}
        {page === 1 &&
          (activeClip ? (
            <div className="review-layout">
              <aside className="review-clips">
                <div className="section-heading">
                  <h2>
                    待校核 <span className="count">{draft.clips.length}</span>
                  </h2>
                </div>
                <ol>
                  {draft.clips.map((c, index) => (
                    <li key={c.id}>
                      <button
                        className={activeClip.id === c.id ? "active" : ""}
                        onClick={() => {
                          player.current?.pause();
                          setReviewId(c.id);
                          setTime(c.startSec);
                        }}
                      >
                        <div className="review-thumb">
                          <img
                            loading="lazy"
                            src={`${base}/thumbnail?time=${c.startSec}`}
                            alt=""
                          />
                          <span>
                            {index + 1} / {draft.clips.length}
                          </span>
                        </div>
                        <strong>{c.title}</strong>
                        <small>
                          {c.subtitles.filter((l) => l.reviewed).length} /{" "}
                          {c.subtitles.length} 条已核
                        </small>
                        <progress
                          aria-label={`${c.title} 校核进度`}
                          max={Math.max(1, c.subtitles.length)}
                          value={c.subtitles.filter((l) => l.reviewed).length}
                        />
                      </button>
                    </li>
                  ))}
                </ol>
              </aside>
              <div className="review-center">
                {playerView}
                <div className="review-seek">
                  <input
                    type="range"
                    aria-label="切片播放位置"
                    min={activeClip.startSec}
                    max={activeClip.endSec}
                    step=".01"
                    value={Math.max(
                      activeClip.startSec,
                      Math.min(time, activeClip.endSec),
                    )}
                    onChange={(e) => seek(+e.target.value)}
                  />
                  <div className="time-ruler">
                    <span>{timecode(activeClip.startSec)}</span>
                    <span>{timecode(activeClip.endSec)}</span>
                  </div>
                </div>
                <div className="review-tip">
                  <LuCaptions />
                  <div>
                    <strong>点击画面字幕，直接编辑</strong>
                    <p>
                      编辑时自动暂停。右侧可调整时间、回听原声与确认校核；导出字幕会自动去除句读标点。
                    </p>
                  </div>
                </div>
                <div className="review-tip">
                  <div>
                    <strong>按原声停顿重新断句</strong>
                    <p>
                      使用 Qwen
                      字词强制对齐，结合中文词边界组织字幕。修改文字后可再次运行；不会重跑整场识别。
                    </p>
                    <button
                      className="secondary"
                      onClick={() => void realign()}
                      disabled={aligning}
                    >
                      按原声对齐并重新断句
                    </button>
                    {aligning && (
                      <>
                        <progress
                          aria-label="音频字幕对齐进度"
                          max={Math.max(1, alignmentProgress.total)}
                          value={alignmentProgress.done}
                        />
                        <span>
                          {alignmentProgress.total
                            ? `${alignmentProgress.done} / ${alignmentProgress.total} 段`
                            : "正在加载对齐模型"}
                        </span>
                        <button
                          onClick={() => alignmentController.current?.abort()}
                        >
                          取消对齐
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <details className="evidence" open>
                  <summary>切片上下文</summary>
                  <p>
                    {project.interests.find(
                      (i) => i.id === activeClip.interestId,
                    )?.why || "手动选取的片段"}
                  </p>
                  <ul>
                    {project.interests
                      .find((i) => i.id === activeClip.interestId)
                      ?.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                  </ul>
                </details>
                <div className="review-bottom">
                  <button
                    className="secondary"
                    onClick={() => {
                      navigate(0);
                      editClip(activeClip);
                    }}
                  >
                    <LuArrowLeft /> 调整切片范围
                  </button>
                  <button className="primary" onClick={() => navigate(2)}>
                    导出设置 <LuChevronRight />
                  </button>
                </div>
              </div>
              <aside className="subtitle-panel">
                <div className="section-heading">
                  <h2>字幕列表</h2>
                  <span className="muted">
                    {activeClip.subtitles.length} 条
                  </span>
                </div>
                <label className="search-box">
                  <LuSearch />
                  <span className="sr-only">搜索字幕</span>
                  <input
                    type="search"
                    placeholder="搜索字幕内容"
                    value={subSearch}
                    onChange={(e) => setSubSearch(e.target.value)}
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={onlyUncertain}
                    onChange={(e) => setOnlyUncertain(e.target.checked)}
                  />
                  只看待核疑点
                </label>
                <ol className="subtitle-list">
                  {activeClip.subtitles
                    .filter(
                      (l) =>
                        (!onlyUncertain || (l.uncertain && !l.reviewed)) &&
                        `${l.text} ${l.raw}`.includes(subSearch),
                    )
                    .map((l) => (
                      <li
                        key={l.id}
                        className={`subtitle-row ${time >= l.startSec && time < l.endSec ? "current" : ""} ${l.reviewed ? "reviewed" : ""}`}
                      >
                        <div className="subtitle-row-heading">
                          <button
                            className="text-button"
                            onClick={() => seek(l.startSec)}
                          >
                            {timecode(l.startSec, true)}
                          </button>
                          <span>
                            {l.reviewed ? (
                              <>
                                <LuCheck /> 已核
                              </>
                            ) : l.uncertain ? (
                              <>
                                <LuCircleAlert /> 疑点
                              </>
                            ) : (
                              "待核"
                            )}
                          </span>
                        </div>
                        <label>
                          <span className="sr-only">字幕 {l.id}</span>
                          <textarea
                            rows={2}
                            value={l.text}
                            onFocus={() => player.current?.pause()}
                            onChange={(e) =>
                              updateLine(l.id, {
                                text: e.target.value,
                                reviewed: false,
                              })
                            }
                            onBlur={(e) =>
                              updateLine(l.id, {
                                text: stripCaptionPunctuation(e.target.value),
                              })
                            }
                          />
                        </label>
                        <details>
                          <summary>原文与时间</summary>
                          <p className="raw-asr">ASR：{l.raw}</p>
                          <p>
                            {l.boundaryPartial
                              ? "切点位于发音内部，请回听微调"
                              : l.timingStatus === "aligned"
                                ? "音频字词时间已对齐"
                                : l.timingStatus === "manual"
                                  ? "人工调整时间"
                                  : "时间含估算或文字已修改，建议按原声对齐"}
                          </p>
                          {l.correctionReason && (
                            <p className="correction-reason">
                              {l.correctionReason}
                            </p>
                          )}
                          <div className="subtitle-times">
                            <TimeField
                              label="开始"
                              value={l.startSec}
                              max={activeClip.endSec}
                              onCommit={(n) => {
                                if (n < activeClip.startSec || n >= l.endSec) {
                                  setError("字幕开始须在切片内，且早于结束");
                                  return;
                                }
                                updateLine(l.id, {
                                  startSec: n,
                                  reviewed: false,
                                });
                                seek(n);
                              }}
                            />
                            <TimeField
                              label="结束"
                              value={l.endSec}
                              max={activeClip.endSec}
                              onCommit={(n) => {
                                if (n <= l.startSec) {
                                  setError("字幕结束须晚于开始");
                                  return;
                                }
                                updateLine(l.id, {
                                  endSec: n,
                                  reviewed: false,
                                });
                              }}
                            />
                          </div>
                        </details>
                        <div className="subtitle-row-actions">
                          <button
                            onClick={() => {
                              player.current?.playRange(
                                Math.max(activeClip.startSec, l.startSec - 1),
                                Math.min(activeClip.endSec, l.endSec + 1),
                              );
                            }}
                          >
                            回听原声
                          </button>
                          <button
                            className={l.reviewed ? "confirmed" : ""}
                            onClick={() =>
                              updateLine(l.id, {
                                text: stripCaptionPunctuation(l.text),
                                reviewed: !l.reviewed,
                              })
                            }
                          >
                            <LuCheck />
                            {l.reviewed ? "撤销确认" : "确认此句"}
                          </button>
                        </div>
                      </li>
                    ))}
                </ol>
              </aside>
            </div>
          ) : (
            <div className="empty-page">
              <LuCaptions />
              <h2>先选择要校核的片段</h2>
              <p>输出列表里的切片会出现在这里，修改只影响你的切片副本。</p>
              <button className="primary" onClick={() => navigate(0)}>
                去选片段
              </button>
            </div>
          ))}
        {page === 2 && (
          <div className="export-layout">
            <form
              id="export-settings"
              className="export-settings"
              aria-label="导出设置表单"
              onSubmit={(e) => {
                e.preventDefault();
                void exportNow();
              }}
            >
              <section className="settings-card">
                <div className="section-heading">
                  <h2>
                    <LuFilm /> 视频编码
                  </h2>
                  <span className="pill">MP4 · H.264 + AAC</span>
                </div>
                <fieldset>
                  <legend>画质与码率</legend>
                  <div className="quality-grid">
                    {[
                      ["auto", "自动推荐", "CRF 20 · 按画面复杂度分配码率"],
                      ["high", "更高画质", "CRF 17 · 细节优先"],
                      ["small", "更小体积", "CRF 25 · 轻量分享"],
                      ["bitrate", "手动码率", "自定义目标视频码率"],
                    ].map(([value, title, detail]) => (
                      <label
                        className={`quality-option ${draft.settings.quality === value ? "chosen" : ""}`}
                        key={value}
                      >
                        <input
                          type="radio"
                          name="quality"
                          value={value}
                          checked={draft.settings.quality === value}
                          onChange={() =>
                            patchSetting({ quality: value as any })
                          }
                        />
                        <strong>{title}</strong>
                        <span>{detail}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {draft.settings.quality === "bitrate" && (
                  <label className="setting-field">
                    视频码率（Mbps）
                    <input
                      type="number"
                      min=".5"
                      max="50"
                      step=".5"
                      value={draft.settings.bitrateMbps}
                      onChange={(e) =>
                        patchSetting({
                          bitrateMbps: Math.max(
                            0.5,
                            Math.min(50, +e.target.value || 0.5),
                          ),
                        })
                      }
                    />
                  </label>
                )}
                <fieldset>
                  <legend>输出分辨率</legend>
                  <div className="radio-row">
                    {[
                      ["source", `原片 ${project.height}P`],
                      ["1080", "1080P"],
                      ["720", "720P"],
                    ].map(([value, title]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="resolution"
                          checked={draft.settings.resolution === value}
                          onChange={() =>
                            patchSetting({ resolution: value as any })
                          }
                        />
                        {title}
                      </label>
                    ))}
                  </div>
                  <p className="muted">
                    保留原片比例与帧率，不放大低分辨率素材。音频使用 AAC 192
                    kbps。
                  </p>
                </fieldset>
              </section>
              <section className="settings-card">
                <div className="section-heading">
                  <h2>
                    <LuCaptions /> 字幕与直播弹幕
                  </h2>
                </div>
                <label className="setting-toggle">
                  <span>
                    <strong>将字幕压制到画面</strong>
                    <small>使用审核后的文字，自动去除句读标点</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.settings.burnSubtitles}
                    onChange={(e) =>
                      patchSetting({ burnSubtitles: e.target.checked })
                    }
                  />
                </label>
                <label className="setting-toggle">
                  <span>
                    <strong>渲染直播弹幕</strong>
                    <small>滚动弹幕按原片时间同步，避开底部字幕区域</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.settings.burnDanmaku}
                    onChange={(e) =>
                      patchSetting({ burnDanmaku: e.target.checked })
                    }
                  />
                </label>
                <div className="danmaku-settings">
                  <label>
                    弹幕不透明度{" "}
                    <b>{Math.round(draft.settings.danmakuOpacity * 100)}%</b>
                    <input
                      type="range"
                      min=".2"
                      max="1"
                      step=".05"
                      value={draft.settings.danmakuOpacity}
                      onChange={(e) =>
                        patchSetting({ danmakuOpacity: +e.target.value })
                      }
                    />
                  </label>
                  <label>
                    弹幕字号 <b>{draft.settings.danmakuSize}</b>
                    <input
                      type="range"
                      min="20"
                      max="60"
                      step="1"
                      value={draft.settings.danmakuSize}
                      onChange={(e) =>
                        patchSetting({ danmakuSize: +e.target.value })
                      }
                    />
                  </label>
                </div>
                <p className="muted">
                  预览弹幕开关只影响播放器；这里决定是否把弹幕永久压进视频。密集弹幕按轨道容量限流。
                </p>
              </section>
              <section className="settings-card">
                <div className="section-heading">
                  <h2>
                    <LuFolderOpen /> 随片交付
                  </h2>
                  <span className="pill">自动保存</span>
                </div>
                <div className="deliverables">
                  <span>
                    <LuCheck /> MP4 视频
                  </span>
                  <span>
                    <LuCheck /> 无标点 SRT
                  </span>
                  <span>
                    <LuCheck /> 字幕与上下文 CSV
                  </span>
                  <span>
                    <LuCheck /> 上下文 JSON
                  </span>
                </div>
                <p className="output-path">{project.outputDirectory}</p>
              </section>
            </form>
            <aside className="export-summary">
              <div className="settings-card">
                <p className="eyebrow">EXPORT SUMMARY</p>
                <h2>本次导出</h2>
                <div className="summary-number">
                  {draft.clips.length}
                  <span>个片段</span>
                  <i /> {timecode(total)}
                </div>
                <ol className="export-clip-list">
                  {draft.clips.map((c, i) => (
                    <li key={c.id}>
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <strong>{c.title}</strong>
                      <small>{Math.round(c.endSec - c.startSec)}s</small>
                    </li>
                  ))}
                </ol>
                {doubtful > 0 && (
                  <div className="review-warning">
                    <LuCircleAlert />
                    <span>
                      还有 {doubtful} 条疑点字幕未确认，可返回审核后再导出。
                    </span>
                  </div>
                )}
                <button
                  className="primary export-button"
                  disabled={
                    !draft.clips.length ||
                    exporting ||
                    jobs.some((j) => ["queued", "running"].includes(j.status))
                  }
                  type="submit"
                  form="export-settings"
                >
                  <LuDownload />
                  {exporting
                    ? "正在提交…"
                    : `开始导出 ${draft.clips.length} 个片段`}
                </button>
                <button className="text-button" onClick={() => navigate(1)}>
                  <LuArrowLeft /> 返回字幕审核
                </button>
              </div>
              <section className="settings-card jobs">
                <div className="section-heading">
                  <h2>导出任务</h2>
                  <LuRefreshCw />
                </div>
                {!jobs.length && (
                  <p className="muted">
                    开始导出后，在这里查看进度与下载文件。
                  </p>
                )}
                {jobs.map((j) => (
                  <article key={j.id} className="job">
                    <div className="job-head">
                      <strong>
                        {
                          {
                            queued: "排队中",
                            running: "压制中",
                            completed: "已完成",
                            failed: "导出失败",
                            cancelled: "已取消",
                          }[j.status]
                        }
                      </strong>
                      <span>{Math.round(j.progress * 100)}%</span>
                    </div>
                    <progress
                      max="1"
                      value={j.progress}
                      aria-label="导出任务进度"
                    />
                    <p>{j.message}</p>
                    {["running", "queued"].includes(j.status) && (
                      <button
                        className="secondary"
                        onClick={() =>
                          void api(
                            `${base}/jobs/${j.id}/cancel`,
                            "POST",
                            {},
                          ).catch((e) => setError(String(e)))
                        }
                      >
                        <LuX /> 取消任务
                      </button>
                    )}
                    <div className="download-list">
                      {j.files.map((f) => (
                        <a key={f.url} href={f.url} download>
                          <LuDownload />
                          {f.name}
                        </a>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            </aside>
          </div>
        )}
      </main>
      <footer className="app-footer">
        <span>
          HotClip Studio <i /> 本地视频 · 本地处理
        </span>
        <span>
          Qwen ASR <i /> Terra 校核 <i /> Sol 兴趣点分析
        </span>
      </footer>
      <div className={`toast ${message ? "visible" : ""}`} role="status">
        {message && (
          <>
            <LuCheck />
            {message}
            <button aria-label="关闭提示" onClick={() => setMessage("")}>
              <LuX />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
function App() {
  const [project, setProject] = useState<StudioProject | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      const response = await api<{ projects: { id: string }[] }>(
        "/api/projects",
      );
      const id =
        new URLSearchParams(location.search).get("project") ||
        response.projects[0]?.id;
      if (!id) throw new Error("没有已加载的录播项目");
      setProject(await api(`/api/projects/${id}`));
    })().catch((e) => setError(String(e)));
  }, []);
  if (error)
    return (
      <main className="empty-page">
        <LuCircleAlert />
        <h1>工作区暂时无法打开</h1>
        <p>{error}</p>
        <button className="primary" onClick={() => location.reload()}>
          重新连接
        </button>
      </main>
    );
  if (!project)
    return (
      <main className="empty-page">
        <LuScissors />
        <h1>正在打开录播工作区</h1>
        <progress aria-label="载入项目" />
      </main>
    );
  return <Studio key={project.id} project={project} />;
}
createRoot(document.getElementById("root")!).render(<App />);
