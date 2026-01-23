import { describe, it, expect } from 'vitest';
import { buildTaskSpec } from '../src/mcp-server.js';

describe('mcp-server', () => {
  describe('buildTaskSpec', () => {
    it('should build minimal task spec with required fields only', () => {
      const result = buildTaskSpec({
        agentId: 'test-001',
        name: 'Test Agent',
        instructions: 'Do something useful.',
      });

      expect(result).toContain('---');
      expect(result).toContain('agentId: test-001');
      expect(result).toContain('name: Test Agent');
      expect(result).toContain('Do something useful.');

      // Should not contain optional fields
      expect(result).not.toContain('type:');
      expect(result).not.toContain('priority:');
      expect(result).not.toContain('maxTokens:');
      expect(result).not.toContain('maxCost:');
      expect(result).not.toContain('timeoutMinutes:');
      expect(result).not.toContain('contextFiles:');
      expect(result).not.toContain('dependsOn:');
    });

    it('should include all optional fields when provided', () => {
      const result = buildTaskSpec({
        agentId: 'full-agent',
        name: 'Full Agent',
        instructions: 'Complete task.',
        type: 'implement',
        priority: 'high',
        maxTokens: 200000,
        maxCost: 1.50,
        timeoutMinutes: 60,
        canModifyParentFiles: true,
        contextFiles: ['src/auth.ts', 'src/types.ts'],
        dependsOn: ['agent-a', 'agent-b'],
        completionPhrase: 'FULL_DONE',
        outputFormat: 'structured',
        successCriteria: 'All tests pass',
        workingDir: '/tmp/workspace',
      });

      expect(result).toContain('agentId: full-agent');
      expect(result).toContain('name: Full Agent');
      expect(result).toContain('type: implement');
      expect(result).toContain('priority: high');
      expect(result).toContain('maxTokens: 200000');
      expect(result).toContain('maxCost: 1.5');
      expect(result).toContain('timeoutMinutes: 60');
      expect(result).toContain('canModifyParentFiles: true');
      expect(result).toContain('contextFiles: [src/auth.ts, src/types.ts]');
      expect(result).toContain('dependsOn: [agent-a, agent-b]');
      expect(result).toContain('completionPhrase: FULL_DONE');
      expect(result).toContain('outputFormat: structured');
      expect(result).toContain('successCriteria: "All tests pass"');
      expect(result).toContain('workingDir: /tmp/workspace');
      expect(result).toContain('Complete task.');
    });

    it('should produce valid YAML frontmatter structure', () => {
      const result = buildTaskSpec({
        agentId: 'yaml-test',
        name: 'YAML Test',
        instructions: 'Body content here.',
      });

      const lines = result.split('\n');
      expect(lines[0]).toBe('---');

      // Find closing ---
      const closingIndex = lines.indexOf('---', 1);
      expect(closingIndex).toBeGreaterThan(0);

      // Body should come after closing ---
      const body = lines.slice(closingIndex + 1).join('\n').trim();
      expect(body).toBe('Body content here.');
    });

    it('should escape double quotes in successCriteria', () => {
      const result = buildTaskSpec({
        agentId: 'escape-test',
        name: 'Escape Test',
        instructions: 'test',
        successCriteria: 'Output "hello" correctly',
      });

      expect(result).toContain('successCriteria: "Output \\"hello\\" correctly"');
    });

    it('should handle empty context files array', () => {
      const result = buildTaskSpec({
        agentId: 'empty-ctx',
        name: 'Empty Context',
        instructions: 'test',
        contextFiles: [],
      });

      expect(result).not.toContain('contextFiles:');
    });

    it('should handle empty dependsOn array', () => {
      const result = buildTaskSpec({
        agentId: 'empty-deps',
        name: 'Empty Deps',
        instructions: 'test',
        dependsOn: [],
      });

      expect(result).not.toContain('dependsOn:');
    });

    it('should handle canModifyParentFiles: false', () => {
      const result = buildTaskSpec({
        agentId: 'no-modify',
        name: 'No Modify',
        instructions: 'test',
        canModifyParentFiles: false,
      });

      expect(result).toContain('canModifyParentFiles: false');
    });

    it('should handle multiline instructions', () => {
      const instructions = `# Step 1
Do this first.

# Step 2
Then do this.

## Notes
- Important detail
- Another detail`;

      const result = buildTaskSpec({
        agentId: 'multiline',
        name: 'Multiline',
        instructions,
      });

      expect(result).toContain('# Step 1');
      expect(result).toContain('Do this first.');
      expect(result).toContain('# Step 2');
      expect(result).toContain('- Important detail');
    });

    it('should be parseable by parseYamlFrontmatter', async () => {
      const { parseYamlFrontmatter } = await import('../src/spawn-types.js');

      const result = buildTaskSpec({
        agentId: 'parse-test',
        name: 'Parse Test',
        instructions: 'Verify parsing works.',
        type: 'explore',
        priority: 'high',
        maxTokens: 100000,
        timeoutMinutes: 15,
      });

      const parsed = parseYamlFrontmatter(result);
      expect(parsed).not.toBeNull();
      expect(parsed!.frontmatter.agentId).toBe('parse-test');
      expect(parsed!.frontmatter.name).toBe('Parse Test');
      expect(parsed!.frontmatter.type).toBe('explore');
      expect(parsed!.frontmatter.priority).toBe('high');
      expect(parsed!.frontmatter.maxTokens).toBe(100000);
      expect(parsed!.frontmatter.timeoutMinutes).toBe(15);
      expect(parsed!.body).toBe('Verify parsing works.');
    });

    it('should produce spec parseable by parseTaskSpecFile', async () => {
      const { parseTaskSpecFile } = await import('../src/spawn-types.js');

      const result = buildTaskSpec({
        agentId: 'full-spec',
        name: 'Full Spec Agent',
        instructions: 'Do the work.',
        type: 'implement',
        priority: 'critical',
        maxTokens: 250000,
        maxCost: 2.0,
        timeoutMinutes: 45,
        canModifyParentFiles: true,
        completionPhrase: 'SPEC_DONE',
        outputFormat: 'json',
      });

      const parsed = parseTaskSpecFile(result, 'fallback-id');
      expect(parsed).not.toBeNull();
      expect(parsed!.spec.agentId).toBe('full-spec');
      expect(parsed!.spec.name).toBe('Full Spec Agent');
      expect(parsed!.spec.type).toBe('implement');
      expect(parsed!.spec.priority).toBe('critical');
      expect(parsed!.spec.maxTokens).toBe(250000);
      expect(parsed!.spec.maxCost).toBe(2.0);
      expect(parsed!.spec.timeoutMinutes).toBe(45);
      expect(parsed!.spec.canModifyParentFiles).toBe(true);
      expect(parsed!.spec.completionPhrase).toBe('SPEC_DONE');
      expect(parsed!.spec.outputFormat).toBe('json');
      expect(parsed!.instructions).toBe('Do the work.');
    });

    it('should handle contextFiles in parseable format', async () => {
      const { parseYamlFrontmatter } = await import('../src/spawn-types.js');

      const result = buildTaskSpec({
        agentId: 'ctx-parse',
        name: 'Context Parse',
        instructions: 'test',
        contextFiles: ['src/foo.ts', 'src/bar.ts'],
      });

      const parsed = parseYamlFrontmatter(result);
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed!.frontmatter.contextFiles)).toBe(true);
      const files = parsed!.frontmatter.contextFiles as string[];
      expect(files).toContain('src/foo.ts');
      expect(files).toContain('src/bar.ts');
    });
  });
});
