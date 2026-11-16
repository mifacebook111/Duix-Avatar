/**
 * Conversor español -> visemas Oculus (OVR lipsync) para TalkingHead.
 *
 * TalkingHead 1.8 acepta en speakAudio({visemes, vtimes, vdurations}) visemas
 * ya calculados. El castellano es una lengua casi fonética, así que una
 * correspondencia grafo-fonética directa da un lip-sync muy convincente
 * (misma estrategia que el módulo "lipsync-fi" de la propia librería).
 *
 * Visemas Oculus disponibles:
 *   sil PP FF TH DD kk CH SS nn RR aa E I O U
 */

const DIGRAPHS = new Set(['ch', 'll', 'qu', 'gu']);

/** Devuelve un array [{v: visema, w: peso relativo}] para una palabra. */
export function wordToVisemes(word) {
  const w = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes: á -> a
    .replace(/[^a-zñ]/g, '');

  if (!w) return [];

  const out = [];
  const push = (v, weight = 1) => {
    // evita visemas idénticos consecutivos (imposibles de articular)
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && prev.v === v && v !== 'sil') {
      prev.w += weight;
      return;
    }
    out.push({ v, w: weight });
  };

  let i = 0;
  let prevChar = '';
  while (i < w.length) {
    const pair = w.slice(i, i + 2);
    const c = w[i];
    const next = w[i + 1] || '';
    const next2 = w[i + 2] || '';

    // muda: "h" no suena
    if (c === 'h') {
      i += 1;
      continue;
    }

    // dígrafos: "qu"/"gu" ante e,i -> la u es muda; "ch" y "ll" -> /tʃ/ /ʝ/
    if ((pair === 'qu' || pair === 'gu') && (next2 === 'e' || next2 === 'i')) {
      push('kk', 0.8);
      i += 2;
      continue;
    }
    if (pair === 'ch') { push('CH', 1.4); i += 2; continue; }
    if (pair === 'll') { push('CH', 1.2); i += 2; continue; }

    switch (c) {
      // vocales
      case 'a': push('aa', 2); break;
      case 'e': push('E', 2); break;
      case 'i': push('I', 1.7); break;
      case 'o': push('O', 2); break;
      case 'u': push('U', 1.7); break;
      case 'y':
        // "y" final o sola -> /i/; ante vocal -> /ʝ/ (como "ll")
        if ('aeiou'.includes(next)) push('CH', 1.2);
        else push('I', 1.7);
        break;

      // labiales / b m p / -> PP
      case 'b': case 'm': case 'p': push('PP', 0.8); break;

      // labiodentales / f v / -> FF
      case 'f': case 'v': push('FF', 0.8); break;

      // dental fricativa castellana: z, ce, ci -> /θ/ -> TH
      case 'z': push('TH', 0.9); break;
      case 'c':
        if (next === 'e' || next === 'i') push('TH', 0.9);
        else push('kk', 0.8);
        break;

      // dental oclusiva -> TH (forma bucal muy próxima)
      case 't': push('TH', 0.8); break;
      case 'd': push('DD', 0.8); break;

      // velares
      case 'k': case 'q': push('kk', 0.8); break;
      case 'g':
        // /x/ en "ge, gi, j" y /g/ en el resto: forma de kk
        push('kk', 0.8);
        break;
      case 'j': push('kk', 0.9); break;

      // sibilantes
      case 's': case 'x': push('SS', 0.9); break;

      // nasales y lateral
      case 'n': case 'ñ': push('nn', 0.8); break;
      case 'l': push('nn', 0.8); break;

      // vibrantes
      case 'r':
        // "rr" o r inicial -> vibrante fuerte
        if (next === 'r' || prevChar === '' || prevChar === 'l' || prevChar === 'n' || prevChar === 's') push('RR', 1);
        else push('RR', 0.6);
        break;

      default:
        push('sil', 0.4);
    }

    i += 1;
    prevChar = c;
  }

  if (!out.length) out.push({ v: 'sil', w: 1 });
  return out;
}

/**
 * Reparte los visemas de cada palabra dentro del intervalo temporal real
 * que da el motor TTS (word boundaries de Microsoft Edge / Azure).
 *
 * @param {Array<{text:string, offsetMs:number, durationMs:number}>} words
 * @returns {{visemes:string[], vtimes:number[], vdurations:number[]}}
 */
export function wordsToVisemeTrack(words) {
  const visemes = [];
  const vtimes = [];
  const vdurations = [];

  for (const word of words) {
    const seq = wordToVisemes(word.text);
    if (!seq.length) continue;

    const total = seq.reduce((s, x) => s + x.w, 0);
    if (total <= 0) continue;

    let acc = 0;
    for (const item of seq) {
      const dur = Math.max(35, Math.round((item.w / total) * word.durationMs));
      visemes.push(item.v);
      vtimes.push(Math.round(word.offsetMs + (acc / total) * word.durationMs));
      vdurations.push(dur);
      acc += item.w;
    }
  }

  return { visemes, vtimes, vdurations };
}
