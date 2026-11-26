// Remote text a menu may copy: a pasted newline or $(...) would run in a terminal.

const REF = /^[A-Za-z0-9._/-]{1,255}$/;
// No whitespace, controls, quotes, $, `, ;, &, | or brackets.
const LINK = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][A-Za-z0-9._~%/?#=+:@-]*)?$/;

export const copyableBranch = (s: string | undefined): string | undefined => (s && REF.test(s) ? s : undefined);

export const copyableLink = (s: string | undefined): string | undefined => (s && LINK.test(s) ? s : undefined);
