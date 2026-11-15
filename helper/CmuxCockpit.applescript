-- Template for the cmux-cockpit:// URL handler helper app (docs/state-loop.md).
-- scripts/install-helper.ts fills in the placeholders below and compiles this
-- with osacompile; this file on its own still has __ROOT__, __FINDER__ and
-- __SCRIPT__ in it and is never run directly.
--
-- Node is found at tap time by scripts/find-node.sh rather than baked in, so
-- the helper keeps working after a Node upgrade.
--
-- Every piece of theURL is untrusted, so it only ever reaches the shell
-- through "quoted form of": nothing here concatenates it unquoted.

on open location theURL
	set repoRoot to "__ROOT__"
	set finderPath to repoRoot & "/__FINDER__"
	set scriptPath to repoRoot & "/__SCRIPT__"
	-- No node found, or a refused or failed URL, exits non-zero, which would
	-- raise a modal error dialog; find-node.sh or state-set.ts has already
	-- logged it, so stay silent here.
	try
		set nodePath to do shell script "/bin/sh " & (quoted form of finderPath)
		do shell script (quoted form of nodePath) & " " & (quoted form of scriptPath) & " " & (quoted form of theURL)
	end try
end open location
