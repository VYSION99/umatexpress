"use client";

import { useState } from "react";

const CODE_LENGTH = 6;

/** One accessible input keeps paste and one-time-code autofill reliable. */
export function CodeBoxes({ label, value, onChange, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);

  return <label className="auth-code-field">
    {label}
    <span className="auth-code-grid">
      {Array.from({ length: CODE_LENGTH }, (_, index) => <span
        key={index}
        aria-hidden="true"
        className={`auth-code-box${focused && index === Math.min(value.length, CODE_LENGTH - 1) ? " is-current" : ""}`}
      >{value[index] || ""}</span>)}
      <input
        className="auth-code-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={CODE_LENGTH}
        required
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
        onPaste={(event) => {
          const pastedCode = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, CODE_LENGTH);
          if (pastedCode) {
            event.preventDefault();
            onChange(pastedCode);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={label}
        spellCheck={false}
      />
    </span>
  </label>;
}
