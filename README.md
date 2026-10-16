# next-steps

A Claude Code mod that turns Claude's latest reply into a numbered, tickable checklist of next steps in a side pane.

- One step per line, in the order to do them, each tagged by kind: PR, SQL, RUN, FILE, DEPLOY, REVIEW, CHECK, DO.
- SQL and commands shown verbatim in a highlighted box with a Copy button.
- Files linked to GitHub on your current branch, with a Copy path button.
- "Open a PR" steps get a ready-made GitHub link for the current branch.
- Tick steps off; the first unticked one is marked `← next`.
- Short or action-free replies leave the list alone.

Commands: `/next-steps` (open), `/next-steps refresh` (re-read the last reply), `/next-steps clear`.

Each long reply makes one small Haiku call to extract the steps.

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
