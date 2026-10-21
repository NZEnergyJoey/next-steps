# next-steps

A Claude Code mod that turns Claude's replies into a prioritised, tickable list of next steps, and keeps it for each worktree.

## What you see

**A one-line bar above the prompt** (terminal and desktop):

```
◔  Now  Apply migration 97   Next steps · 3 pending · 1 for Claude   +2 new      #76 ↗   ✓ NZE/PAW   Open
```

The ring fills as you work through the round. The step in front leads, wearing its state (Now, Decide or Claude); `d` ticks it off, or, for a step with several databases, the next one (`✓ NZE/PAW`). A step that names a PR links to it. New steps wait quietly as `+2 new` until you open the panel, and a finished step lingers a moment as `✓ Done · …` while the next takes its place. It narrows with the window by dropping words, never wrapping; `Retry` appears only when a read has failed. Collapse it with the prompt's own `[-]`. On surfaces with no bar (VS Code, mobile) the same summary goes to the status line.

**A panel** (`o`, the `open` button, or `/next-steps`):

- Every step wears its state, in a colour, a glyph and a word, so it never rests on colour alone: ◐ **Now** (blue), ○ **Next** (purple), ◇ **Decide** (amber), ✦ **Claude** (orange), ◷ **Waiting** (grey), ◌ **Optional** (teal), ◌ **Earlier** (grey), ✓ **Done** (green), – **Skipped**. The bar above the prompt uses the same colours.
- Coloured tabs along the top: **To do** (the step in front, then *Up next* and *Claude can do*), **Optional**, **Earlier** (not mentioned lately) and **Done**, each with its count.
- The step in front sits in a card with why it matters, its link or file, and its SQL or command in a box with Copy; `▸` opens any other step the same way.
- **One migration, several databases.** When a reply says to run something on HKL, then NZE/PAW, it is one step with a chip for each place: tick them off as you go (the chips in the panel, or `d` in the panel or on the bar, which reads `✓ NZE/PAW`), and the last tick closes the step. The bar says which place is next, and `/next-steps list` shows what is ticked.
- **Steps that wait.** "Merge only after 97 is verified": the merge shows ◷ **Waiting** and *after 2*, never takes the spotlight while the migration is open, and moves up by itself once it is done.
- **Replies tick places too.** Paste HKL's preflight back and, when Claude says HKL is clean, HKL ticks itself.
- **Send result.** A step that wants its output back (a preflight query, what you saw) has `b` Send result, which starts that reply in the prompt for you to paste into.
- **Decisions with answers.** When Claude offers choices, each is listed (wrapping at any width) with its own Choose button (`y` the first, `n` the second); otherwise `y` approve / `n` decline. Either fills the prompt with your answer.
- **Pull requests a click away.** A step that names a PR ("Merge PR #76") links to it, in the panel and as `#76 ↗` on the bar; "Open a PR" links to the compare page.
- Claude's steps hand back with one key (`a` fills the prompt; nothing is sent for you).
- The header names the branch the list belongs to, so with many worktrees open you know whose list it is.
- Titles wrap inside their box at any width, and long paths and identifiers break rather than run past the edge.

Keys: `1`-`9` open a step, `c` copy, `p` copy path, `d` done, `s` skip, `a` ask Claude, `y`/`n` approve/decline (or the first two answers), `b` send result, `t` `o` `e` `h` switch tabs, `r` refresh, `Esc` close. Every control is a real button, so tab and enter work too.

## How it behaves

- A new reply **adds to** the list. A step that comes round again is the same step; one you ticked stays ticked (if a reply asks for the same thing again more than 30 minutes later, it counts as a new occurrence, e.g. run the tests again); one Claude says it finished is closed for you; one nobody mentions for three replies moves to Earlier and stops counting. A step said again in more words ("Merge PR #76 once both verifiers pass") is still the same step, and one part-way through its databases keeps its ticks when it is listed again for the ones left.
- Reads are one at a time: if a reply lands while one is being read, the newest is read next, and a reply already read is not read again unless you press Refresh (Refresh does not age older steps). A failed read is retried once, then shown with a `r` Refresh; your list is never wiped by a failure.
- Places come only from the reply ("HKL (project-id)" is read as HKL; "NZE/PAW" is one place), and only as a list of two or more. A step waits only for an earlier step of the same reply, and stops waiting once that one is done or has gone quiet (Earlier).
- The list is saved per worktree (4 MiB store, 30 worktrees, 90 days) and is there when you come back.
- Safety: SQL and commands are shown only if they appear in Claude's reply (indentation is ignored, line breaks are not), and are never shortened; code over 12,000 characters is left out rather than cut. A path must have its file name in the reply and may not climb out with `..`; links must appear in the reply and be http(s). Nothing is ever run or sent for you; hand-offs only fill the prompt for you to read and send.

Commands: `/next-steps` (open), `list` (print), `all` (what is open in every worktree: this one first, then the rest newest first, each with what waits on you and which databases are still to go), `done [n]`, `refresh`, `clear`, `help`.

Each long reply makes one small Haiku call (two if the first fails) to extract the steps; it is also sent the titles of your open steps, and the places each still has to go, so it can tell which a reply finished, wholly or in one place.

## Develop

```
claude plugin validate .
tsc -p .
claude plugin test .
```

Code is in `hooks/lib` (pure logic: `extract`, `merge`, `select`, `progress`, `git`, `store`, `model`, `text`) and `hooks/ui` (`taskbar`, `panel`, `tone` for the states' colours, `svg` for the drawn accents); `hooks/register.tsx` wires them. Tests are in `tests/`.

## Install

At the prompt of a terminal session:

```
/plugin install next-steps --marketplace nzenergyjoey/next-steps
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install next-steps --marketplace nzenergyjoey/next-steps
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nzenergyjoey/next-steps`, then Add plugin.

This repository is private: installing needs read access on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).
