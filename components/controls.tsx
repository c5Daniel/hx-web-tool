// Small form primitives in the hestia-web-tool slate style.

import React from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variantClass: Record<Variant, string> = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20',
  secondary: 'bg-slate-700 hover:bg-slate-600 text-slate-100 border border-slate-600',
  danger: 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20',
  ghost: 'bg-transparent hover:bg-slate-700/60 text-slate-300 border border-slate-700',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button: React.FC<ButtonProps> = ({ variant = 'primary', className = '', ...rest }) => (
  <button
    {...rest}
    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${variantClass[variant]} ${className}`}
  />
);

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}

export const Field: React.FC<FieldProps> = ({ label, hint, error, children, className = '' }) => (
  <label className={`block text-xs ${className}`}>
    <span className="block mb-1 text-slate-400">{label}</span>
    {children}
    {error ? <span className="block mt-1 text-red-400">{error}</span> : hint ? <span className="block mt-1 text-slate-500">{hint}</span> : null}
  </label>
);

const inputClass =
  'w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-blue-500 disabled:opacity-50';

export const TextInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className = '', ...rest }) => (
  <input {...rest} className={`${inputClass} ${className}`} />
);

export const TextArea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className = '', ...rest }) => (
  <textarea {...rest} className={`${inputClass} ${className}`} />
);

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({ className = '', ...rest }) => (
  <select {...rest} className={`${inputClass} font-sans ${className}`} />
);

interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export const Checkbox: React.FC<CheckboxProps> = ({ label, checked, onChange, disabled }) => (
  <label className={`inline-flex items-center gap-2 text-sm text-slate-300 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
    <input
      type="checkbox"
      className="accent-blue-500 w-4 h-4"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    {label}
  </label>
);

export type Tone = 'ok' | 'error' | 'info' | 'warn';

const toneClass: Record<Tone, string> = {
  ok: 'border-green-700/60 bg-green-900/20 text-green-300',
  error: 'border-red-700/60 bg-red-900/20 text-red-300',
  info: 'border-slate-700 bg-slate-900/60 text-slate-300',
  warn: 'border-amber-700/60 bg-amber-900/20 text-amber-300',
};

/** An operation's outcome, shown next to the control that produced it. */
export const Result: React.FC<{ tone: Tone; children: React.ReactNode; mono?: boolean }> = ({ tone, children, mono }) => (
  <div className={`mt-3 rounded-md border px-3 py-2 text-sm whitespace-pre-wrap break-all ${mono ? 'font-mono text-xs' : ''} ${toneClass[tone]}`}>
    {children}
  </div>
);

export const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-xs text-slate-500 mt-2 leading-relaxed">{children}</p>
);

/** Label / value row for read-only device fields. */
export const KV: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({ label, value, mono = true }) => (
  <div className="flex justify-between gap-4 py-1 border-b border-slate-700/40 last:border-0 text-sm">
    <span className="text-slate-400 shrink-0">{label}</span>
    <span className={`text-right text-slate-100 break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
  </div>
);

export const Pill: React.FC<{ on: boolean; children: React.ReactNode }> = ({ on, children }) => (
  <span
    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${
      on ? 'bg-green-900/40 text-green-300 border-green-700/60' : 'bg-slate-800 text-slate-500 border-slate-700'
    }`}
  >
    {children}
  </span>
);
