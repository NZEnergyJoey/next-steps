# next-steps

A Claude Code mod that turns Claude's replies into a prioritised, tickable list of next steps, and keeps it for each worktree.

## What you see

**A one-line bar above the prompt** (terminal and desktop):

```
● Next steps · 3 pending (1 for Claude · 1 optional) · Run the invoices migration     done  open
```

It shows how many steps wait on you, how many are Claude's or optional, and the one to do first. It narrows with the window: the extras and label go first, then the Done/Ask buttons, and the title is shortened rather than dropped. `retry` appears only when a read has failed. Collapse it with the prompt's own `[-]`. On surfaces with no bar (VS Code, mobile) the same summary goes to the status line.

**A panel** (`o`, the `open` button, or `/next-steps`):

- **To do**: what needs you, in the order Claude gave them.
- **Claude can do**: steps you can hand back with one key (`a` fills the prompt; nothing is sent for you).
- Folded away until asked for: **Optional**, **Earlier, not mentioned lately**, **Done**.
- Open one step to see why it matters, its link or file, and its SQL or command in a box with Copy.
- Decisions get `y` approve / `n` decline, which fill the prompt with your answer.

Keys: `1`-`9` open a step, `c` copy, `p` copy path, `d` done, `s` skip, `a` ask Claude, `y`/`n` approve/decline, `r` refresh, `Esc` close. Every control is a real button, so tab and enter work too.

## How it behaves

- A new reply **adds to** the list. A step that comes round again is the same step; one you ticked stays ticked (if a reply asks for the same thing again more than 30 minutes later, it counts as a new occurrence, e.g. run the tests again); one Claude says it finished is closed for you; one nobody mentions for three replies moves to Earlier and stops counting.
- Reads are one at a time: if a reply lands while one is being read, the newest is read next, and a reply already read is not read again unless you press Refresh (Refresh does not age older steps). A failed read is retried once, then shown with a `r` Refresh; your list is never wiped by a failure.
- The list is saved per worktree (4 MiB store, 30 worktrees, 90 days) and is there when you come back.
- Safety: SQL and commands are shown only if they appear in Claude's reply (indentation is ignored, line breaks are not), and are never shortened; code over 12,000 characters is left out rather than cut. A path must have its file name in the reply and may not climb out with `..`; links must appear in the reply and be http(s). Nothing is ever run or sent for you; hand-offs only fill the prompt for you to read and send.

Commands: `/next-steps` (open), `list` (print), `done [n]`, `refresh`, `clear`, `help`.

Each long reply makes one small Haiku call (two if the first fails) to extract the steps; it is also sent the titles of your open steps so it can tell which a reply finished.

## Develop

```
claude plugin validate .
tsc -p .
claude plugin test .
```

Code is in `hooks/lib` (pure logic: `extract`, `merge`, `select`, `git`, `store`, `model`, `text`) and `hooks/ui` (`taskbar`, `panel`); `hooks/register.tsx` wires them. Tests are in `tests/`.

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
