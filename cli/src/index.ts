#!/usr/bin/env node

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

export function formatFinding(finding: {
  type: string;
  severity: string;
  file: string;
  line?: number;
}): string {
  const loc = finding.line ? `:${finding.line}` : '';
  return `[${finding.severity}] ${finding.type} — ${finding.file}${loc}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('Usage: secureflow [--repo <name>] [--verbose]');
    process.exit(0);
  }

  if (args.verbose) {
    console.log('SecureFlow CLI — verbose mode enabled');
  }

  console.log('Parsed args:', args);
}

main();
