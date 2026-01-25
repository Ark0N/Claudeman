#!/usr/bin/env node
/**
 * Test script for link detection patterns
 */

const patterns = {
  cmdPattern: /(tail|cat|head|less|grep|watch|multitail)\s+(?:[^\/\n]+?\s+)?(\/[^\s"'<>|;&\n\)]+)/g,
  bashPathPattern: /Bash\([^)]*?(\/(?:var|tmp|home|usr|etc|opt|log|logs)[^\s"'<>|;&\)\n]+)/g,
  generalPathPattern: /(\/(?:home|tmp|var|etc|usr|opt)[^\s"'<>|;&\n\)\]]+\.(?:log|txt|json|md|ts|js|sh|py|yaml|yml|csv|xml|html|css))/g,
  logPathPattern: /(\/var\/log\/[^\s"'<>|;&\n\)\]]+)/g,
  claudeOutputPattern: /(?:Created|Writing|Saved|File|Output|Streaming|Monitoring|Log)(?:\s+(?:file|to|at))?[:\s]+([\/~][^\s"'<>|;&\n\)]+)/gi
};

const tests = [
  'tail -f /tmp/test.log',
  'tail -n 100 /var/log/syslog',
  'cat /home/user/file.txt',
  'head -n 10 /etc/passwd',
  'Bash(tail -f /tmp/test.log)',
  'Created file: /tmp/newfile.log',
  'Writing to /home/user/output.txt',
  'Monitoring file: /var/log/syslog',
  'Streaming /home/user/logs/app.log',
  '/home/arkon/project/file.log',
  '/tmp/test-output.txt',
  'echo "tail -f /tmp/test.log"',
  'The output is in /home/user/results.csv',
  'plain text without paths'
];

console.log('Link Pattern Test Results\n');

for (const [name, pattern] of Object.entries(patterns)) {
  console.log(`\n=== ${name} ===`);
  console.log(`Pattern: ${pattern.source}\n`);

  for (const test of tests) {
    pattern.lastIndex = 0;
    const matches = [];
    let m;
    while ((m = pattern.exec(test)) !== null) {
      // Get the captured group (varies by pattern)
      matches.push(m[1] || m[2]);
    }
    if (matches.length > 0) {
      console.log(`  ✓ "${test}"`);
      console.log(`    → Found: ${matches.join(', ')}`);
    }
  }
}

console.log('\n\n=== Combined Test ===');
console.log('Testing all patterns on each input:\n');

for (const test of tests) {
  const allMatches = [];
  for (const [name, pattern] of Object.entries(patterns)) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(test)) !== null) {
      const path = m[1] || m[2];
      if (path && !allMatches.includes(path)) {
        allMatches.push(path);
      }
    }
  }
  if (allMatches.length > 0) {
    console.log(`✓ "${test}"`);
    console.log(`  → ${allMatches.join(', ')}`);
  } else {
    console.log(`✗ "${test}" - no match`);
  }
}
