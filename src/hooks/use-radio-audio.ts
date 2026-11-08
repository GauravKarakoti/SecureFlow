import { useCallback, useEffect, useRef, useState } from "react";

export type SquelchKind = "start" | "end";

function createAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/**
 * Tactical radio audio (#1309).
 *
 * Off by default: browsers block audio until a user gesture, so the AudioContext
 * is only created when the user turns the radio on. Squelch sounds are
 * synthesised with the Web Audio API, so no audio assets are shipped.
 */
export function useRadioAudio() {
  const [enabled, setEnabled] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const enabledRef = useRef(false);

  const ensureContext = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    const ctx = createAudioContext();
    if (!ctx) return null;
    const node = ctx.createAnalyser();
    node.fftSize = 128;
    node.connect(ctx.destination);
    ctxRef.current = ctx;
    analyserRef.current = node;
    setAnalyser(node);
    return ctx;
  }, []);

  const toggle = useCallback(async () => {
    if (enabledRef.current) {
      enabledRef.current = false;
      setEnabled(false);
      // Suspend the AudioContext too: toggling off only flipped state, so the
      // context kept running (holding an audio thread and counting against
      // the browser's AudioContext budget) until unmount.
      void ctxRef.current?.suspend().catch(() => {});
      return;
    }
    const ctx = ensureContext();
    if (!ctx) return;
    try {
      await ctx.resume();
    } catch {
      return;
    }
    enabledRef.current = true;
    setEnabled(true);
  }, [ensureContext]);

  const playSquelch = useCallback((kind: SquelchKind) => {
    const ctx = ctxRef.current;
    const out = analyserRef.current;
    if (!enabledRef.current || !ctx || !out) return;

    const duration = kind === "start" ? 0.18 : 0.28;
    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = kind === "start" ? 1800 : 1200;
    filter.Q.value = 0.8;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    source.start(now);
    source.stop(now + duration);

    if (kind === "end") {
      // short "roger beep" after the static burst
      const osc = ctx.createOscillator();
      const beepGain = ctx.createGain();
      osc.frequency.value = 1000;
      beepGain.gain.setValueAtTime(0.0001, now + duration);
      beepGain.gain.exponentialRampToValueAtTime(0.08, now + duration + 0.01);
      beepGain.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.08);
      osc.connect(beepGain);
      beepGain.connect(out);
      osc.start(now + duration);
      osc.stop(now + duration + 0.09);
    }
  }, []);

  useEffect(() => {
    return () => {
      enabledRef.current = false;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      analyserRef.current = null;
      if (ctx) ctx.close().catch(() => {});
    };
  }, []);

  return { enabled, analyser, toggle, playSquelch };
}
