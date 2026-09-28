"use client";

import { useEffect, useRef } from "react";

export const PROMPT_EDITOR_MIN_HEIGHT = 136;
export const PROMPT_EDITOR_MAX_HEIGHT = 320;

export interface PromptShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export function isPromptSubmitShortcut(event: PromptShortcutEvent): boolean {
  return event.key === "Enter" && Boolean(event.ctrlKey || event.metaKey);
}

interface PromptEditorProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder: string;
  maxLength: number;
  disabled?: boolean;
  error?: string | null;
  className?: string;
  minHeight?: number;
  maxHeight?: number;
}

function resizeEditor(element: HTMLTextAreaElement, minHeight: number, maxHeight: number): void {
  element.style.height = "auto";
  const height = Math.min(
    Math.max(element.scrollHeight, minHeight),
    maxHeight
  );
  element.style.height = `${height}px`;
  element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
}

export default function PromptEditor({
  id,
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  maxLength,
  disabled = false,
  error = null,
  className = "",
  minHeight = PROMPT_EDITOR_MIN_HEIGHT,
  maxHeight = PROMPT_EDITOR_MAX_HEIGHT,
}: PromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const errorId = `${id}-error`;

  useEffect(() => {
    if (textareaRef.current) resizeEditor(textareaRef.current, minHeight, maxHeight);
  }, [value, minHeight, maxHeight]);

  return (
    <div className={`w-full ${className}`}>
      <label htmlFor={id} className="kicker block mb-2">
        {label}
      </label>
      <div className="relative">
        <textarea
          ref={textareaRef}
          id={id}
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (isPromptSubmitShortcut(event)) {
              event.preventDefault();
              onSubmit?.();
            }
          }}
          style={{ minHeight, maxHeight }}
          className="block w-full resize-none overflow-hidden border border-[#dedada] bg-white px-3 py-3 pb-9 font-mono text-[15px] leading-6 text-[#0A0A0A] placeholder:text-[#7A7171] focus:border-[#0A0A0A] focus:outline-none disabled:opacity-50 motion-reduce:transition-none"
        />
        {value.length > 0 && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => onChange("")}
            disabled={disabled}
            className="absolute right-2 top-2 grid h-7 w-7 place-items-center font-mono text-sm text-[#7A7171] hover:text-[#0A0A0A] disabled:opacity-40"
          >
            ×
          </button>
        )}
        <span
          aria-live="polite"
          className="pointer-events-none absolute bottom-2 right-3 font-mono text-[10px] text-[#7A7171]"
        >
          {value.length} / {maxLength}
        </span>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 font-mono text-xs text-[#7A7171]">
          {error}
        </p>
      )}
    </div>
  );
}
