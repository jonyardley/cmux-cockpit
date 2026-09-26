-- Template for the cmux-cockpit:// URL handler helper app (docs/state-loop.md).
-- scripts/install-helper.ts fills in the placeholders below and compiles this
-- with osacompile; this file on its own still has __NODE__, __ROOT__ and
-- __SCRIPT__ in it and is never run directly.
--
-- Every piece of theURL is untrusted, so it only ever reaches the shell
-- through "quoted form of": nothing here concatenates it unquoted.

on open location theURL
	set nodePath to "__NODE__"
	set repoRoot to "__ROOT__"
	set scriptPath to repoRoot & "/__SCRIPT__"
	-- A refused or failed URL exits non-zero, which would raise a modal error
	-- dialog; state-set.ts has already logged it, so stay silent here.
	try
		do shell script (quoted form of nodePath) & " " & (quoted form of scriptPath) & " " & (quoted form of theURL)
	end try
end open location
