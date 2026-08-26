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

## Two modes

**Pegs** (default). The base rings sit evenly around a circle — three of them make a
triangle — with an upright peg through each one, standing between a hard floor and a hard
ceiling. A ring threaded on a peg is genuinely captured: it cannot wander off, and it cannot
escape without being cut. **Pull** happens in two stages. First the word ring contracts until
it has taken up the slack in the raw threading, turning the comb into a knot. Then the pegs
dilate outward from the origin — velocity proportional to distance, so spacing grows evenly —
easing to a stop as the hoops they drag begin to stretch. The slider sets how fast they travel.

**Free**. No pegs, no bounds. Every ring contracts under its own tension and components drift
apart. Looser and more organic, and it separates a freed link more decisively, but components
can travel a long way from where they started.

## Controls

| Control | What it does |
| --- | --- |
| **Pegs / Free** | Switch mode. Rebuilds the scene. |
| **Add Ring / Remove** | Rings are numbered sequentially. The last one is always the word ring. |
| **Word field** | Rebuilds the threading geometry on every keystroke. |
| **x⁻¹** | Appends an inverse mark, if you would rather not type an apostrophe. |
| **Verify Brunnian** | Runs the deletion test and shows the reduced word for each generator. |
| **Pull** | Tightens everything. Hold <kbd>Space</kbd> as a shortcut. |
| **Equalise** | Drives every ring toward a common length so the knot comes out even, instead of one long rope threaded through small hoops. |
| **Cut tool** | Click any ring to snip it; click a snipped ring (or its sidebar row) to rejoin. Orbiting pauses while armed. |
| **Spread speed / Tension** | How fast the pegs separate, or how hard Free mode pulls. |
| **View** | ¾ / Top / Front, plus Fit. Drag to orbit freely at any time. |

The intended demo: type `aba'b'`, hit **Pull** and watch three rings lock into a tight knot.
Then arm the **cut tool**, snip any one of them, and pull again.

Equalise drives everything at one common length, so the short rings grow while the long one
contracts and they meet in the middle. That length is the mean, clamped to the band every strand
is actually allowed to reach — a raw comb's word ring is an order of magnitude longer than the
hoops, and a bare mean dominated by that outlier would inflate the hoops to match it instead of
reeling the long one in.

Equalise stops when a strand is genuinely taut. The word ring often cannot reach the common
length — it has to weave through everything, and there is a shortest length at which it can
still do so — and chasing a target it can never hit would leave it permanently over-tensioned.
On a loose layout it still equalises fully (word ring 107 → 6.3, matching the hoops); on an
already-tight knot it gives up after about thirty frames.

Hoops are capped so they cannot balloon past their peg spacing.

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
That is what makes snipping a Brunnian link read as a Brunnian link. In peg mode this waits
until the slack is gone: applied to a loose comb it would just stretch the slack out.

**The peg drive is rate-limited, not gated.** A hard "stop when strained" cut-off deadlocks —
the system parks exactly at the threshold and never moves again, even after a snip has freed
the link. Easing peg speed to zero as the hoops approach their stretch limit lets a locked link
stall while a freed one keeps sliding.

**A jam is not a link, and the difference is measurable.** A snipped link would sometimes settle
with two rings still touching and simply stay there, which looks exactly like a failure to come
apart. It is worth checking which it is rather than assuming: linking numbers stayed at 0, the
closest approach anywhere in the simulation stayed at or above `repel` — so nothing had passed
through anything — and a firmer tug separated them to 5.0. They were never linked, merely wedged.

So the separation drift now escalates: the longer a pair fails to come apart while Pull is held,
the harder it is pushed, up to twelve times. Judging that pair by pair matters — one component
flying away keeps the overall size changing and masks the pair that is actually stuck. This
cannot invent a separation, and that was tested rather than assumed: an intact Borromean link
held at 0.19–0.32 under the full escalation, because genuinely linked rings do not come apart
however hard you pull, they just go taut.

**A freed ring needs a minimum size, not just a minimum shape.** Once a snip frees the word ring
nothing resists its contraction, so it ran all the way down to length 1.65 — a loop of radius
0.26 wrapped in a tube of radius 0.085. It had genuinely separated (7.2 clear of both hoops) but
it read as a solid lump rather than a ring. Every ring now has a floor on its total length, so
what you see after a cut is still recognisably a ring.

**Rest lengths are renormalised when a strand is resampled.** Rest is re-measured from current
positions, so a strand that happens to be stretched at that moment would adopt the stretched
length as its new rest and ratchet upward every time.

### Verification

Linking number is a topological invariant, so it must not change under relaxation. The
simulation was checked by computing pairwise linking numbers from signed crossings before and
after 2000+ frames of pulling: they are preserved, and they match the exponent sums of the
typed word. Because Borromean rings have all-zero linking numbers, that case was checked
separately — intact, the three stay locked together under outward pressure; snip one and all
three separate.

In peg mode a snip separates decisively for three rings: the word ring goes from touching both
hoops (0.14, 0.37) to 7.6 clear of each.

**Known limitation.** The four-ring `[[a,b],c]` does not fully come apart. Snipping stretches the
assembly out — extent goes from 5.0 to 13.4 — but the word ring stays draped on the remaining
hoops instead of dropping off. It is 23 units of slack rope that had to swallow 225 units of
initial comb, and those coils lock against each other once the rope has thickness; a tangle that
is topologically free is not necessarily one a damped solver can undo. Thinner rope was tried and
made it worse: it let the link break while still intact. Free mode remains the better
demonstration for the larger words.

### Every ring gets a peg, including the word ring

The word ring used to be the one component nothing dragged. The hoops were held by their pegs;
it merely rested against them, so after a snip it would often sit in the tangle rather than come
free. It now has a stump of its own — the flower has one slot per ring, and the word ring's path
takes a single turn around its slot, captured exactly the way each hoop is captured.

That turn runs beneath the plane, so it crosses no disk and leaves the word untouched. Verified
across every test word: winding is 0 about each hoop's peg (so it can always escape them) and 1
about its own stump. Borromean now goes from 0.14/0.37 while intact to **7.6/7.6** after a snip.

### Why a peg is not just an obstacle

Getting this wrong cost a release. A peg runs from the floor to the ceiling, so it is an
**infinite barrier**: if the word ring's path winds around one, it is threaded onto that peg
permanently and *no cut can ever free it*. The first version routed the word ring on lanes that
looped around the outside of the whole flower, which accumulated a full turn and gave winding 1
about every peg — so Borromean rings could be snipped and would still sit there taut, refusing
to come apart.

The winding number about each peg is not the same thing as the exponent sum, and it has to be
zero independently. Borromean is the clearest case: exponent sums are 0 (it is a commutator)
while the winding was 1. The fix is to choose which way round to travel between letters so the
running total stays near zero, then close the loop with exactly the opposite total.

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
