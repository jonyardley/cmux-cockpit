# cockpit_pane

The cockpit in a terminal: a ratatui pane that draws the core's All view,
the way the sidebar looks. Read only; nothing here writes to cmux or the
state file.

- `src/model.rs` builds the `PaneModel` from the core's `Model`: every
  word and colour token the pane draws. The core's view model names
  workspaces by id, and a card's title, status and detail come from the
  core's session reads, so the pane builds from the whole model.
- `src/cursor.rs` holds the card cursor and how far the lanes scroll to
  keep it in sight; `src/text.rs` fits words into columns, only ever
  cutting between words.
- `src/theme.rs` maps each core colour token to the sidebar's hex. The
  pane paints the sidebar's light ground under everything.
- `src/views/` lays the model out: the view switch and Next, Needs you,
  the lanes, and the `?` keys overlay. No decisions live there.
- `Pane` (`src/lib.rs`) is what a runner drives: `set_view_model` with a
  new `PaneModel`, `handle_event` with each terminal event, and `draw`,
  which draws only when the model, a key or the terminal size changed.

## Keys

| Key | Does |
| --- | --- |
| Up, Down | Move the cursor between cards |
| `?` | Show or hide the keys |
| Esc | Hide the keys |
| `q`, Ctrl-C | Quit |

## Opening it in a cmux split

Until the live runner (#206) lands, the pane draws one of the golden
scenes from `test/golden/` through `examples/scene.rs`. From a terminal
in cmux, in the repo:

```sh
cmux new-split right --command "cargo run --manifest-path $PWD/native/Cargo.toml -p cockpit_pane --example scene -- lanes"
```

That opens a split to the right of the focused pane and draws the
`lanes` scene. The other scenes are `needs-and-next`, `projects` and
`review-verdicts`. Drag the split's edge to resize it: the pane redraws
at the new width. `q` closes it.

To run it in the current terminal instead:

```sh
cd native && cargo run -p cockpit_pane --example scene -- needs-and-next
```

`--html <columns>` prints the scene as a coloured HTML page, for a
picture without a terminal:

```sh
cd native && cargo run -p cockpit_pane --example scene -- lanes --html 40 > lanes.html
```

## Tests

`tests/scenes.rs` draws each golden scene on ratatui's `TestBackend` at
40 and 80 columns and compares the text with `tests/snapshots/`. It also
checks no word on screen is cut mid-line, that the pane redraws cleanly
after a resize and only when something changed, and the keys. After a
change on screen you meant, re-record and read the diff:

```sh
cd native && UPDATE_SNAPSHOTS=1 cargo test -p cockpit_pane
```
