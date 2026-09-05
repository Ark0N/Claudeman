/**
 * @fileoverview The review brief handed to each reviewer session, and the follow-up
 * brief. Pure: the bot writes the result to a file and sends the session one short
 * line pointing at it (prompts are single-line over tmux, and a brief this size
 * belongs on disk anyway).
 *
 * The brief is opinionated on purpose. It names the repository's own rules (CLAUDE.md,
 * CONTRIBUTING.md), the checks to run, the verdict vocabulary, and the exact JSON the
 * bot parses. Everything the maintainer would say out loud before delegating a
 * review lives here.
 */
import type { CiStatus, PrDetail } from './github.js';

export const VERDICTS = ['merge', 'merge-with-fixes', 'request-changes', 'close', 'needs-discussion'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewBriefInput {
  pr: PrDetail;
  ci: CiStatus;
  mergeBase: string;
  worktreeDir: string;
  mainCheckout: string;
  reportJsonPath: string;
  reportMdPath: string;
}

function ciLine(ci: CiStatus): string {
  const detail = ci.runs.map((r) => `${r.name}: ${r.conclusion ?? r.status}`).join(', ');
  switch (ci.state) {
    case 'passed':
      return `passed (${detail})`;
    case 'failed':
      return `FAILED (${detail}); read the failing job's log with \`gh run view <id> --log-failed\` before you trust or dismiss it`;
    case 'pending':
      return `still running (${detail})`;
    case 'awaiting-approval':
      return 'never ran: the workflow is waiting for a maintainer to approve it (first-time contributor), so run the checks yourself';
    default:
      return 'no workflow runs found for this head (a conflicting PR gets no CI at all); run the checks yourself';
  }
}

export function buildReviewBrief(input: ReviewBriefInput): string {
  const { pr, ci, mergeBase, worktreeDir, mainCheckout, reportJsonPath, reportMdPath } = input;
  const files = pr.files.map((f) => `- \`${f.path}\` (+${f.additions}/-${f.deletions})`).join('\n');
  const linked = pr.linkedIssues.length
    ? pr.linkedIssues.map((i) => `- #${i.number} ${i.title}`).join('\n')
    : '- none linked';
  const mergeability =
    pr.mergeable === 'CONFLICTING'
      ? 'CONFLICTING with master. It cannot be merged as-is and GitHub runs no CI for it. Review the PR head as it stands, and say in the report whether the conflicts look mechanical or structural (`git merge-tree` against origin/master helps).'
      : pr.mergeable === 'MERGEABLE'
        ? 'mergeable'
        : 'unknown (GitHub has not computed it yet)';

  return `# Review brief: PR #${pr.number} ${pr.title}

You are reviewing a pull request against Codeman on behalf of the maintainer. You are
in a private clone at \`${worktreeDir}\`, checked out (detached) at the PR head. The
maintainer reads your report on a phone and decides what happens next, so write for
someone who has not seen the diff.

## Ground rules (read twice)

- Nothing you do here reaches GitHub. Do NOT push, comment, merge, close, label, or
  create anything with \`gh\`; \`gh\` is for READING only (\`gh pr view\`, \`gh run view\`,
  \`gh api\` GETs).
- Do NOT run \`npm install\`, \`npm ci\`, \`npm update\` or \`npm run build\`: \`node_modules\`
  may be a symlink into the maintainer's live checkout. Everything else in package.json
  scripts is fine (\`npm run typecheck\`, \`npm run lint\`, \`npm test -- <file>\`, ...).
- Do NOT restart, stop or install any service, and never bind port 3000: the
  maintainer's production Codeman runs there. Test ports are 3150 and up.
- \`${mainCheckout}\` is the maintainer's shared checkout. You may READ it for comparison;
  never run a git command there that changes anything (no checkout, reset, stash, clean).
- Stay inside this clone for writes. Do not create files elsewhere except the two
  report files named below.
- Do not ask questions. Nobody is watching this session. Where something is ambiguous,
  decide, and list the assumption in the report.

## The pull request

- **#${pr.number}** ${pr.title}
- Author: ${pr.author} (${pr.authorAssociation.toLowerCase().replace(/_/g, ' ')})${pr.headRepo ? `, from \`${pr.headRepo}\`` : ''}
- URL: ${pr.url}
- Base: \`${pr.baseRef}\` at merge base \`${mergeBase.slice(0, 12)}\`; head: \`${pr.headSha.slice(0, 12)}\` (${pr.commitCount} commits)
- Size: +${pr.additions} / -${pr.deletions} across ${pr.changedFiles} files
- Mergeability: ${mergeability}
- CI: ${ciLine(ci)}
- Draft: ${pr.isDraft ? 'yes' : 'no'}; existing comments: ${pr.commentCount}${pr.labels.length ? `; labels: ${pr.labels.join(', ')}` : ''}

### Linked issues
${linked}

### Files changed
${files || '- (none reported)'}

### PR description, verbatim
\`\`\`text
${pr.body.trim() || '(empty)'}
\`\`\`

## How to review

1. Read \`CLAUDE.md\` at the root and \`.github/CONTRIBUTING.md\`. Most review feedback on
   this repository traces back to a rule already written there, and a change that
   contradicts one of those rules is a finding even when the code works. Open the
   \`docs/architecture-invariants.md\` sections the change touches.
2. Understand the change: \`git log --oneline ${mergeBase.slice(0, 12)}..HEAD\` and
   \`git diff ${mergeBase.slice(0, 12)}..HEAD\`. Read the surrounding code, not only the
   hunks: the file's \`@fileoverview\` first, then the call sites of anything changed.
3. Look for, in this order: correctness bugs (wrong logic, races, missed error paths,
   lost state across restart); security (auth and ownership checks, path confinement,
   the env-prefix allowlist, shell/command injection, SSRF, secrets on the command
   line or in state files); violations of CLAUDE.md rules (cite the rule); behaviour
   changes without tests; contract changes (\`/api/v1\` paths, response envelope,
   \`errorCode\` values, SSE event names are public and stable, see
   \`docs/versioning-policy.md\`); scope (one change per PR: flag unrelated changes
   bundled in); docs and registries that must move with the code (CLAUDE.md and
   architecture-invariants when a rule changes, \`sse-events.ts\` and \`constants.js\`
   parity, \`docs/api-reference.md\`); housekeeping that does not belong in a PR
   (version bumps, CHANGELOG edits, files pulled back into Prettier's scope, committed
   vendor bundles, changeset files are fine).
4. Run the checks and record what you ran and what came back:
   \`npm run typecheck\`, \`npm run lint\`, \`npm run check:frontend-syntax\`,
   \`npm run format:check\`, then the tests covering the touched areas
   (\`npm test -- test/<file>.test.ts\`, several files at once is fine). Run the full
   \`npm test\` when the change is broad or touches shared infrastructure (session,
   tmux, routes, state); it takes minutes, which is acceptable. A red check that is
   also red on origin/master is not the PR's fault: say so rather than blaming it.
   Other test suites may be running on this machine at the same time and they share
   the 3150+ port range, so re-run a failed file on its own (\`npm test -- <file>\`)
   before you read an EADDRINUSE or a timeout as the PR's regression.
5. Verify before you report. A finding that could be a misread must be confirmed by
   reading the full code path, by a tiny test, or by running it. Every finding names a
   file and line. Rank: **blocker** (must be fixed before merge: data loss, security,
   breaks a documented invariant, breaks the build or tests), **major** (should be
   fixed: a real bug in an edge the PR introduces, a missing test for new behaviour),
   **minor**, **nit**.
6. Judge the PR, not the author. Contributors here are volunteers and the maintainer
   thanks them by name in every release; be exact and be kind.

## Verdict vocabulary

- \`merge\`: no blockers or majors, checks green; merge as-is.
- \`merge-with-fixes\`: mergeable, but with small things the maintainer would rather fix
  at merge time than round-trip (list them so they can be applied on top).
- \`request-changes\`: blockers or majors the author should fix.
- \`close\`: wrong direction, superseded, or not wanted; say what should happen instead.
- \`needs-discussion\`: a design question the maintainer must answer before anyone
  spends more time (name the question).

## Output, mandatory

Write BOTH files, then reply with exactly one line: \`REVIEW COMPLETE\`.

1. \`${reportJsonPath}\`: a single JSON object, no markdown fences, this shape:

\`\`\`json
{
  "verdict": "merge | merge-with-fixes | request-changes | close | needs-discussion",
  "confidence": "high | medium | low",
  "summary": "Two or three sentences: what the PR does, and the review's bottom line.",
  "changes": ["one bullet per thing the PR actually changes"],
  "findings": [
    {
      "severity": "blocker | major | minor | nit",
      "title": "one line",
      "file": "path/from/repo/root.ts",
      "line": 123,
      "detail": "what is wrong, why it matters, what to do instead",
      "invariant": "the CLAUDE.md / CONTRIBUTING rule it breaks, or omit"
    }
  ],
  "checks": [
    { "name": "typecheck", "command": "npm run typecheck", "result": "pass | fail | skipped", "notes": "" }
  ],
  "_checks_note": "result is from the PR's point of view: a regression test you deliberately ran against master to prove it fails is a pass (say so in notes), a red run caused by another suite on the machine is skipped with the reason, only a genuine problem with the PR is fail",
  "scope": "focused | mixed",
  "risk": "One or two sentences naming the judgment calls a second reviewer should look at.",
  "recommendation": "Two to four sentences for the maintainer: what to do next and why.",
  "draftComment": "A comment to the contributor, in markdown, ready to post (rules below).",
  "assumptions": ["anything you had to decide alone"]
}
\`\`\`

2. \`${reportMdPath}\`: the full report in markdown for the maintainer, in this order:
   what the PR does; the verdict with the reasoning; findings in severity order with
   file:line and the fix; checks run with results; CLAUDE.md rules touched; scope and
   risk; recommendation; assumptions. Include the diff stat. No length limit, but no
   padding either.

### Draft comment rules

The draft is written AS the maintainer TO the contributor and must stand alone: the
reader has not seen this brief. Open by thanking them and saying in one sentence what
the PR does. Then the findings that need action, each with file:line and the concrete
ask, blockers first. Close with what happens next (merge after fixes, will fix at merge
time, and so on). When the verdict is \`merge\`, the whole comment is a short thank-you
naming anything you would touch at merge time. Plain markdown. No em-dashes (use
commas, colons or parentheses). No emojis. No "Generated with Claude Code" or similar
attribution line. No hedging words. The maintainer reads it before it is posted and may
edit it.
`;
}

