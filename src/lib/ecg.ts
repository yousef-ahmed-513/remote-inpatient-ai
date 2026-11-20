// Synthetic ECG generator. Purely artificial waveforms built from Gaussian bumps —
// NOT recorded ECG, NOT a physiological model, NOT a diagnosis.

export const ECG_FS = 125; // samples per second

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

const bump = (t: number, mu: number, sigma: number, amp: number) => amp * Math.exp(-((t - mu) ** 2) / (2 * sigma * sigma));

/** One beat sampled at phase t∈[0,1). `early` beats are drawn wide with no P wave (simulated ectopic-style shape). */
function beatValue(t: number, early: boolean): number {
  if (early) {
    return bump(t, 0.3, 0.035, -0.25) + bump(t, 0.36, 0.045, 1.25) + bump(t, 0.47, 0.05, -0.55) + bump(t, 0.7, 0.07, -0.22);
  }
  return (
    bump(t, 0.18, 0.028, 0.12) + // P
    bump(t, 0.335, 0.011, -0.14) + // Q
    bump(t, 0.36, 0.013, 1.0) + // R
    bump(t, 0.385, 0.012, -0.24) + // S
    bump(t, 0.62, 0.055, 0.3) // T
  );
}

export type EcgBeat = { start: number; dur: number; early: boolean };

/** Beat schedule for a strip. Irregular mode jitters R-R intervals and inserts early wide beats. */
export function ecgBeats(opts: { hr: number; irregular: boolean; seed: number; seconds: number }): EcgBeat[] {
  const rnd = mulberry32(opts.seed);
  const base = 60 / Math.max(35, Math.min(180, opts.hr));
  const beats: EcgBeat[] = [];
  let t = 0;
  while (t < opts.seconds + 2) {
    let dur = base * (1 + (rnd() - 0.5) * 0.04);
    let early = false;
    if (opts.irregular) {
      dur = base * (0.62 + rnd() * 0.85);
      early = rnd() < 0.16;
      if (early) dur = base * 0.58;
    }
    beats.push({ start: t, dur, early });
    t += dur;
  }
  return beats;
}

export function synthEcg(opts: { hr: number; irregular: boolean; seed: number; seconds: number }): number[] {
  const beats = ecgBeats(opts);
  const rnd = mulberry32(opts.seed ^ 0x9e3779b9);
  const n = Math.round(opts.seconds * ECG_FS);
  const out = new Array<number>(n);
  let bi = 0;
  for (let i = 0; i < n; i++) {
    const t = i / ECG_FS;
    while (bi < beats.length - 1 && t >= beats[bi].start + beats[bi].dur) bi++;
    const b = beats[bi];
    // QRS keeps a roughly fixed width in seconds; stretch only the baseline for slow beats
    const phase = Math.min(0.999, (t - b.start) / Math.max(b.dur, 0.45));
    const wander = 0.03 * Math.sin(2 * Math.PI * 0.22 * t);
    out[i] = beatValue(phase, b.early) + wander + (rnd() - 0.5) * 0.025;
  }
  return out;
}
