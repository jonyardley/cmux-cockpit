# cockpit_pane

The cockpit in a terminal: a ratatui pane that draws the core's All view,
the way the sidebar looks, and takes keys and drags for acting on its
cards. The pane itself writes nothing: the runner hands each action to
the core, and the core's cmux calls and state writes go out through the
runner's outbox.

- `src/model.rs` builds the `PaneModel` from the core's `Model`: every
  word and colour token the pane draws. The core's view model names
  workspaces by id, and a card's title, status and detail come from the
  core's session reads, so the pane builds from the whole model.
- `src/placing.rs` works out where `m`, shift with Up or Down, and a
  drag would place a card: a lane and the card it lands above.
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
| Up, Down, the wheel | Move the cursor between the Needs you rows and the cards |
| Shift with Up or Down | Reorder the card in its lane |
| `m`, then 1 to 5 | Move the card to the end of that lane (Esc cancels) |
| Drag a card | Move it to a lane, or above another card |
| Enter | Switch to the card's workspace |
| `d` | Dismiss the card from Needs you |
| `r` | Send a card showing "To review →" to For review |
| `p` | Park a merged card showing Park: file it into Parked |
| `x` | Close a merged card showing Close: close its workspace |
| `k` | Keep a merged card: hide its Park and Close for this PR (also in its Space menu) |
| `+` | Open a new session in the project's folder (in Projects) |
| `e` | Edit the project under the cursor (in Projects) |
| `n` | Make a new project (in Projects) |
| Space | Open the card's menu, or a project's on its header or quiet row; Up and Down move, Enter picks |
| Tab | Flip between All and Projects, in the pane and the sidebar |
| `?` | Show or hide the keys |
| Esc | Hide the keys, close a menu or the editor, or drop a drag |
| `q`, Ctrl-C | Quit |

Each of these comes back to the runner as an `Outcome::Act`; the live
pane hands it to the core straight away, which makes the cmux calls and
state writes, and draws the core's new view before the next key. Tab
flips the view in the core, so the sidebar flips with it.

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
