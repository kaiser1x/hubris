interface HubrisLogoProps {
  /** light: white on dark surfaces · dark: ink on light surfaces */
  tone?: "light" | "dark";
  className?: string;
}

/**
 * HUBRISMark: the brand wing, traced from the reference lockup.
 * Three slim parallel bars leaning up-right at 30 degrees, left starts
 * stacked vertically, lengths stepping down (24 / 18 / 12), weight 3.4.
 * Butt caps keep the ends geometric. Drawn as vector paths, not glyphs.
 * FROZEN: do not restyle, simplify, or swap this geometry.
 */
export function HUBRISMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 30"
      aria-hidden="true"
      className={`h-[24px] w-auto shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={3.4}
    >
      <path d="M4 14 L24.8 2 M4 20.5 L19.6 11.5 M4 27 L14.4 21" />
    </svg>
  );
}

/**
 * HUBRISLogo: mark left of the wordmark on one baseline.
 * FROZEN lockup: 12px gap, existing wordmark tracking, no container,
 * no circle, no shadow, no glow, no gradient, no animation.
 */
export default function HubrisLogo({
  tone = "light",
  className = "",
}: HubrisLogoProps) {
  return (
    <span
      className={`inline-flex items-center gap-[12px] ${
        tone === "light" ? "text-white" : "text-[#0A0A0A]"
      } ${className}`}
    >
      <HUBRISMark />
      <span className="font-mono text-[13px] font-semibold tracking-[0.28em] leading-none">
        HUBRIS
      </span>
    </span>
  );
}