/** Sent as ONE line; the brief above is on disk. */
export function reviewKickoffLine(briefPath: string): string {
  return `Read ${briefPath} and carry out the review it describes. Do not ask questions. Finish by writing both report files it names, then reply with exactly: REVIEW COMPLETE`;
}

export function followupKickoffLine(followupPath: string): string {
  return `Read ${followupPath}: it holds a follow-up from the maintainer about the pull request you reviewed. Do what it asks within the ground rules of the original brief (no pushing, no gh writes, no npm install, no builds, no services), then answer in plain text. Do not ask questions.`;
}

export function buildFollowupBrief(input: {
  prNumber: number;
  title: string;
  instruction: string;
  worktreeDir: string;
  reportMdPath: string;
  briefPath: string;
}): string {
  return `# Follow-up on PR #${input.prNumber} ${input.title}

The maintainer read your review report (\`${input.reportMdPath}\`; the original brief is
\`${input.briefPath}\`, and its ground rules still apply: nothing reaches GitHub, no
installs, no builds, no services, writes stay inside \`${input.worktreeDir}\`).

Their message:

\`\`\`text
${input.instruction.trim()}
\`\`\`

Answer concisely and concretely, for a phone screen: lead with the answer, then the
evidence (commands run, file:line). If the message asks you to change code, make the
change in this clone, run the relevant checks, and describe the diff (\`git diff
--stat\` plus the essential hunks). Keep the changes uncommitted unless asked to commit;
never push. If it asks for something outside the ground rules, say so and stop.
`;
}
