import { useEffect, useRef } from 'react';
import embed from 'vega-embed';

const normalizeSpec = (input) => {
  if (!input) {
    return null;
  }

  let parsed = input;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const schema = typeof parsed.$schema === 'string' ? parsed.$schema : '';
  const isVegaLite = schema.includes('vega-lite');
  const isVega = schema.includes('vega') && !isVegaLite;
  const hasVegaLiteMarks =
    parsed.mark ||
    parsed.layer ||
    parsed.facet ||
    parsed.hconcat ||
    parsed.vconcat ||
    parsed.concat ||
    parsed.repeat;

  if (!isVega && !isVegaLite && !hasVegaLiteMarks) {
    return null;
  }

  if (isVegaLite || hasVegaLiteMarks) {
    const specToRender = {
      ...parsed,
      config: {
        ...(parsed.config || {}),
        mark: {
          ...(parsed.config?.mark || {}),
          tooltip: true,
        },
      },
    };
    if (specToRender.title) {
      delete specToRender.title;
    }
    return { spec: specToRender, mode: 'vega-lite' };
  }

  const vegaSpec = { ...parsed };
  if (vegaSpec.title) {
    delete vegaSpec.title;
  }
  return { spec: vegaSpec, mode: 'vega' };
};

export default function ChartView({ spec, onError }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!spec || !containerRef.current) {
      return undefined;
    }

    let view;
    let cancelled = false;
    const normalized = normalizeSpec(spec);
    if (!normalized) {
      if (onError) {
        onError(new Error('Invalid chart specification.'));
      }
      return undefined;
    }

    embed(containerRef.current, normalized.spec, {
      actions: false,
      mode: normalized.mode,
      renderer: 'svg',
      tooltip: { theme: 'light' },
    })
      .then((result) => {
        if (cancelled) {
          result.view.finalize();
          return;
        }
        view = result.view;
      })
      .catch((error) => {
        if (onError) {
          onError(error);
        }
      });

    return () => {
      cancelled = true;
      if (view) {
        view.finalize();
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [spec, onError]);

  return <div className="chart" ref={containerRef} />;
}
