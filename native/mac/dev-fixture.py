"""Writes a golden scene as data.json, as cockpit-publish writes it, with
every time in it moved from the scene's clock to now (dev-fixture.sh).

    python3 dev-fixture.py <scene.input.json> <home> <out.json>

The sidebar moves the core's clock to now every two seconds, so each time
the core compares with its clock, or with another time, moves by the same
whole number of seconds: the gap between now and the scene's data.epoch.
Each time is named by its path below, from native/core/src/data.rs (data)
and persist.rs (state), so a number that is not a time (a PR's number, a
folded lane's 1) stays as it is. A time of 0 or less means unknown to the
core and stays too. Each Ostinato record line's time moves by the same
step, so a run in progress still reads as one.
"""

import datetime
import json
import sys
import time

# "*" is any key of a map or any item of a list.
DATA_TIMES = (
    ("epoch",),
    ("workspaces", "*", "latestAt"),
    ("workspaces", "*", "agents", "*", "sinceEpoch"),
    ("workspaces", "*", "agents", "*", "lastActivityAt"),
    ("workspaces", "*", "agents", "*", "stopped", "since"),
    ("workspaces", "*", "agents", "*", "children", "*", "startedEpoch"),
    ("workspaces", "*", "agents", "*", "children", "*", "endedEpoch"),
    ("backgroundSessions", "*", "startedEpoch"),
)
STATE_TIMES = (
    # An agent's spell, CI's or Ostinato's key: each matches a time above.
    ("dismissed", "*", "*"),
    ("prs", "*", "readySince"),
    ("prs", "*", "checks", "*", "queued"),
    ("prs", "*", "checks", "*", "started"),
    ("subagents", "*", "*", "startedEpoch"),
    ("subagents", "*", "*", "endedEpoch"),
    ("background", "*", "*", "startedEpoch"),
    ("background", "*", "*", "seenEpoch"),
    ("running", "*", "since"),
    ("asking", "*", "epoch"),
    ("moves", "*", "epoch"),
    ("asleep", "*", "since"),
    ("notified", "*", "since"),
    ("notified", "*", "ci"),
    ("notified", "*", "down"),
    ("poll", "okEpoch"),
)


def is_time(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def move(node, path, step):
    """Adds step to each time at path under node."""
    if not path:
        return
    head, rest = path[0], path[1:]
    if isinstance(node, dict):
        keys = list(node) if head == "*" else [head] if head in node else []
    elif isinstance(node, list) and head == "*":
        keys = range(len(node))
    else:
        return
    for key in keys:
        if rest:
            move(node[key], rest, step)
        elif is_time(node[key]):
            node[key] += step


def moved_line(line, step):
    try:
        row = json.loads(line)
        at = datetime.datetime.strptime(row["at"], "%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, KeyError, TypeError):
        return line
    at = at.replace(tzinfo=datetime.timezone.utc)
    when = datetime.datetime.fromtimestamp(at.timestamp() + step, datetime.timezone.utc)
    row["at"] = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    return json.dumps(row, separators=(",", ":"))


def main(scene_path, home, out_path):
    with open(scene_path) as f:
        scene = json.load(f)
    now = time.time()
    out = {"seq": 0, "written_at_ms": int(now * 1000), "home": home}
    out.update({k: scene.get(k) for k in ("projects", "state", "ostinato", "data")})
    data = out.get("data") if isinstance(out.get("data"), dict) else {}
    clock = data.get("epoch")
    # Whole seconds, so a record line's time, kept to the second, moves as
    # far as every other time does.
    step = round(now - clock) if is_time(clock) else 0
    for path in DATA_TIMES:
        move(out.get("data"), path, step)
    for path in STATE_TIMES:
        move(out.get("state"), path, step)
    for record in ((out.get("ostinato") or {}).get("records") or {}).values():
        record["text"] = "".join(moved_line(l, step) + "\n" for l in record["text"].splitlines())
    with open(out_path, "w") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main(*sys.argv[1:4])
