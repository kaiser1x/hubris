"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "../../components/WorkspaceProvider";
import {
  applyAppearance,
  readAppearance,
  writeAppearance,
  type AppearanceSettings,
} from "../../lib/settings";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-[#dedada] py-7 first:border-t-0 first:pt-0">
      <h2 className="kicker mb-4">{title}</h2>
      <div className="divide-y divide-[#dedada] border-y border-[#dedada]">{children}</div>
    </section>
  );
}

function Row({ label, detail, children, locked = false }: { label: string; detail?: string; children: React.ReactNode; locked?: boolean }) {
  return (
    <div className="grid gap-3 px-0 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <p className="text-[13px] font-medium">{label}</p>
        {detail && <p className="mt-1 max-w-xl text-[12px] leading-5 text-[#7A7171]">{detail}</p>}
      </div>
      <div className={locked ? "opacity-70" : ""}>{children}</div>
    </div>
  );
}

function LockedValue({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[12px] text-[#7A7171]">{children}</span>;
}

export default function SettingsPage() {
  const { status, repo } = useWorkspace();
  const [appearance, setAppearance] = useState<AppearanceSettings>(() =>
    readAppearance(typeof window === "undefined" ? null : window.localStorage)
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    applyAppearance(appearance, document);
  }, [appearance]);

  const repository =
    status === "loading"
      ? "Loading active workspace…"
      : status === "ready" && repo.hasContext
        ? (repo.repoName ?? "Repository context unavailable")
        : status === "ready"
          ? "Legacy job requires re-analysis"
          : "No analyzed repository selected";

  function updateAppearance(next: Partial<AppearanceSettings>) {
    const value = { ...appearance, ...next };
    setAppearance(value);
    writeAppearance(window.localStorage, value);
    applyAppearance(value, document);
    window.dispatchEvent(new Event("hubris-settings-changed"));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  }

  return (
    <div className="w-full max-w-[1100px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">System / Settings</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">Settings</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-7 text-[#7A7171]">
        Control how HUBRIS understands, repairs, and verifies your codebase.
      </p>
      {saved && <p className="mt-4 font-mono text-[11px] text-[#7A7171]" role="status">Saved</p>}

      <div className="mt-10">
        <Section title="Workspace">
          <Row label="Repository" detail="Determined by the active analyzed job." locked><LockedValue>{repository}</LockedValue></Row>
           <Row label="Analyzed ref" detail="The analyzed job's revision remains authoritative for Forge."><LockedValue>{repo.hasContext ? (repo.ref ?? "default branch") : "—"} · managed by workspace</LockedValue></Row>
          <Row label="Verification command" detail="A run may use an explicit command; otherwise HUBRIS detects the repository command."><LockedValue>Auto-detect</LockedValue></Row>
        </Section>

        <Section title="Forge">
          <Row label="Require Investigation before Forge" detail="Grounded Investigation is the safe path into structured Forge."><LockedValue>ON · enforced by workflow</LockedValue></Row>
          <Row label="Require grounded evidence"><LockedValue>ON · enforced</LockedValue></Row>
          <Row label="Minimal repair scope"><LockedValue>ON · enforced</LockedValue></Row>
          <Row label="Maximum proposed edits"><LockedValue>1 · structured contract</LockedValue></Row>
          <Row label="Show repair contract before Forge"><LockedValue>ON · enabled</LockedValue></Row>
        </Section>

        <Section title="Verification">
          <Row label="Test command"><LockedValue>Auto-detect</LockedValue></Row>
          <Row label="Timeout"><LockedValue>120 seconds · system default</LockedValue></Row>
          <Row label="Run tests after Forge"><LockedValue>ON · enforced</LockedValue></Row>
          <Row label="Require zero exit code for VERIFIED" detail="This trust boundary cannot be disabled."><LockedValue>ON · enforced</LockedValue></Row>
          <Row label="Show sandbox output"><LockedValue>ON</LockedValue></Row>
          <Row label="Retain verification history"><LockedValue>ON</LockedValue></Row>
        </Section>

        <Section title="Sandbox">
          <Row label="Provider"><LockedValue>Nebius</LockedValue></Row>
          <Row label="Default image"><LockedValue>node:20-slim</LockedValue></Row>
          <Row label="Network"><LockedValue>Restricted</LockedValue></Row>
          <Row label="Repository credentials"><LockedValue>Never exposed</LockedValue></Row>
          <Row label="Automatic cleanup"><LockedValue>ON</LockedValue></Row>
          <Row label="Security boundary" detail="Security guarantees enforced by HUBRIS cannot be disabled from Settings."><LockedValue>ENFORCED BY HUBRIS</LockedValue></Row>
        </Section>

        <Section title="Analysis">
          <Row label="Languages currently supported"><LockedValue>TypeScript · JavaScript</LockedValue></Row>
          <Row label="Include tests"><LockedValue>ON · analyzer default</LockedValue></Row>
          <Row label="Include call relationships"><LockedValue>ON · analyzer default</LockedValue></Row>
          <Row label="Include HTTP routes"><LockedValue>ON · analyzer default</LockedValue></Row>
          <Row label="Refresh behavior"><LockedValue>On demand · revision-aware</LockedValue></Row>
          <Row label="Repository size limits"><LockedValue>Configured transfer guards</LockedValue></Row>
        </Section>

        <Section title="Appearance">
          <Row label="Theme" detail="Stored locally in this browser.">
            <select value={appearance.theme} onChange={(event) => updateAppearance({ theme: event.target.value as AppearanceSettings["theme"] })} className="min-w-36 border border-[#dedada] bg-white px-3 py-2 font-mono text-[12px] focus:border-[#0A0A0A] focus:outline-none">
              <option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option>
            </select>
          </Row>
          <Row label="Density">
            <select value={appearance.density} onChange={(event) => updateAppearance({ density: event.target.value as AppearanceSettings["density"] })} className="min-w-36 border border-[#dedada] bg-white px-3 py-2 font-mono text-[12px] focus:border-[#0A0A0A] focus:outline-none">
              <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
            </select>
          </Row>
          <Row label="Motion">
            <select value={appearance.motion} onChange={(event) => updateAppearance({ motion: event.target.value as AppearanceSettings["motion"] })} className="min-w-36 border border-[#dedada] bg-white px-3 py-2 font-mono text-[12px] focus:border-[#0A0A0A] focus:outline-none">
              <option value="standard">Standard</option><option value="reduced">Reduced</option>
            </select>
          </Row>
        </Section>

        <Section title="Integrations">
          <Row label="GitHub" detail="Credential state is managed server-side."><LockedValue>Server-managed</LockedValue></Row>
          <Row label="Nebius"><LockedValue>Server-managed</LockedValue></Row>
          <Row label="Model provider"><LockedValue>Server-managed</LockedValue></Row>
          <p className="px-0 py-4 font-mono text-[11px] text-[#7A7171]">Credentials and environment values are never displayed here.</p>
        </Section>

        <section className="border-t border-[#dedada] py-7">
          <h2 className="kicker mb-4">Enforced by HUBRIS</h2>
          <div className="grid gap-3 border-y border-[#dedada] py-4 font-mono text-[12px] sm:grid-cols-2">
            <span>✓ Source revision matching required</span><span>✓ Exact source matching required</span>
            <span>✓ Sandbox isolation required</span><span>✓ Successful verification required for VERIFIED</span>
            <span>✕ Secrets passed to sandbox: never</span>
          </div>
        </section>
      </div>
    </div>
  );
}
