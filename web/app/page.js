'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/* ─────────────────────────── Constantes ─────────────────────────── */

const AVATAR_URL = '/avatars/mpfb.glb'; // CC0 · compatible TalkingHead (rig Mixamo + ARKit/Oculus)
const GREETING =
  '¡Hola! Encantada de conocerte. Soy Alba, tu asesora personal. Pregúntame lo que quieras: eficiencia energética, vivienda, inversiones… o simplemente charlar. Te escucho.';

const STATE_LABEL = {
  boot: 'Cargando avatar…',
  ready: 'En línea',
  listening: 'Te escucho…',
  thinking: 'Pensando…',
  speaking: 'Hablando…',
  error: 'Error',
};

/* ───────────────── Utilidades de texto y sincronía ───────────────── */

/** Divide un texto en frases listas para sintetizar (sin regex lookbehind). */
function extractSentences(buffer, force = false) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    // no partir decimales: "3.5"
    if (ch === '.' && /\d/.test(buffer[i - 1] ?? '') && /\d/.test(buffer[i + 1] ?? '')) continue;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…' || ch === '\n' || ch === ':') {
      let end = i + 1;
      while (end < buffer.length && /\s/.test(buffer[end])) end++;
      const s = buffer.slice(start, end).trim();
      if (s) sentences.push(s);
      start = end;
    } else if (i - start > 220 && (ch === ',' || ch === ';')) {
      let end = i + 1;
      while (end < buffer.length && /\s/.test(buffer[end])) end++;
      const s = buffer.slice(start, end).trim();
      if (s) sentences.push(s);
      start = end;
    }
  }
  let rest = buffer.slice(start);
  if (force && rest.trim()) {
    sentences.push(rest.trim());
    rest = '';
  }
  return { sentences, rest };
}

/** Reserva de visemas si el TTS no devolviera word boundaries. */
function estimateTrack(sentence, durationSec) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const visemes = [];
  const vtimes = [];
  const vdurations = [];
  const totalChars = words.reduce((s, w) => s + w.length, 0) || 1;
  const totalMs = durationSec * 1000;
  let acc = 0;
  for (const w of words) {
    const offset = (acc / totalChars) * totalMs;
    const dur = (w.length / totalChars) * totalMs;
    // boca semiabierta oscilando: silueta creíble sin visemas reales
    const n = Math.max(2, Math.round(w.length / 2));
    for (let k = 0; k < n; k++) {
      visemes.push(k % 2 === 0 ? 'aa' : 'nn');
      vtimes.push(Math.round(offset + (k / n) * dur));
      vdurations.push(Math.max(40, Math.round(dur / n)));
    }
    acc += w.length;
  }
  return { visemes, vtimes, vdurations };
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* ───────────────────────────── Página ───────────────────────────── */

