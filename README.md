# session-tags

When you run many Claude Code sessions at once, it is hard to remember which one was doing what.
This Claude Code mod lets you comment and tag each session, give it a status, and then find it
again from a side pane.

- A band above the prompt shows the status, tags and comment of the current session.
- The `/sessions` pane lists all your sessions with their title, branch, message count, linked PR
  and how long ago they were active.
- Filter the list by status and by tag, and search words in titles and comments. Sessions marked
  `done` stay hidden behind a toggle.
- Press a session title to edit its tags, comment and status, or copy the command that resumes it
  (`cd '<folder>' && claude --resume <id>`).
- Tags autocomplete from the tags you already use.

## Commands

| Command | What it does |
| --- | --- |
| `/sessions` | Opens the pane with every session. |
| `/session-note [comment]` | Sets the comment of this session. An empty comment clears it. |
| `/session-tag <tag> [tag...]` | Adds tags to this session. |
| `/session-untag <tag> [tag...]` | Removes tags from this session. |
| `/session-status <status>` | Sets the status: `in-progress`, `waiting`, `blocked`, `done` or `none`. |

## Install

```text
/plugin install session-tags --marketplace RTeran/session-tags
```

## Requirements and data

- `python3` must be on your `PATH`. The mod runs `bin/transcript-meta.py` to read the title,
  branch, message count and PR of each session from the transcripts in `~/.claude/projects`.
- Comments, tags and statuses are saved as files in `~/.claude/session-tags`. A cache of the
  transcript metadata is kept in `~/.claude/session-tags/.cache`. Nothing leaves your machine.
- Only interactive sessions are tracked.

## License

MIT
