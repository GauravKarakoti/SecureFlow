import { describe, it, expect } from 'vitest';
import {
  IGNORED_BASENAMES,
  IGNORED_DIRECTORIES,
  IGNORED_EXTENSIONS,
  basenameOf,
  hasIgnoredBasename,
  hasIgnoredExtension,
  ignoreReasonFor,
  isUnderIgnoredDirectory,
  normalizeScanPath,
  pathSegments,
  shouldIgnorePath,
} from './ignore-rules';
import { compileIgnorePatterns, shouldIgnore } from './scanner';

describe('normalizeScanPath', () => {
  it('lower-cases and unifies separators', () => {
    expect(normalizeScanPath('Src\\Lib\\Auth.TS')).toBe('src/lib/auth.ts');
  });

  it('strips a leading ./ or /', () => {
    expect(normalizeScanPath('./src/app.ts')).toBe('src/app.ts');
    expect(normalizeScanPath('/src/app.ts')).toBe('src/app.ts');
  });
});

describe('pathSegments / basenameOf', () => {
  it('drops empty segments from a doubled separator', () => {
    expect(pathSegments('src//lib/auth.ts')).toEqual(['src', 'lib', 'auth.ts']);
  });

  it('reads the basename', () => {
    expect(basenameOf('apps/web/package.json')).toBe('package.json');
    expect(basenameOf('package.json')).toBe('package.json');
    expect(basenameOf('')).toBe('');
  });
});

describe('isUnderIgnoredDirectory', () => {
  it('matches a segment at the root or nested', () => {
    expect(isUnderIgnoredDirectory('dist/output.js', 'dist/')).toBe(true);
    expect(isUnderIgnoredDirectory('apps/web/dist/output.js', 'dist/')).toBe(true);
  });

  it('does not match a directory that merely contains the rule as a substring', () => {
    // The bug, stated directly. `'build/'.includes` matched every one of these.
    expect(isUnderIgnoredDirectory('scripts/prebuild/inject.ts', 'build/')).toBe(false);
    expect(isUnderIgnoredDirectory('packages/api-build/src/auth.ts', 'build/')).toBe(false);
    expect(isUnderIgnoredDirectory('infra/redist/creds.ts', 'dist/')).toBe(false);
  });

  it('requires a multi-segment rule to appear as a consecutive run', () => {
    expect(isUnderIgnoredDirectory('prisma/migrations/001.sql', 'prisma/migrations/')).toBe(true);
    expect(isUnderIgnoredDirectory('apps/api/prisma/migrations/001.sql', 'prisma/migrations/')).toBe(
      true
    );
    expect(isUnderIgnoredDirectory('myprisma/migrations/001.sql', 'prisma/migrations/')).toBe(false);
    expect(isUnderIgnoredDirectory('prisma/schema/migrations/001.sql', 'prisma/migrations/')).toBe(
      false
    );
  });

  it('does not treat a file named after the rule as a directory match', () => {
    // `src/build` is a file called build, not a build directory.
    expect(isUnderIgnoredDirectory('src/build', 'build/')).toBe(false);
  });
});

describe('hasIgnoredExtension', () => {
  it('keeps the endsWith behaviour, which was already boundary-correct', () => {
    expect(hasIgnoredExtension('package-lock.json')).toBe(true);
    expect(hasIgnoredExtension('readme.md')).toBe(true);
    expect(hasIgnoredExtension('apps/web/tsconfig.json')).toBe(true);
    expect(hasIgnoredExtension('src/logo.svg')).toBe(true);
  });

  it('does not fire on a path that merely contains the extension', () => {
    expect(hasIgnoredExtension('src/md-renderer.ts')).toBe(false);
    expect(hasIgnoredExtension('src/csv-export.ts')).toBe(false);
  });
});

describe('hasIgnoredBasename', () => {
  it('matches the configuration files exactly', () => {
    expect(hasIgnoredBasename('package.json')).toBe(true);
    expect(hasIgnoredBasename('apps/web/package.json')).toBe(true);
    expect(hasIgnoredBasename('.gitignore')).toBe(true);
    expect(hasIgnoredBasename('prisma.config.ts')).toBe(true);
  });

  it('does not match a source file whose name merely contains one', () => {
    // The second half of the bug: the old rule was not anchored to a separator
    // at all, so any path carrying these eleven characters was dropped.
    expect(hasIgnoredBasename('tools/package.json.generator.ts')).toBe(false);
    expect(hasIgnoredBasename('src/config/gitignore-parser.ts')).toBe(false);
    expect(hasIgnoredBasename('docs/package.json-schema.ts')).toBe(false);
  });
});

