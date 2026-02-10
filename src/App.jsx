import { useEffect, useMemo, useRef, useState } from 'react';
import ChartView from './ChartView.jsx';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const MDL_HASH = import.meta.env.VITE_MDL_HASH || 'string';
const LANGUAGE = import.meta.env.VITE_LANGUAGE || 'English';

const ASK_TIMEOUT_MS = 180_000;
const CHART_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const PINNED_KEY = 'wren-ui-lite:pinned-charts';
const CHARTS_KEY = 'wren-ui-lite:chart-history';
const THREADS_KEY = 'wren-ui-lite:threads';
const ACTIVE_THREAD_KEY = 'wren-ui-lite:active-thread';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

const buildUrl = (path) => (API_BASE ? `${API_BASE}${path}` : path);

const postJson = async (url, body, signal) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }

  return response.json();
};

const getJson = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }
  return response.json();
};

const startAsk = async (query, threadId, histories, signal) => {
  const payload = {
    request_from: 'ui',
    query,
    mdl_hash: MDL_HASH,
  };
  if (threadId) {
    payload.thread_id = threadId;
  }
  if (histories && histories.length) {
    payload.histories = histories;
  }

  const data = await postJson(buildUrl('/v1/asks'), payload, signal);
  if (!data?.query_id) {
    throw new Error('Ask request did not return a query id.');
  }
  return data.query_id;
};

