import { describe, expect, it } from 'vitest';
import { getLastTranscriptResponse, parseExternalCliTranscript } from '../src/web/response-viewer-transcript.js';

describe('response viewer transcript parser', () => {
  it('extracts structured COD transcript blocks and keeps labeled status/tool entries', () => {
    const transcript = `
╭──────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.143.0)                           │
│ model:     gpt-5.4 medium   /model to change         │
│ directory: /mnt/c/Users/aakhter/.../kb              │
╰──────────────────────────────────────────────────────╯

Tip: Use /side to start a side conversation in a temporary fork without polluting the main thread.

› i need to create a naming recommendation for project helix

gpt-5.4 medium · kb · main · Ready · Context 100% left

• Explored
  └ Read SKILL.md

Subject: Naming Recommendation for Project Helix

The product helps customers move virtual machine workloads between hypervisors while keeping operations
stable. It improves visibility into application dependencies, supports pre-migration validation, and reduces
the risk
and effort involved in moving workloads.

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(blocks.map((block) => block.kind)).toEqual([
      'status',
      'prompt',
      'status',
      'tool',
      'response',
      'prompt',
      'status',
    ]);
    expect(blocks[0]?.label).toBe('Status');
    expect(blocks[3]?.label).toBe('Tool');
    expect(blocks[4]?.text).toContain('reduces the risk and effort involved');
    expect(blocks[4]?.text).not.toContain('reduces\nthe risk');
  });

  it('returns the most recent completed response when the last block is a new prompt', () => {
    const transcript = `
› say again

Final polished answer
With two lines

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(getLastTranscriptResponse(blocks)).toBe('Final polished answer\nWith two lines');
  });

  it('drops box-drawing dividers from the last response and treats worked-for lines as status', () => {
    const transcript = `
────────────────────────────────────────────────────────────────────────

• The launcher supports CODEMAN_APP_DIR, so I can deploy this exact worktree without merging it back first.

────────────────────────────────────────────────────────────────────────

• Deployed.

The local Codeman service is now running from the worktree at app/.worktrees/cod-215-response-viewer on
commit 8bbcf77bafbdbf01a34653386c256b685898ad06.

Verified:

- process pid: 2708947
- HTTPS health: https://127.0.0.1:3000/ returned 401 as expected

One detail: I had to restart it outside the sandbox because the sandboxed launch path could not see tmux.

─ Worked for 1m 51s ───────────────────────────────────────────────────

› what are these lines in the middle column?
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(getLastTranscriptResponse(blocks)).toContain('• Deployed.');
    expect(getLastTranscriptResponse(blocks)).not.toContain('────────────────');
    expect(getLastTranscriptResponse(blocks)).not.toContain('Worked for 1m 51s');
    expect(blocks.some((block) => block.kind === 'status' && block.text === 'Worked for 1m 51s')).toBe(true);
  });

  // COD-226: multiline prompt continuations (2-space Codex gutter) must stay in the
  // Prompt block, not be misclassified as Response. The gutter is authoritative ahead
  // of every structural detector (divider, prompt-marker, tool, status).
  describe('COD-226 multiline prompt gutter is authoritative', () => {
    it('keeps bullet/prose continuations and internal blank lines in the Prompt block', () => {
      const transcript = `
› i think we can improve this slide. or maybe a follow on slide. here is what i'm thinking:
  * left hand side: current AI stack (frontier model, cloud hosted, sovereign concerns)
  right hand -> future enterprise stack: frontier model (optional, cloud), on-prem model router, OSS models

  make the point that the right hand side addresses the concerns.

gpt-5.4 medium · kb · main · Ready · Context 100% left

• Explored
  └ Read SKILL.md

Here is the actual assistant answer that starts at column zero and is a real response.

› next prompt
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      // Exactly two prompts, and the first holds the whole multiline prompt.
      expect(promptBlocks).toHaveLength(2);
      expect(promptBlocks[0]?.text).toContain('left hand side');
      expect(promptBlocks[0]?.text).toContain('right hand');
      expect(promptBlocks[0]?.text).toContain('make the point that the right hand side');

      // The continuation must NOT have leaked into a Response block.
      const responseBlocks = blocks.filter((b) => b.kind === 'response');
      expect(responseBlocks.some((b) => b.text.includes('make the point'))).toBe(false);
      expect(getLastTranscriptResponse(blocks)).toContain('actual assistant answer');
      expect(getLastTranscriptResponse(blocks)).not.toContain('make the point');
    });

    it('does not let an indented divider inside a prompt flush the Prompt block', () => {
      const transcript = `
› compare these two layouts
  first layout uses a single column
  ────────────────────────────
  second layout uses two columns

The response begins here at column zero.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('first layout');
      expect(promptBlocks[0]?.text).toContain('second layout uses two columns');
      expect(getLastTranscriptResponse(blocks)).toBe('The response begins here at column zero.');
    });

    it('treats a gutter-indented literal › as prompt content, not a new prompt', () => {
      const transcript = `
› here is my question about the ui
  › should this arrow start a new prompt?
  no it should not — it is part of my question

Answer at column zero.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      // The gutter-indented › must NOT open a second prompt.
      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('here is my question');
      expect(promptBlocks[0]?.text).toContain('no it should not');
      expect(getLastTranscriptResponse(blocks)).toBe('Answer at column zero.');
    });

    // The two exact live roadmap-tab examples from the ticket (AC: use both verbatim).
    it('live example 1: two-line prompt keeps the gutter continuation in the Prompt block', () => {
      const transcript = `
› create uid for each feature so it's easy to ref.
  for the p200 - why is diffentiation only 2/5?
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('create uid for each feature');
      expect(promptBlocks[0]?.text).toContain('for the p200 - why is diffentiation only 2/5?');
      // The continuation must not have leaked into a Response block.
      expect(blocks.some((b) => b.kind === 'response')).toBe(false);
    });

    it('live example 2: five-line prompt (bullet + prose + blank + prose) stays one Prompt block', () => {
      const transcript = `
› i think we can improve this slide. or maybe a follow on slide. here is what i'm thinking:
  * left hand side... current AI stack: (frontier model), large component cloud hosted, soverign concerns etc.
  right hand -> future-enterprise-stack: frontier-model (optional, in cloud), on-prem: model router, OSS models, rest of stack (gpus, data, etc.)

  make the point that the right hand side addresses the concerns.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('left hand side');
      expect(promptBlocks[0]?.text).toContain('right hand -> future-enterprise-stack');
      expect(promptBlocks[0]?.text).toContain('make the point that the right hand side addresses the concerns');
      expect(blocks.some((b) => b.kind === 'response')).toBe(false);
    });

    it('still separates a single-line prompt from a column-zero response (no regression)', () => {
      const transcript = `
› say again

Final polished answer at column zero.

› next
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(2);
      expect(promptBlocks[0]?.text).toBe('say again');
      expect(getLastTranscriptResponse(blocks)).toBe('Final polished answer at column zero.');
    });
  });

  // COD-227: Last Response must return the final assistant answer, not tool logs.
  // A response bullet beginning with a tool-like verb (• Created …) must not be
  // classified as Tool, and genuine • Calling / • Called blocks must be classified
  // as Tool. Disambiguator: a verb-bullet is a tool header only when followed by a
  // box-drawing result tree (└│├); Calling/Called are always tool markers.
  describe('COD-227 tool-header vs response disambiguation', () => {
    const MINIMAL_REPRO = `
› new jira issue

• The fresh read shows a formatting problem.

• Calling
└ atlassian.jira_update_issue({})

• Called atlassian.jira_get_issue({})
└ { result: true }

• Created COD-226: View Response → More misclassifies multiline prompt continuations as responses.

  It includes:

  - Two concrete failures
  - Regression-test criteria
`.trim();

    it('returns the final • Created … answer, not the Jira Calling/Called tool log', () => {
      const blocks = parseExternalCliTranscript(MINIMAL_REPRO, 'codex');
      const last = getLastTranscriptResponse(blocks);

      expect(last).toContain('Created COD-226');
      expect(last).toContain('Two concrete failures');
      // Must exclude tool invocations, raw results, and earlier commentary.
      expect(last).not.toContain('atlassian.jira');
      expect(last).not.toContain('Calling');
      expect(last).not.toContain('Called');
      expect(last).not.toContain('fresh read');
    });

    it('classifies genuine • Calling / • Called (with box-drawing results) as Tool', () => {
      const blocks = parseExternalCliTranscript(MINIMAL_REPRO, 'codex');
      const toolText = blocks
        .filter((b) => b.kind === 'tool')
        .map((b) => b.text)
        .join('\n');

      expect(toolText).toContain('Calling');
      expect(toolText).toContain('Called');
      expect(toolText).toContain('atlassian.jira_update_issue');
      // The final answer must not have been swallowed into the tool block.
      expect(toolText).not.toContain('Created COD-226');
    });

    it('labels the repro chronologically: Prompt, Response (commentary), Tool, Response (final)', () => {
      const blocks = parseExternalCliTranscript(MINIMAL_REPRO, 'codex');

      expect(blocks.map((b) => b.kind)).toEqual(['prompt', 'response', 'tool', 'response']);
      expect(blocks[1]?.text).toContain('fresh read');
      expect(blocks[3]?.text).toContain('Created COD-226');
    });

    it('does not classify a verb-prefixed prose bullet as Tool when no result tree follows', () => {
      const transcript = `
› do it

• Created COD-999: a brand new issue with a descriptive title.

  Follow-up prose that belongs to the same answer.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');

      expect(blocks.some((b) => b.kind === 'tool')).toBe(false);
      expect(getLastTranscriptResponse(blocks)).toContain('Created COD-999');
      expect(getLastTranscriptResponse(blocks)).toContain('Follow-up prose');
    });

    it('does not regress a genuine verb tool block that has a box-drawing continuation', () => {
      const transcript = `
› look around

• Explored
  └ Read SKILL.md

Here is the assistant answer at column zero.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');

      expect(blocks.some((b) => b.kind === 'tool' && b.text.includes('Explored'))).toBe(true);
      expect(getLastTranscriptResponse(blocks)).toBe('Here is the assistant answer at column zero.');
    });
  });
});
