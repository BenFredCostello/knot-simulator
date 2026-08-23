// ---------------------------------------------------------------------------
// word.js — parsing and free-group logic for algebraic words.
//
// A word is an array of letters { gen, inv }, where `gen` is a 1-based ring
// index and `inv` marks the inverse generator.  All link-theoretic reasoning
// in this app happens here; no geometry, no physics.
// ---------------------------------------------------------------------------

const APOSTROPHES = new Set(["'", '\u2019', '\u02BC', '\u00B4', '`']);
const SEPARATORS = /[\s,.*\u00B7\u00D7]/;

/**
 * Parse source text into letters.  Accepts letters (a=1, b=2, ...) and bare
 * ring numbers interchangeably, so "aba'b'" and "1 2 1' 2'" are the same word.
 * Returns { letters, errors, warnings, maxGen }.
 */
export function parseWord(src, genCount = Infinity) {
  const s = src ?? '';
  const letters = [];
  const errors = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (SEPARATORS.test(ch)) { i++; continue; }

    if (APOSTROPHES.has(ch)) {
      if (letters.length === 0) {
        errors.push(`Inverse mark at position ${i + 1} has no letter before it.`);
      } else {
        const last = letters[letters.length - 1];
        last.inv = !last.inv;
      }
      i++;
      continue;
    }

    // ^-1 / ^ -1 / ^1  -> invert the preceding letter
    if (ch === '^') {
      const m = /^\^\s*-?\s*1/.exec(s.slice(i));
      if (m) {
        if (letters.length === 0) {
          errors.push(`Exponent at position ${i + 1} has no letter before it.`);
        } else {
          const last = letters[letters.length - 1];
          if (m[0].includes('-')) last.inv = !last.inv;
        }
        i += m[0].length;
        continue;
      }
      errors.push(`Only ^-1 and ^1 are supported (position ${i + 1}).`);
      i++;
      continue;
    }

    if (/[a-zA-Z]/.test(ch)) {
      letters.push({ gen: ch.toLowerCase().charCodeAt(0) - 96, inv: false });
      i++;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      const n = parseInt(s.slice(i, j), 10);
      if (n < 1) errors.push(`Ring numbers start at 1 (position ${i + 1}).`);
      else letters.push({ gen: n, inv: false });
      i = j;
      continue;
    }

    errors.push(`Unexpected character \u201C${ch}\u201D at position ${i + 1}.`);
    i++;
  }

  const warnings = [];
  const maxGen = letters.reduce((m, l) => Math.max(m, l.gen), 0);
  if (Number.isFinite(genCount) && maxGen > genCount) {
    const missing = [...new Set(letters.map((l) => l.gen))]
      .filter((g) => g > genCount)
      .sort((a, b) => a - b)
      .map(genLabel);
    warnings.push(
      `${missing.join(', ')} ${missing.length > 1 ? 'refer' : 'refers'} to ring(s) that do not exist yet — add more rings.`
    );
  }

  return { letters, errors, warnings, maxGen };
}

/** Cancel adjacent inverse pairs until none remain. */
export function freeReduce(letters) {
  const out = [];
  for (const l of letters) {
    const top = out[out.length - 1];
    if (top && top.gen === l.gen && top.inv !== l.inv) out.pop();
    else out.push({ gen: l.gen, inv: l.inv });
  }
  return out;
}

/** Delete every occurrence of generator `gen`, then freely reduce. */
export function deleteGenerator(letters, gen) {
  return freeReduce(letters.filter((l) => l.gen !== gen));
}

/**
 * The Brunnian test.
 *
 * The base rings are disjoint coplanar circles, so they are already unlinked
 * from one another and pi_1 of their complement is free on the generators.
 * Killing generator g is exactly the retraction that deletes every occurrence
 * of g; the word ring falls free of the remaining rings precisely when the
 * image is trivial.  So the link is Brunnian iff the word is non-trivial but
 * dies under every single-generator deletion.
 */
export function verifyBrunnian(letters, genCount) {
  const full = freeReduce(letters);
  const rows = [];
  for (let g = 1; g <= genCount; g++) {
    const reduced = deleteGenerator(letters, g);
    rows.push({ gen: g, reduced, ok: reduced.length === 0 });
  }
  const nontrivial = full.length > 0;
  const allDie = rows.length > 0 && rows.every((r) => r.ok);
  return {
    full,
    rows,
    nontrivial,
    allDie,
    enoughRings: genCount >= 2,
    brunnian: nontrivial && allDie && genCount >= 2,
  };
}

/** 1 -> "a", 26 -> "z", 27 -> "x27" (past the alphabet we fall back to numbers). */
export function genLabel(gen) {
  return gen >= 1 && gen <= 26 ? String.fromCharCode(96 + gen) : `x${gen}`;
}

/** Plain-text form, e.g. "aba'b'". */
export function wordToText(letters) {
  return letters.map((l) => genLabel(l.gen) + (l.inv ? "'" : '')).join('');
}

/** HTML form with proper superscripts, e.g. aba<sup>-1</sup>b<sup>-1</sup>. */
export function wordToHTML(letters) {
  if (!letters.length) return '<span class="empty">empty word (trivial)</span>';
  return letters
    .map((l) => genLabel(l.gen) + (l.inv ? '<sup>\u22121</sup>' : ''))
    .join('');
}