const pollAskResult = async (queryId, signal) => {
  const deadline = Date.now() + ASK_TIMEOUT_MS;

  while (true) {
    const result = await getJson(
      buildUrl(`/v1/asks/${queryId}/result`),
      signal,
    );

    if (result.status === 'finished') {
      return result;
    }

    if (result.status === 'failed' || result.status === 'stopped') {
      throw new Error(result.error?.message || 'Ask failed.');
    }

    if (Date.now() > deadline) {
      throw new Error('Ask timed out.');
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }
};

const startChart = async (query, sql, threadId, signal) => {
  const payload = {
    request_from: 'ui',
    query,
    sql,
    remove_data_from_chart_schema: false,
    configurations: { language: LANGUAGE },
  };
  if (threadId) {
    payload.thread_id = threadId;
  }

  const data = await postJson(buildUrl('/v1/charts'), payload, signal);
  if (!data?.query_id) {
    throw new Error('Chart request did not return a query id.');
  }
  return data.query_id;
};

const pollChartResult = async (queryId, signal) => {
  const deadline = Date.now() + CHART_TIMEOUT_MS;

  while (true) {
    const result = await getJson(buildUrl(`/v1/charts/${queryId}`), signal);

    if (result.status === 'finished') {
      return result;
    }

    if (result.status === 'failed' || result.status === 'stopped') {
      throw new Error(result.error?.message || 'Chart generation failed.');
    }

    if (Date.now() > deadline) {
      throw new Error('Chart generation timed out.');
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }
};

const formatTimestamp = (value) => {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
};

const extractTitle = (spec, fallback) => {
  if (!spec || !spec.title) {
    return fallback;
  }
  if (typeof spec.title === 'string') {
    return spec.title;
  }
  if (typeof spec.title === 'object' && spec.title.text) {
    if (Array.isArray(spec.title.text)) {
      return spec.title.text.join(' ');
    }
    return spec.title.text;
  }
  return fallback;
};

const normalizeThread = (thread) => ({
  ...thread,
  pinned: Boolean(thread?.pinned),
  charts: Array.isArray(thread?.charts) ? thread.charts : [],
});

export default function App() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [pinnedCharts, setPinnedCharts] = useState([]);
  const [view, setView] = useState(
    window.location.hash === '#pinned' ? 'pinned' : 'charts',
  );
  const [pinCandidate, setPinCandidate] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [isThreadSidebarMinimized, setIsThreadSidebarMinimized] = useState(false);
  const [threadMenuOpenId, setThreadMenuOpenId] = useState(null);
  const [renameThreadId, setRenameThreadId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteThreadId, setDeleteThreadId] = useState(null);
  const controllerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const sidebarWidth = isThreadSidebarMinimized ? '56px' : '240px';

  useEffect(() => {
    const storedThreads = localStorage.getItem(THREADS_KEY);
    if (storedThreads) {
      try {
        const parsed = JSON.parse(storedThreads);
        if (Array.isArray(parsed)) {
          setThreads(parsed.map(normalizeThread));
        } else {
          setThreads([]);
        }
      } catch {
        setThreads([]);
      }
    } else {
      const storedCharts = localStorage.getItem(CHARTS_KEY);
      if (storedCharts) {
        try {
          const legacyCharts = JSON.parse(storedCharts);
          if (Array.isArray(legacyCharts) && legacyCharts.length) {
            const migratedThread = {
              id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
              title: legacyCharts[0]?.query || 'Thread',
              createdAt: legacyCharts[0]?.createdAt || new Date().toISOString(),
              pinned: false,
              charts: legacyCharts,
            };
            setThreads([migratedThread]);
            localStorage.setItem(THREADS_KEY, JSON.stringify([migratedThread]));
          }
        } catch {
          setThreads([]);
        }
      }
    }

    const storedActive = localStorage.getItem(ACTIVE_THREAD_KEY);
    if (storedActive) {
      setActiveThreadId(storedActive);
    }

    const stored = localStorage.getItem(PINNED_KEY);
    if (stored) {
      try {
        setPinnedCharts(JSON.parse(stored));
      } catch {
        setPinnedCharts([]);
      }
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      setView(window.location.hash === '#pinned' ? 'pinned' : 'charts');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (activeThreadId && !threads.find((thread) => thread.id === activeThreadId)) {
      persistActiveThread(null);
    }
  }, [threads, activeThreadId]);

  useEffect(() => {
    if (!activeThreadId && threads.length > 0) {
      persistActiveThread(threads[0].id);
    }
  }, [threads, activeThreadId]);

  useEffect(() => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }

    if (status === 'done') {
      statusTimerRef.current = setTimeout(() => {
        setStatus('idle');
      }, 2000);
    }

    return () => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };
  }, [status]);

  const statusLabel = useMemo(() => {
    if (status === 'asking') return 'Understanding your question...';
    if (status === 'charting') return 'Generating chart...';
    if (status === 'done') return 'Chart ready.';
    return '';
  }, [status]);

  const persistPinnedCharts = (next) => {
    setPinnedCharts(next);
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(next));
    } catch (err) {
      console.warn('Failed to persist pinned charts:', err);
    }
  };

  const persistThreads = (updater) => {
    setThreads((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try {
        localStorage.setItem(THREADS_KEY, JSON.stringify(next));
      } catch (err) {
        console.warn('Failed to persist threads:', err);
      }
      return next;
    });
  };

  const persistActiveThread = (threadId) => {
    setActiveThreadId(threadId);
    if (threadId) {
      localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
    } else {
      localStorage.removeItem(ACTIVE_THREAD_KEY);
    }
  };

  const navigate = (nextView) => {
    setView(nextView);
    window.location.hash = nextView === 'pinned' ? '#pinned' : '#charts';
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!query.trim()) {
      return;
    }

    if (controllerRef.current) {
      controllerRef.current.abort();
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    setError('');
    setStatus('asking');

    try {
      const threadId =
        activeThreadId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`);
      const isNewThread = !activeThreadId;
      const currentThread = threads.find((thread) => thread.id === threadId);
      const histories = currentThread
        ? currentThread.charts
            .filter((chart) => chart.sql)
            .map((chart) => ({ question: chart.query, sql: chart.sql }))
        : [];
      const askQueryId = await startAsk(
        query.trim(),
        threadId,
        histories,
        controller.signal,
      );
      const askResult = await pollAskResult(askQueryId, controller.signal);
      const sql = askResult?.response?.[0]?.sql;

      if (!sql) {
        throw new Error('No SQL was returned for this query.');
      }

      setStatus('charting');

      const chartQueryId = await startChart(
        query.trim(),
        sql,
        threadId,
        controller.signal,
      );
      const chartResult = await pollChartResult(
        chartQueryId,
        controller.signal,
      );
      const spec = chartResult?.response?.chart_schema;

      if (!spec) {
        throw new Error('Chart was not generated.');
      }

      const chartPayload = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
        threadId,
        query: query.trim(),
        title: extractTitle(spec, query.trim()),
        sql,
        spec,
        createdAt: new Date().toISOString(),
      };

      persistThreads((prev) => {
        const next = [...prev];
        const threadIndex = next.findIndex((thread) => thread.id === threadId);
        if (threadIndex === -1) {
          next.push({
            id: threadId,
            title: query.trim(),
            createdAt: new Date().toISOString(),
            pinned: false,
            charts: [chartPayload],
          });
        } else {
          const thread = next[threadIndex];
          next[threadIndex] = {
            ...thread,
            title:
              thread.title === 'New thread' && thread.charts.length === 0
                ? query.trim()
                : thread.title,
            charts: [...thread.charts, chartPayload],
          };
        }
        return next;
      });
      if (isNewThread) {
        persistActiveThread(threadId);
      }
      setQuery('');
      setStatus('done');
    } catch (err) {
      if (err?.name === 'AbortError') {
        return;
      }
      setError(err?.message || 'Something went wrong.');
      setStatus('error');
    }
  };

  const handleChartError = (err) => {
    setError(err?.message || 'Unable to render chart.');
  };

  const handlePin = (chart) => {
    const exists = pinnedCharts.some((item) => item.id === chart.id);
    if (exists) {
      return;
    }

    const next = [...pinnedCharts, chart];
    persistPinnedCharts(next);
  };

  const handleUnpin = (chartId) => {
    const next = pinnedCharts.filter((item) => item.id !== chartId);
    persistPinnedCharts(next);
  };

  const requestPin = (chart) => {
    setPinCandidate(chart);
  };

  const confirmPin = () => {
    if (pinCandidate) {
      handlePin(pinCandidate);
    }
    setPinCandidate(null);
  };

  const cancelPin = () => {
    setPinCandidate(null);
  };

  const startNewThread = () => {
    const newId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
    persistThreads((prev) => [
      {
        id: newId,
        title: 'New thread',
        createdAt: new Date().toISOString(),
        pinned: false,
        charts: [],
      },
      ...prev,
    ]);
    persistActiveThread(newId);
  };

  const selectThread = (threadId) => {
    persistActiveThread(threadId);
  };

  const requestDelete = (chart) => {
    setDeleteCandidate(chart);
  };

  const confirmDelete = () => {
    if (deleteCandidate) {
      handleUnpin(deleteCandidate.id);
    }
    setDeleteCandidate(null);
  };

  const cancelDelete = () => {
    setDeleteCandidate(null);
  };

  const toggleThreadMenu = (threadId) => {
    setThreadMenuOpenId((prev) => (prev === threadId ? null : threadId));
  };

  const closeThreadMenu = () => {
    setThreadMenuOpenId(null);
  };

  const startRenameThread = (thread) => {
    setRenameThreadId(thread.id);
    setRenameValue(thread.title);
    closeThreadMenu();
  };

  const confirmRenameThread = () => {
    if (!renameThreadId) {
      return;
    }
    const nextTitle = renameValue.trim();
    if (!nextTitle) {
      return;
    }
    persistThreads((prev) =>
      prev.map((thread) =>
        thread.id === renameThreadId ? { ...thread, title: nextTitle } : thread,
      ),
    );
    setRenameThreadId(null);
    setRenameValue('');
  };

  const cancelRenameThread = () => {
    setRenameThreadId(null);
    setRenameValue('');
  };

  const reorderThreads = (list, prioritizeId = null) => {
    const pinned = [];
    const unpinned = [];
    list.forEach((thread) => {
      if (thread.pinned) {
        pinned.push(thread);
      } else {
        unpinned.push(thread);
      }
    });
    if (prioritizeId) {
      const idx = pinned.findIndex((thread) => thread.id === prioritizeId);
      if (idx > 0) {
        const [thread] = pinned.splice(idx, 1);
        pinned.unshift(thread);
      }
    }
    return [...pinned, ...unpinned];
  };

  const pinThreadToTop = (threadId) => {
    persistThreads((prev) =>
      reorderThreads(
        prev.map((thread) =>
          thread.id === threadId ? { ...thread, pinned: true } : thread,
        ),
        threadId,
      ),
    );
    closeThreadMenu();
  };

  const unpinThread = (threadId) => {
    persistThreads((prev) =>
      reorderThreads(
        prev.map((thread) =>
          thread.id === threadId ? { ...thread, pinned: false } : thread,
        ),
      ),
    );
    closeThreadMenu();
  };

  const requestDeleteThread = (threadId) => {
    setDeleteThreadId(threadId);
    closeThreadMenu();
  };

  const confirmDeleteThread = () => {
    if (!deleteThreadId) {
      return;
    }
    persistThreads((prev) => prev.filter((thread) => thread.id !== deleteThreadId));
    if (activeThreadId === deleteThreadId) {
      persistActiveThread(null);
    }
    setDeleteThreadId(null);
  };

  const cancelDeleteThread = () => {
    setDeleteThreadId(null);
  };

  return (
    <div className="app" style={{ '--sidebar-width': sidebarWidth }}>
      <div className="sidebar-fixed-header">
        <button
          type="button"
          className="sidebar-action"
          onClick={() => navigate(view === 'charts' ? 'pinned' : 'charts')}
        >
          {view === 'charts' ? 'Dashboard' : 'Chat'}
        </button>
      </div>
      <div className="layout">
        <main className="main">
          <div className="chart-feed">
            {view === 'charts' && threads.length === 0 ? (
              <div className="empty-state">
                <div className="empty-title">No charts yet.</div>
                <div className="empty-subtitle">
                  Ask a question to generate your first chart.
                </div>
              </div>
            ) : null}

            {view === 'charts' &&
            threads.length > 0 &&
            !(threads.find((thread) => thread.id === activeThreadId)?.charts || [])
              .length ? (
              <div className="empty-state">
                <div className="empty-title">Start this thread.</div>
                <div className="empty-subtitle">
                  Ask a question to create the first chart in this thread.
                </div>
              </div>
            ) : null}

            {view === 'pinned' && pinnedCharts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-title">No pinned charts.</div>
                <div className="empty-subtitle">
                  Pin a chart to see it here.
                </div>
              </div>
            ) : null}

            {view === 'charts' ? (
              <div className="thread-section">
                {(threads.find((thread) => thread.id === activeThreadId)?.charts ||
                  []).map((item) => (
                  <div className="chart-card" key={item.id}>
                    <div className="chart-card-header">
                      <div className="chart-card-title">
                        <span className="chart-title-pill">{item.query}</span>
                      </div>
                      <div className="chart-actions">
                        <button
                          type="button"
                          className="pin-button"
                          onClick={() => requestPin(item)}
                        >
                          Pin
                        </button>
                      </div>
                    </div>
                    <div className="chart-body">
                      <ChartView spec={item.spec} onError={handleChartError} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pinned-grid">
                {pinnedCharts.map((item) => {
                  const title = item.title || extractTitle(item.spec, item.query);
                  return (
                    <div className="chart-card chart-card--pinned" key={item.id}>
                      <div className="chart-card-header">
                        <div className="chart-card-title">
                          <span className="chart-title-pill">{title}</span>
                        </div>
                        <div className="chart-actions">
                          <button
                            type="button"
                            className="menu-button"
                            onClick={() => requestDelete(item)}
                          >
                            ...
                          </button>
                        </div>
                      </div>
                      <div className="chart-body">
                        <ChartView spec={item.spec} onError={handleChartError} />
                      </div>
                      <div className="chart-footer">
                        Last refreshed: {formatTimestamp(item.createdAt)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>

        {view === 'charts' ? (
          <aside
            className={`sidebar sidebar--right ${
              isThreadSidebarMinimized ? 'minimized' : ''
            }`}
          >
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setIsThreadSidebarMinimized((prev) => !prev)}
            >
              {isThreadSidebarMinimized ? '<' : '>'}
            </button>
            {!isThreadSidebarMinimized ? (
              <div className="sidebar-content">
                <div className="sidebar-title">Threads</div>
                <button
                  type="button"
                  className="thread-button"
                  onClick={startNewThread}
                >
                  New Chat
                </button>
                <div className="thread-list">
                  {threads.map((thread) => (
                    <div
                      key={thread.id}
                      className={`thread-item ${
                        activeThreadId === thread.id ? 'active' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="thread-item-button"
                        onClick={() => selectThread(thread.id)}
                      >
                        <span className="thread-item-label">{thread.title}</span>
                        {thread.pinned ? (
                          <span className="thread-pin-icon" aria-label="Pinned">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path
                                d="M14 3c1.1 0 2 .9 2 2v4l3 3v2h-6v6l-1 2-1-2v-6H5v-2l3-3V5c0-1.1.9-2 2-2h4z"
                                fill="currentColor"
                              />
                            </svg>
                          </span>
                        ) : null}
                      </button>
                      <div className="thread-item-actions">
                        <button
                          type="button"
                          className="menu-button"
                          onClick={() => toggleThreadMenu(thread.id)}
                        >
                          ...
                        </button>
                        {threadMenuOpenId === thread.id ? (
                          <div className="thread-menu">
                            <button
                              type="button"
                              onClick={() => startRenameThread(thread)}
                            >
                              Rename
                            </button>
                            {thread.pinned ? (
                              <button
                                type="button"
                                onClick={() => unpinThread(thread.id)}
                              >
                                Unpin from top
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => pinThreadToTop(thread.id)}
                              >
                                Pin to top
                              </button>
                            )}
                            <button
                              type="button"
                              className="danger"
                              onClick={() => requestDeleteThread(thread.id)}
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      {view === 'charts' ? (
        <div className="dock">
          <form className="query-bar" onSubmit={handleSubmit}>
            <input
              type="text"
              placeholder="Ask a question about your data..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Query"
            />
            <button type="submit" disabled={status === 'asking' || status === 'charting'}>
              Generate
            </button>
          </form>
          {statusLabel ? <div className="status">{statusLabel}</div> : null}
          {error ? <div className="error">{error}</div> : null}
        </div>
      ) : null}

      {pinCandidate ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-icon">!</div>
            <div className="modal-content">
              <div className="modal-title">
                Are you sure you want to pin this chart to the dashboard?
              </div>
              <div className="modal-actions">
                <button type="button" className="modal-button" onClick={cancelPin}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-button modal-button--primary"
                  onClick={confirmPin}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deleteCandidate ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-icon">!</div>
            <div className="modal-content">
              <div className="modal-title">
                Are you sure you want to delete this chart from the dashboard?
              </div>
              <div className="modal-actions">
                <button type="button" className="modal-button" onClick={cancelDelete}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-button modal-button--primary"
                  onClick={confirmDelete}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {renameThreadId ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-icon">!</div>
            <div className="modal-content">
              <div className="modal-title">Rename thread</div>
              <input
                className="modal-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                placeholder="Thread name"
              />
              <div className="modal-actions">
                <button type="button" className="modal-button" onClick={cancelRenameThread}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-button modal-button--primary"
                  onClick={confirmRenameThread}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deleteThreadId ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-icon">!</div>
            <div className="modal-content">
              <div className="modal-title">
                Are you sure you want to delete this thread?
              </div>
              <div className="modal-actions">
                <button type="button" className="modal-button" onClick={cancelDeleteThread}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-button modal-button--primary"
                  onClick={confirmDeleteThread}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
