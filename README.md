# Brunnian Link Lab

An interactive simulator that ties **words in a free group** to **linked rings**, built for a
topology class. Type an algebraic word, watch the corresponding link get threaded, pull it
tight, and snip any ring to see whether the rest falls apart.

No build step, no dependencies to install — it is a static site using ES modules and an
import map, with three.js pulled from a CDN.

---

## The convention

With **n** rings on screen:

- Rings **1 … n−1** are the *base rings*: unknotted unit circles, evenly spaced, all lying in
  one plane. Being disjoint and coplanar they are already unlinked from each other.
- The **highest-numbered ring** is the *word ring*. Its path is built from the word you type.
- Letters `a, b, c, …` name base rings 1, 2, 3, …; `'` marks an inverse.

Each letter makes the word ring dive once through that base ring's disk — downward for a
generator, upward for its inverse — and it stays clear of every disk in between. So the word
ring's class in π₁ of the complement of the base rings is exactly the word you typed.

Both notations parse identically, so `aba'b'` and `1 2 1' 2'` are the same word. `^-1` also
works. Input is case-insensitive.

**Borromean rings** are `aba'b'` on 3 rings — the commutator [a, b].
**Four-ring Brunnian** is `aba'b'cbab'a'c'` — the commutator [[a, b], c].

## Why the Brunnian test is valid

The check is pure algebra, no physics: delete every occurrence of one generator, freely reduce
what is left, and see whether nothing remains. Repeat for each generator.

That works because the base rings are unlinked from one another, so π₁ of their complement is
*free* on the generators. Killing generator *g* — which is what removing ring *g* does — is
precisely the retraction that deletes every occurrence of *g*. The word ring falls free of the
remaining rings exactly when the resulting word is trivial.

So the link is Brunnian when the word is **non-trivial**, yet **dies under every**
single-generator deletion. Both halves matter: a word that already reduces to the identity is
just the unlink, and the tool says so.

One consequence worth noting in class: `aba'b'` with **four** rings is correctly reported as
*not* Brunnian, because ring 3 (`c`) is never threaded and so is a split unlinked component —
removing it leaves the other three still linked.

## Controls

| Control | What it does |
| --- | --- |
| **Add Ring / Remove** | Rings are numbered sequentially and spaced evenly. The last one is always the word ring. |
| **Word field** | Rebuilds the threading geometry on every keystroke. |
| **x⁻¹** | Appends an inverse mark, if you would rather not type an apostrophe. |
| **Verify Brunnian** | Runs the deletion test and shows the reduced word for each generator. |
| **Pull** | Tightens everything. Hold <kbd>Space</kbd> as a shortcut. |
| **Cut tool** | Click any ring to snip it; click a snipped ring (or its sidebar row) to rejoin. Orbiting pauses while armed. |
| **Tension** | How hard Pull pulls. |
| **View** | ¾ / Top / Front, plus Fit. Drag to orbit freely at any time. |

The intended demo: type `aba'b'`, hit **Pull** and watch three rings lock into a tight knot.
Then arm the **cut tool**, snip any one of them, and pull again — all three come apart.

## How it works

- `src/word.js` — parsing, free reduction, and the Brunnian test. Pure logic, no geometry.
- `src/geometry.js` — turns a word into initial threading geometry. Between letters the curve
  parks on a "lane" well outside every disk, one lane per letter, so it never crosses itself
  and contributes no unintended linking. The raw result sprawls like a comb; that is expected,
  and relaxation is what makes it readable.
- `src/physics.js` — position-based relaxation. Each ring is a chain of points with distance
  constraints; **Pull** shrinks the rest lengths.
- `src/tube.js` — swept tube geometry rewritten in place each frame using parallel-transport
  frames, so nothing is reallocated per frame.
- `src/scene.js` — renderer, lighting, camera presets.

### Three details that turned out to matter

**Collision is segment-to-segment, not point-to-point.** With only point repulsion, a strand
under compression can slip *between* two of another strand's points without ever violating a
point constraint — silently changing the link type. Comparing closest approach of the segments
themselves leaves no such gap.

**Pulling stops when the link is taut.** Rest lengths are floored at the smallest circumference
a loop of that thickness can physically have, and a strand that has stopped contracting is
marked taut and left alone. Without this the solver ends in a permanent tug of war between
distance and collision constraints and eventually squeezes a strand clean through another.

**Rings drift gently apart while pulling.** Genuinely linked rings cannot separate, so this just
draws them taut against one another — but rings that are free of each other visibly come apart.
That is what makes snipping a Brunnian link read as a Brunnian link.

### Verification

Linking number is a topological invariant, so it must not change under relaxation. The
simulation was checked by computing pairwise linking numbers from signed crossings before and
after 2000+ frames of pulling: they are preserved, and they match the exponent sums of the
typed word. Because Borromean rings have all-zero linking numbers, that case was checked
separately — intact, the three stay locked together under outward pressure; snip one and all
three separate.

## Running locally

Any static file server works. It must be served over HTTP — ES modules do not load from
`file://`.

```bash
python -m http.server 8177
```

Then open <http://localhost:8177>.

## Deploying

`.github/workflows/pages.yml` publishes the repository as-is on every push to `main`. In the
repository settings, set **Pages → Source** to **GitHub Actions** and the workflow handles the
rest.

## Console access

The running app is exposed as `window.knotLab` (`state`, `sim`, `stage`, `rings`, `rebuild`)
for poking at during a lecture — e.g. `knotLab.state.tension = 3`.
