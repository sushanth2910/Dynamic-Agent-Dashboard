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

const startAsk = async (query, signal) => {
  const payload = {
    request_from: 'ui',
    query,
    mdl_hash: MDL_HASH,
  };

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

const startChart = async (query, sql, signal) => {
  const payload = {
    request_from: 'ui',
    query,
    sql,
    remove_data_from_chart_schema: false,
    configurations: { language: LANGUAGE },
  };

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

export default function App() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [charts, setCharts] = useState([]);
  const [pinnedCharts, setPinnedCharts] = useState([]);
  const [view, setView] = useState(
    window.location.hash === '#pinned' ? 'pinned' : 'charts',
  );
  const [pinCandidate, setPinCandidate] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const controllerRef = useRef(null);
  const statusTimerRef = useRef(null);

  useEffect(() => {
    const storedCharts = localStorage.getItem(CHARTS_KEY);
    if (storedCharts) {
      try {
        setCharts(JSON.parse(storedCharts));
      } catch {
        setCharts([]);
      }
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

  const persistCharts = (updater) => {
    setCharts((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try {
        localStorage.setItem(CHARTS_KEY, JSON.stringify(next));
      } catch (err) {
        console.warn('Failed to persist charts:', err);
      }
      return next;
    });
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
      const askQueryId = await startAsk(query.trim(), controller.signal);
      const askResult = await pollAskResult(askQueryId, controller.signal);
      const sql = askResult?.response?.[0]?.sql;

      if (!sql) {
        throw new Error('No SQL was returned for this query.');
      }

      setStatus('charting');

      const chartQueryId = await startChart(query.trim(), sql, controller.signal);
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
        query: query.trim(),
        title: extractTitle(spec, query.trim()),
        spec,
        createdAt: new Date().toISOString(),
      };

      persistCharts((prev) => [...prev, chartPayload]);
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

  return (
    <div className="app">
      <div className="topbar">
        <div className="nav">
          <button
            type="button"
            className={`nav-button ${view === 'charts' ? 'active' : ''}`}
            onClick={() => navigate('charts')}
          >
            Charts
          </button>
          <button
            type="button"
            className={`nav-button ${view === 'pinned' ? 'active' : ''}`}
            onClick={() => navigate('pinned')}
          >
            Pinned
          </button>
        </div>
      </div>

      <div className="chart-feed">
        {view === 'charts' && charts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No charts yet.</div>
            <div className="empty-subtitle">
              Ask a question to generate your first chart.
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

        <div className={view === 'pinned' ? 'pinned-grid' : 'chart-list'}>
          {(view === 'charts' ? charts : pinnedCharts).map((item) => {
            const title =
              view === 'pinned'
                ? item.title || extractTitle(item.spec, item.query)
                : item.query;
            return (
            <div
              className={`chart-card ${view === 'pinned' ? 'chart-card--pinned' : ''}`}
              key={item.id}
            >
              <div className="chart-card-header">
                <div className="chart-card-title">
                  <span className="chart-title-pill">{title}</span>
                </div>
                <div className="chart-actions">
                  {view === 'pinned' ? (
                    <button
                      type="button"
                      className="menu-button"
                      onClick={() => requestDelete(item)}
                    >
                      ...
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pin-button"
                      onClick={() => requestPin(item)}
                    >
                      Pin
                    </button>
                  )}
                </div>
              </div>
              <div className="chart-body">
                <ChartView spec={item.spec} onError={handleChartError} />
              </div>
              {view === 'pinned' ? (
                <div className="chart-footer">
                  Last refreshed: {formatTimestamp(item.createdAt)}
                </div>
              ) : null}
            </div>
            );
          })}
        </div>
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
    </div>
  );
}
