import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Source } from '../shared/types';

export function Answer({
  text,
  sources,
  onSource,
}: {
  text: string;
  sources: Source[];
  onSource: (source: Source) => void;
}) {
  const sourceMap = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const linked = text.replace(/\[(S\d+)\](?:\([^\s)]*\))?/g, (_match, id: string) =>
    sourceMap.has(id) ? `[${id}](#evidence-${id})` : `[${id}]`,
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const id = href?.startsWith('#evidence-') ? href.slice(10) : null;
            const source = id ? sourceMap.get(id) : null;
            if (source)
              return (
                <button
                  className="citation"
                  onClick={() => onSource(source)}
                  title={source.title}
                  aria-label={`Open source ${source.id}: ${source.title}`}
                >
                  {source.id.slice(1)}
                </button>
              );
            if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          img: () => null, // Never load model-controlled tracking pixels or remote images.
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {linked}
      </ReactMarkdown>
    </div>
  );
}