describe('ignoreReasonFor', () => {
  it('names the rule that fired', () => {
    expect(ignoreReasonFor('node_modules/pkg/index.js')).toBe('directory');
    expect(ignoreReasonFor('README.md')).toBe('extension');
    expect(ignoreReasonFor('package.json')).toBe('config-file');
    expect(ignoreReasonFor('src/app.ts', compileIgnorePatterns(['src/']))).toBe('custom');
  });

  it('returns null for a file that should be scanned', () => {
    expect(ignoreReasonFor('src/app.ts')).toBeNull();
  });

  it('treats an empty filename as scannable rather than throwing', () => {
    expect(ignoreReasonFor('')).toBeNull();
    expect(ignoreReasonFor('   ')).toBeNull();
  });
});

describe('shouldIgnorePath — files that must still be ignored', () => {
  const stillIgnored = [
    'dist/output.js',
    'build/main.js',
    '.next/static/chunk.js',
    'node_modules/package/index.js',
    'prisma/migrations/20260101_init/migration.sql',
    'apps/web/node_modules/left-pad/index.js',
    'package-lock.json',
    'package.json',
    'components.json',
    'prisma.config.ts',
    '.gitignore',
    'README.md',
    'docs/architecture.md',
    'public/logo.svg',
    'data/export.csv',
    'yarn.lock',
    'pnpm-lock.yaml',
  ];

  it.each(stillIgnored)('still ignores %s', (path) => {
    expect(shouldIgnorePath(path)).toBe(true);
  });
});

describe('shouldIgnorePath — files that were being skipped and should not be', () => {
  // Every one of these returned true under the old substring matching, so the
  // AI never read them, and the pull request still received a PASS and a "Scan
  // completed successfully" comment naming a file count that included them.
  const wronglySkipped = [
    'scripts/prebuild/inject-secrets.ts',
    'scripts/postbuild/sign.ts',
    'packages/api-build/src/auth.ts',
    'infra/gradle-build/settings.ts',
    'infra/redist/credentials.ts',
    'services/cdndist/keys.ts',
    'tools/package.json.generator.ts',
    'docs/package.json-schema.ts',
    'src/config/gitignore-parser.ts',
    'apps/web/components.json.builder.ts',
    'myprisma/migrations/loader.ts',
  ];

  it.each(wronglySkipped)('now scans %s', (path) => {
    expect(shouldIgnorePath(path)).toBe(false);
  });

  it('still scans ordinary source files', () => {
    expect(shouldIgnorePath('src/app.ts')).toBe(false);
    expect(shouldIgnorePath('src/components/Button.tsx')).toBe(false);
  });

  it('still scans .env.example, which is where a real committed key shows up', () => {
    expect(shouldIgnorePath('.env.example')).toBe(false);
    expect(shouldIgnorePath('.env.sample')).toBe(false);
  });
});

describe('custom .secureflowignore patterns', () => {
  it('are applied unchanged', () => {
    const compiled = compileIgnorePatterns(['custom-dir/']);
    expect(shouldIgnorePath('custom-dir/some-file.ts', compiled)).toBe(true);
    expect(shouldIgnorePath('src/some-file.ts', compiled)).toBe(false);
  });

  it('are matched against a separator-normalised path', () => {
    const compiled = compileIgnorePatterns(['vendor/']);
    expect(shouldIgnorePath('vendor\\lib\\thing.ts', compiled)).toBe(true);
  });
});

describe('the rule tables themselves', () => {
  it('has not lost an entry in the move out of scanner.ts', () => {
    expect(IGNORED_DIRECTORIES).toEqual([
      'dist/',
      'build/',
      '.next/',
      'node_modules/',
      'prisma/migrations/',
    ]);
    expect(IGNORED_BASENAMES).toEqual([
      'package.json',
      'components.json',
      'prisma.config.ts',
      '.gitignore',
    ]);
    expect(IGNORED_EXTENSIONS).toContain('.md');
    expect(IGNORED_EXTENSIONS).toContain('lock.json');
  });
});

describe('scanner.shouldIgnore still delegates here', () => {
  it('agrees with shouldIgnorePath, so the ~10 existing importers are unaffected', () => {
    for (const path of [
      'dist/output.js',
      'src/app.ts',
      'package.json',
      'scripts/prebuild/inject-secrets.ts',
    ]) {
      expect(shouldIgnore(path)).toBe(shouldIgnorePath(path));
    }
  });
});
