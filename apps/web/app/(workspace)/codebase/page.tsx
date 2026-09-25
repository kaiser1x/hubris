"use client";

import { useEffect, useMemo, useState } from "react";
import { LAYERS, NODES, REPO, type TwinNode } from "../../lib/casefile";
import { fetchLatestJob, liveRepoName, twinToNodes } from "../../lib/live-twin";

function NodeRow({
  node,
  active,
  onSelect,
}: {
  node: TwinNode;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      className={`w-full text-left border-l-2 pl-3 py-2 transition-colors focus:outline-none ${
        active
          ? "border-[#0A0A0A] bg-black/[0.03]"
          : "border-[#dedada] hover:border-[#0A0A0A]"
      }`}
    >
      <span className="block text-sm font-medium">{node.label}</span>
      <span className="block font-mono text-xs text-[#7A7171] mt-0.5 truncate">
        {node.kind} · {node.file}
      </span>
    </button>
  );
}

interface RepoInfo {
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  language: string | null;
  url: string;
  stars: number;
}

export default function CodebasePage() {
  const [selectedId, setSelectedId] = useState("service");
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [liveNodes, setLiveNodes] = useState<TwinNode[] | null>(null);
  const [liveName, setLiveName] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchLatestJob().then((job) => {
      if (!cancelled && job) {
        const nodes = twinToNodes(job);
        if (nodes.length > 0) {
          setLiveNodes(nodes);
          setLiveName(liveRepoName(job));
          setSelectedId((current) =>
            nodes.some((n) => n.id === current) ? current : nodes[0].id
          );
        }
      }
      if (!cancelled) setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const nodes = liveNodes ?? NODES;

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? nodes[0],
    [nodes, selectedId]
  );

  const byLayer = useMemo(() => {
    const map = new Map<string, TwinNode[]>();
    for (const layer of LAYERS) map.set(layer, []);
    for (const n of nodes) map.get(n.layer)?.push(n);
    return map;
  }, [nodes]);

  if (!checked) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Codebase</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">
          Loading twin…
        </p>
      </div>
    );
  }

  async function syncRepo() {
    const value = input.trim();
    if (!value || loading) return;
    if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
      setRepoError("Use owner/repo format, e.g. octocat/Hello-World.");
      setRepoInfo(null);
      return;
    }
    setLoading(true);
    setRepoError(null);
    try {
      const res = await fetch(`/api/analyze?repo=${encodeURIComponent(value)}`);
      const data = await res.json();
      if (!res.ok) {
        setRepoError(data.error ?? "Lookup failed.");
        setRepoInfo(null);
      } else {
        setRepoInfo(data.repository);
      }
    } catch {
      setRepoError("Analysis service unreachable. Is the API running?");
      setRepoInfo(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Codebase</p>
      <div className="flex flex-col sm:flex-row sm:items-end gap-4 mt-4">
        <div className="min-w-0">
          <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] truncate">
            {repoInfo?.name ?? liveName ?? REPO.name}
          </h1>
          <p className="font-mono text-[13px] text-[#7A7171] mt-3">
            {repoInfo
              ? `${repoInfo.owner} · ${repoInfo.language ?? "unknown language"} · ${repoInfo.stars} stars`
              : liveNodes
                ? `${liveNodes.length} components · live twin · ${liveName}`
                : `${nodes.length} components · deterministic twin · ${REPO.branch}`}
          </p>
          {repoInfo?.description && (
            <p className="text-sm text-[#7A7171] mt-1 max-w-xl">
              {repoInfo.description}
            </p>
          )}
          {repoError && (
            <p role="alert" className="font-mono text-xs text-[#0A0A0A] mt-2 underline underline-offset-4 decoration-[#dedada]">
              {repoError}
            </p>
          )}
        </div>
        <form
          className="flex gap-2 sm:ml-auto shrink-0"
          onSubmit={(e) => {
            e.preventDefault();
            syncRepo();
          }}
        >
          <input
            type="text"
            aria-label="GitHub repository in owner/repo format"
            placeholder="owner/repo"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            spellCheck={false}
            className="w-44 bg-white border border-[#dedada] px-2.5 py-3 font-mono text-[13px] placeholder:text-[#7A7171] focus:outline-none focus:border-[#0A0A0A] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3 hover:bg-black active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {loading ? "SYNCING..." : "SYNC ↗"}
          </button>
        </form>
      </div>
      {liveNodes ? (
        <p className="font-mono text-[11px] text-[#0A0A0A] mt-3">
          ● LIVE TWIN — rendered from the latest completed analysis.
        </p>
      ) : (
        !repoInfo &&
        !repoError && (
          <p className="font-mono text-[11px] text-[#7A7171] mt-3">
            Twin below is the demo ledger. Paste a repo to look up its real
            metadata; full clone-and-parse ingestion lands with the sandbox.
          </p>
        )
      )}

      <div className="grid gap-12 mt-10 lg:grid-cols-[1fr_280px]">
        <div>
          <div className="grid gap-6 grid-cols-2 md:grid-cols-5">
            {LAYERS.map((layer) => (
              <div key={layer}>
                <p className="kicker mb-2">{layer}</p>
                <div className="space-y-1">
                  {(byLayer.get(layer) ?? []).map((n) => (
                    <NodeRow
                      key={n.id}
                      node={n}
                      active={selectedId === n.id}
                      onSelect={() => setSelectedId(n.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10">
            <p className="kicker">Blast radius · {selected.label}</p>
            <div className="grid sm:grid-cols-4 gap-6 mt-3 max-w-2xl">
              {(
                [
                  ["API routes", selected.impact.routes],
                  ["Functions", selected.impact.functions],
                  ["Tests", selected.impact.tests],
                  ["Files", selected.impact.files],
                ] as [string, number][]
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="border-t border-[#dedada] pt-2.5"
                >
                  <p className="font-display text-[30px] leading-none">
                    {value}
                  </p>
                  <p className="font-mono text-[10px] text-[#7A7171] mt-1.5">
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="border-t lg:border-t-0 lg:border-l border-[#dedada] pt-5 lg:pt-0 lg:pl-6 h-fit">
          <p className="kicker">Selected</p>
          <h3 className="text-[15px] font-semibold mt-2">{selected.label}</h3>
          <p className="font-mono text-xs text-[#7A7171] mt-0.5 break-all">
            {selected.file}
          </p>
          <div className="mt-5 space-y-4 text-[13px]">
            <div>
              <p className="kicker mb-1">Callers</p>
              {selected.callers.map((c) => (
                <p key={c} className="font-mono text-xs py-0.5">
                  {c}
                </p>
              ))}
            </div>
            <div>
              <p className="kicker mb-1">Depends on</p>
              {selected.deps.length === 0 ? (
                <p className="text-xs text-[#7A7171]">Nothing. Leaf node.</p>
              ) : (
                selected.deps.map((d) => (
                  <p key={d} className="font-mono text-xs py-0.5">
                    {d}
                  </p>
                ))
              )}
            </div>
            <div>
              <p className="kicker mb-1">Covered by</p>
              {selected.tests.map((t) => (
                <p key={t} className="font-mono text-xs py-0.5">
                  {t}
                </p>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