export default function Home() {
  const [phase, setPhase] = useState('boot'); // boot | ready | listening | thinking | speaking
  const [loadProgress, setLoadProgress] = useState(0);
  const [messages, setMessages] = useState([]); // {role, text}
  const [interim, setInterim] = useState('');
  const [input, setInput] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState('');
  const [speechSupported, setSpeechSupported] = useState(true);
  const [started, setStarted] = useState(false);

  const avatarElRef = useRef(null);
  const headRef = useRef(null);
  const recRef = useRef(null);
  const wantListenRef = useRef(false);
  const decodeCtxRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const msgsRef = useRef([]); // historial para la API
  const busyRef = useRef(false);

  /* ── Cargar TalkingHead y el avatar 3D ── */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mod = await import('@met4citizen/talkinghead');
        const TalkingHead = mod.TalkingHead || mod.default;
        if (cancelled || !avatarElRef.current) return;

        const head = new TalkingHead(avatarElRef.current, {
          lipsyncModules: [], // los visemas llegan ya calculados desde /api/tts
          cameraView: 'upper',
          avatarIdleEyeContact: 0.55,
          avatarSpeakingEyeContact: 0.75,
          avatarSpeakingHeadMove: 0.6,
          mixerGainSpeech: 2.2,
        });
        headRef.current = head;

        await head.showAvatar(
          {
            url: AVATAR_URL,
            body: 'F',
            avatarMood: 'happy',
            baseline: { headRotateX: -0.02 },
          },
          (url, ev) => {
            if (ev?.lengthComputable && ev?.total) {
              setLoadProgress(Math.round((ev.loaded / ev.total) * 100));
            } else if (ev?.loaded) {
              setLoadProgress((p) => Math.min(95, p + 4));
            }
          },
        );

        if (cancelled) return;
        setLoadProgress(100);
        setPhase('ready');
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setError('No se pudo cargar el avatar 3D. Prueba con Chrome o Firefox actualizado.');
          setPhase('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        headRef.current?.stop?.();
      } catch {}
    };
  }, []);

  /* ── Voz: sintetiza una frase y la encola en orden con lip-sync ── */
  const speakSentence = useCallback((sentence) => {
    chainRef.current = chainRef.current.then(async () => {
      try {
        // contexto para decodificar MP3 -> AudioBuffer (funciona incluso suspendido)
        if (!decodeCtxRef.current) {
          decodeCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        }
        decodeCtxRef.current.resume?.().catch?.(() => {});

        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status}`);
        const data = await res.json();

        const audioBuffer = await decodeCtxRef.current.decodeAudioData(
          base64ToArrayBuffer(data.audio),
        );

        let track = { visemes: data.visemes, vtimes: data.vtimes, vdurations: data.vdurations };
        if (!track.visemes?.length) {
          track = estimateTrack(sentence, audioBuffer.duration);
        }

        headRef.current?.speakAudio({
          audio: audioBuffer,
          visemes: track.visemes,
          vtimes: track.vtimes,
          vdurations: track.vdurations,
        });
      } catch (e) {
        console.error('TTS', e);
        setError('No se pudo sintetizar la voz. Reintentando con la siguiente frase…');
      }
    });
  }, []);

  const waitUntilSilent = useCallback(() => {
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        const head = headRef.current;
        if (!head || !head.isSpeaking) {
          clearInterval(iv);
          resolve();
        }
      }, 250);
    });
  }, []);

  /* ── Micrófono: Web Speech API (es-ES) ── */
  const stopMic = useCallback(() => {
    try {
      recRef.current?.abort?.();
    } catch {}
    setMicOn(false);
  }, []);

  const startMic = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.start();
      setMicOn(true);
    } catch {
      /* ya iniciado */
    }
  }, []);

  const converse = useCallback(
    async (userText) => {
      if (busyRef.current) return;
      busyRef.current = true;

      const history = [...msgsRef.current, { role: 'user', content: userText }];
      msgsRef.current = history;
      setMessages((m) => [...m, { role: 'user', text: userText }]);
      setInterim('');
      setPhase('thinking');

      let full = '';
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error || `HTTP ${res.status}`);
        }

        setPhase('speaking');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { sentences, rest } = extractSentences(buffer);
          for (const s of sentences) {
            full += ` ${s}`;
            speakSentence(s);
          }
          buffer = rest;
        }
        const tail = extractSentences(buffer, true);
        for (const s of tail.sentences) {
          full += ` ${s}`;
          speakSentence(s);
        }

        msgsRef.current = [...history, { role: 'assistant', content: full.trim() }];
        setMessages((m) => [...m, { role: 'assistant', text: full.trim() }]);

        await waitUntilSilent();
      } catch (e) {
        console.error(e);
        setError(`No pude responder: ${e.message || e}`);
        setPhase('ready');
      } finally {
        busyRef.current = false;
        if (wantListenRef.current) {
          setPhase('listening');
          startMic();
        } else {
          setPhase('ready');
        }
      }
    },
    [speakSentence, waitUntilSilent, startMic],
  );

  useEffect(() => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) {
      setSpeechSupported(false);
      return;
    }
    const rec = new SR();
    rec.lang = 'es-ES';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (interimText) setInterim(interimText);
      const text = finalText.trim();
      if (text.length > 1 && !busyRef.current) {
        stopMic();
        converse(text);
      }
    };
    rec.onend = () => {
      // Chrome corta la sesión cada ~60 s: se relanza si sigue activo
      if (wantListenRef.current && !busyRef.current) {
        setTimeout(() => {
          try {
            recRef.current?.start?.();
            setMicOn(true);
          } catch {}
        }, 250);
      } else {
        setMicOn(false);
      }
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('Permiso de micrófono denegado. Habilítalo en el navegador o usa el texto.');
        wantListenRef.current = false;
        setMicOn(false);
      }
    };

    recRef.current = rec;
  }, [converse, stopMic]);

  /* ── Arranque con saludo (gesto de usuario: desbloquea el audio) ── */
  const beginConversation = useCallback(async () => {
    setStarted(true);
    try {
      decodeCtxRef.current = decodeCtxRef.current || new (window.AudioContext || window.webkitAudioContext)();
      decodeCtxRef.current.resume?.();
    } catch {}
    headRef.current?.playGesture?.('ok');
    speakSentence(GREETING);
    setPhase('speaking');
    await chainRef.current;
    await waitUntilSilent();
    // activa el micrófono tras el saludo
    toggleMic();
  }, [speakSentence, waitUntilSilent]);

  const toggleMic = useCallback(() => {
    const next = !wantListenRef.current;
    wantListenRef.current = next;
    if (next) {
      startMic();
      setPhase((p) => (p === 'speaking' ? p : 'listening'));
    } else {
      stopMic();
      setPhase((p) => (p === 'listening' ? 'ready' : p));
    }
  }, [startMic, stopMic]);

  const sendInput = useCallback(
    (e) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || busyRef.current) return;
      setInput('');
      stopMic();
      converse(text);
    },
    [input, converse, stopMic],
  );

  const isListening = phase === 'listening' && micOn;

  return (
    <main className="relative flex h-dvh w-full flex-col overflow-hidden">
      {/* Fondo */}
      <div className="aurora" aria-hidden />

      {/* Cabecera */}
      <header className="relative z-10 flex items-center justify-between px-5 py-3 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-rose-400 to-fuchsia-500 text-sm font-bold text-white shadow-lg shadow-fuchsia-500/25">
            A
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight sm:text-lg">Alba</h1>
            <p className="text-xs text-white/50">Asesora experta · IA conversacional</p>
          </div>
        </div>
        <StatusChip phase={phase} />
      </header>

      {/* Escenario */}
      <section className="relative z-10 flex min-h-0 flex-1 gap-4 px-4 pb-3 sm:px-8">
        {/* Avatar */}
        <div className="relative min-w-0 flex-1">
          <div ref={avatarElRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" />

          {/* Carga */}
          {phase === 'boot' && (
            <div className="absolute inset-0 grid place-items-center">
              <div className="glass flex w-72 flex-col items-center gap-4 rounded-3xl p-8 text-center">
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-rose-400" />
                <p className="text-sm text-white/70">
                  {loadProgress < 100
                    ? `Ajustando los detalles de Alba… ${loadProgress}%`
                    : 'Un momento…'}
                </p>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-rose-400 to-fuchsia-400 transition-all duration-300"
                    style={{ width: `${loadProgress}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Comenzar */}
          {phase === 'ready' && !started && (
            <div className="absolute inset-x-0 bottom-6 grid place-items-center">
              <button
                onClick={beginConversation}
                className="group relative overflow-hidden rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-500 px-8 py-3.5 text-sm font-semibold text-white shadow-xl shadow-fuchsia-500/30 transition hover:scale-[1.03] active:scale-95"
              >
                Comenzar conversación
              </button>
            </div>
          )}

          {error && (
            <div className="absolute left-1/2 top-4 z-20 w-[90%] max-w-sm -translate-x-1/2 rounded-2xl border border-rose-400/30 bg-rose-950/70 px-4 py-3 text-center text-xs text-rose-200 backdrop-blur">
              {error}
              <button
                className="ml-2 underline underline-offset-2 hover:text-white"
                onClick={() => setError('')}
              >
                ocultar
              </button>
            </div>
          )}
        </div>

        {/* Panel de conversación */}
        <aside className="glass chat-scroll hidden w-80 shrink-0 flex-col overflow-y-auto rounded-3xl p-4 lg:flex">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-white/40">
            Conversación
          </h2>
          <div className="flex flex-col gap-3 text-sm">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`msg-in max-w-[92%] rounded-2xl px-3.5 py-2.5 leading-relaxed ${
                  m.role === 'user'
                    ? 'self-end bg-rose-500/20 text-rose-50'
                    : 'self-start bg-white/[0.06] text-white/85'
                }`}
              >
                {m.text}
              </div>
            ))}
            {interim && (
              <div className="self-end rounded-2xl bg-rose-500/10 px-3.5 py-2.5 italic text-rose-200/70">
                {interim}…
              </div>
            )}
          </div>
        </aside>
      </section>

      {/* Barra inferior */}
      <footer className="relative z-10 px-4 pb-5 sm:px-8">
        <form onSubmit={sendInput} className="glass mx-auto flex max-w-3xl items-center gap-3 rounded-full py-2 pl-5 pr-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={speechSupported ? 'Escribe o pulsa el micrófono…' : 'Escribe aquí tu consulta…'}
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-white/35"
          />

          {phase === 'speaking' && <EqIndicator />}

          <button
            type="button"
            onClick={toggleMic}
            disabled={!speechSupported || phase === 'boot' || (phase === 'speaking')}
            title={speechSupported ? 'Micrófono (es-ES)' : 'Tu navegador no soporta reconocimiento de voz; usa Chrome'}
            className={`grid h-11 w-11 place-items-center rounded-full text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${
              isListening
                ? 'mic-live bg-rose-500 shadow-lg shadow-rose-500/40'
                : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            <MicIcon />
          </button>

          <button
            type="submit"
            disabled={!input.trim() || busyRef.current}
            className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-rose-500 to-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/25 transition hover:opacity-90 disabled:opacity-30"
          >
            <SendIcon />
          </button>
        </form>
        <p className="mt-2 text-center text-[11px] text-white/30">
          Voz neural es-ES gratuita (Edge TTS) · Cerebro Llama 3.3 70B en Groq · Lip-sync TalkingHead/WebGL
        </p>
      </footer>
    </main>
  );
}

/* ───────────────────────── Componentes UI ───────────────────────── */

function StatusChip({ phase }) {
  const color =
    phase === 'listening'
      ? 'bg-rose-400'
      : phase === 'thinking'
        ? 'bg-amber-300'
        : phase === 'speaking'
          ? 'bg-emerald-300'
          : phase === 'boot'
            ? 'bg-white/40'
            : 'bg-emerald-400';
  return (
    <div className="glass flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-white/75">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {STATE_LABEL[phase] ?? phase}
    </div>
  );
}

function EqIndicator() {
  return (
    <div className="flex h-5 items-center gap-[3px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="eq-bar h-4 w-[3px] rounded-full bg-fuchsia-300"
          style={{ animationDelay: `${i * 0.13}s` }}
        />
      ))}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}
