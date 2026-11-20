// Original brand mark: a home roof with an ECG pulse running through it and a connected node.
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <rect width="48" height="48" rx="12" fill="#1456A0" />
      <path d="M10 23.5 24 11l14 12.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 31h8l3-7 5 12 3.5-8H39" stroke="#5EEAD4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="39" cy="28" r="2.4" fill="#5EEAD4" />
    </svg>
  );
}

export function Logo({ size = 36, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <div className="leading-tight">
        <div className="text-[15px] font-bold tracking-tight text-ink">
          Remote Inpatient <span className="text-teal">AI</span>
        </div>
        {tagline && <div className="text-[11px] text-muted">Hospital-level care, from the comfort of home</div>}
      </div>
    </div>
  );
}
