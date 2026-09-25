"use client";

import { useEffect, useRef } from "react";

// Deterministic PRNG so the graph is stable between renders.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Node {
  x: number;
  y: number;
  r: number;
  a: number;
}

/**
 * LivingTwin: an abstract dependency graph breathing behind the hero.
 * Monochrome, low opacity, slow cycles. Static single frame when the user
 * prefers reduced motion.
 */
export default function LivingTwin({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rand = mulberry32(20260924);
    let w = 0;
    let h = 0;
    let raf = 0;
    let nodes: Node[] = [];
    let edges: [number, number][] = [];
    let path: number[] = [];
    const mouse = { x: -9999, y: -9999 };
    let pulseNode = -1;
    let pulseT0 = 0;
    let nextPulse = 2500;

    function build() {
      const rect = canvas!.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.max(20, Math.min(44, Math.floor((w * h) / 24000)));
      nodes = Array.from({ length: count }, () => ({
        // Irregular: jittered grid placement reads as architecture, not decoration.
        x: (rand() * 0.94 + 0.03) * w,
        y: (rand() * 0.9 + 0.05) * h,
        r: 1 + rand() * 0.9,
        a: 0.08 + rand() * 0.12,
      }));

      // Wire each node to its nearest neighbor; a few get a second link.
      edges = [];
      const seen = new Set<string>();
      nodes.forEach((n, i) => {
        let best = -1;
        let bestD = Infinity;
        nodes.forEach((m, j) => {
          if (i === j) return;
          const d = (n.x - m.x) ** 2 + (n.y - m.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        });
        if (best >= 0 && bestD < 230 ** 2) {
          const key = [Math.min(i, best), Math.max(i, best)].join(":");
          if (!seen.has(key)) {
            seen.add(key);
            edges.push([i, best]);
          }
        }
      });

      // Execution path: six nodes ordered left to right through the middle band.
      const band = nodes
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => n.y > h * 0.25 && n.y < h * 0.8)
        .sort((a, b) => a.n.x - b.n.x);
      path = [];
      const step = Math.max(1, Math.floor(band.length / 6));
      for (let k = 0; k < band.length && path.length < 6; k += step) {
        path.push(band[k].i);
      }
    }

    function pointOnPath(t: number): { x: number; y: number } {
      const segs = path.length - 1;
      const f = Math.min(0.9999, Math.max(0, t)) * segs;
      const i = Math.floor(f);
      const a = nodes[path[i]];
      const b = nodes[path[Math.min(i + 1, segs)]];
      const k = f - i;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }

    function draw(now: number) {
      ctx!.clearRect(0, 0, w, h);

      // Scan sweep: a faint band crossing the left third, ~14s cycle.
      const scanX = ((now / 14000) % 1) * w * 0.45;
      const grad = ctx!.createLinearGradient(scanX - 50, 0, scanX + 50, 0);
      grad.addColorStop(0, "rgba(10,10,10,0)");
      grad.addColorStop(0.5, "rgba(10,10,10,0.035)");
      grad.addColorStop(1, "rgba(10,10,10,0)");
      ctx!.fillStyle = grad;
      ctx!.fillRect(scanX - 50, 0, 100, h);

      const onPath = new Set(path);
      for (const [i, j] of edges) {
        const a = nodes[i];
        const b = nodes[j];
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const nearMouse =
          Math.hypot(midX - mouse.x, midY - mouse.y) < 130 ? 0.05 : 0;
        const base = onPath.has(i) && onPath.has(j) ? 0.09 : 0.045;
        ctx!.strokeStyle = `rgba(10,10,10,${base + nearMouse})`;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }

      // Traveler: one request crossing the path every ~9s.
      const p = pointOnPath((now / 9000) % 1);
      ctx!.fillStyle = "rgba(10,10,10,0.32)";
      ctx!.beginPath();
      ctx!.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx!.fill();

      // Pulse: one node breathes every few seconds.
      if (now >= nextPulse) {
        pulseNode = Math.floor(rand() * nodes.length);
        pulseT0 = now;
        nextPulse = now + 2800 + rand() * 2400;
      }
      const pulseK =
        pulseNode >= 0
          ? Math.max(0, 1 - (now - pulseT0) / 1300)
          : 0;

      nodes.forEach((n, i) => {
        const dx = n.x - mouse.x;
        const dy = n.y - mouse.y;
        const d = Math.hypot(dx, dy);
        // Subconscious reaction: drift at most ~2px away from the cursor.
        const push = d < 110 && d > 0.01 ? Math.min(2.2, (110 - d) * 0.02) : 0;
        const ox = d > 0.01 ? (dx / d) * push : 0;
        const oy = d > 0.01 ? (dy / d) * push : 0;
        const isPulsing = i === pulseNode ? pulseK : 0;
        ctx!.fillStyle = `rgba(10,10,10,${Math.min(0.5, n.a + isPulsing * 0.22)})`;
        ctx!.beginPath();
        ctx!.arc(n.x + ox, n.y + oy, n.r + isPulsing * 1.1, 0, Math.PI * 2);
        ctx!.fill();
      });
    }

    function frame(now: number) {
      draw(now);
      raf = requestAnimationFrame(frame);
    }

    function onMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    }

    function onLeave() {
      mouse.x = -9999;
      mouse.y = -9999;
    }

    const ro = new ResizeObserver(() => build());
    build();
    if (reduceMotion) {
      draw(4000);
    } else {
      raf = requestAnimationFrame(frame);
    }
    ro.observe(canvas);
    window.addEventListener("mousemove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    />
  );
}
