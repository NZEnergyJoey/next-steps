# next-steps

A Claude Code mod that turns Claude's replies into a prioritised, tickable list of next steps, and keeps it for each worktree.

## What you see

**A one-line bar above the prompt** (terminal and desktop):

```
● Next steps · 3 pending (1 for Claude · 1 optional) · Run the invoices migration     retry  done  open
```

It shows how many steps wait on you, how many are Claude's or optional, and the one to do first. It narrows gracefully: on a small window it drops the extras, then the title, then the buttons. Collapse it with the prompt's own `[-]`. On surfaces with no bar (VS Code, mobile) the same summary goes to the status line.

**A panel** (`o`, the `open` button, or `/next-steps`):

- **To do**: what needs you, with decisions first, in the order to do them.
- **Claude can do**: steps you can hand back with one key (`a` fills the prompt; nothing is sent for you).
- Folded away until asked for: **Optional**, **Earlier, not mentioned lately**, **Done**.
- Open one step to see why it matters, its link or file, and its SQL or command in a box with Copy.
- Decisions get `y` approve / `n` decline, which fill the prompt with your answer.

Keys: `1`-`9` open a step, `c` copy, `p` copy path, `d` done, `s` skip, `a` ask Claude, `y`/`n` approve/decline, `r` refresh, `Esc` close. Every control is a real button, so tab and enter work too.

## How it behaves

- A new reply **adds to** the list. A step that comes round again is the same step; one you ticked stays ticked; one Claude says it finished is closed for you; one nobody mentions for three replies moves to Earlier and stops counting.
- Reads are one at a time: if a reply lands while one is being read, the newest is read next, and the same reply is never read twice. A failed read is retried once, then shown with a `r` Refresh; your list is never wiped by a failure.
- The list is saved per worktree (4 MiB store, 30 worktrees, 90 days) and is there when you come back.
- Safety: SQL, commands, paths and links are shown only if they really appear in Claude's reply, are never shortened, and links are http(s) only. Nothing is ever run or sent for you.

Commands: `/next-steps` (open), `list` (print), `done [n]`, `refresh`, `clear`, `help`.

Each long reply makes one small Haiku call to extract the steps.

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
