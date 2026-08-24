import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CONTENT_FORMAT_VERSION,
  ContentFormatError,
  MigrationRegistry,
  applyContentMigration,
  contentDiagnostic,
  createContentEnvelope,
  lexSectionedLines,
  normalizeSymbolicKey,
  normalizeSymbolicReference,
  parseContentEnvelope,
  parseSectionedDocument,
  previewContentMigration,
  semanticEqual,
  validateContentEnvelope,
} from '../src/core/content-format';

const roots: string[] = [];
const fixtureRoot = path.resolve(__dirname, '../../../campaign/fixtures/content-format');

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ygomaster-content-format-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('strict versioned content envelopes and diagnostics', () => {
  it('parses v1 JSON while preserving unknown fields and rejects future versions', async () => {
    const fixture = JSON.parse(await readFile(path.join(fixtureRoot, 'envelope-v1.json'), 'utf8')) as Record<string, unknown>;
    const envelope = parseContentEnvelope(fixture);
    assert.equal(envelope.formatVersion, CONTENT_FORMAT_VERSION);
    assert.equal(envelope.kind, 'fixture');
    assert.deepEqual(envelope.payload, fixture.payload);
    assert.deepEqual(envelope.fixtureUnknown, { preserve: true });
    assert.deepEqual(validateContentEnvelope(envelope), []);
    assert.deepEqual(createContentEnvelope('fixture', { value: 1 }), {
      formatVersion: 1,
      kind: 'fixture',
      payload: { value: 1 },
    });

    const future = validateContentEnvelope({ ...fixture, formatVersion: CONTENT_FORMAT_VERSION + 1 });
    assert.equal(future.some((entry) => entry.code === 'CONTENT_FORMAT_VERSION_FUTURE'), true);
    assert.throws(
      () => parseContentEnvelope(JSON.stringify({ ...fixture, formatVersion: CONTENT_FORMAT_VERSION + 1 }), { sourcePath: 'future.json' }),
      (error: unknown) => error instanceof ContentFormatError && error.problems.some((entry) => entry.jsonPointer === '/formatVersion'),
    );
    assert.throws(() => parseContentEnvelope('{"formatVersion":1,"kind":"fixture","payload":{/* no comments */}}'), (error: unknown) => {
      return error instanceof ContentFormatError && error.problems[0]?.code === 'CONTENT_JSON_MALFORMED';
    });
  });

  it('reports stable source spans and JSON pointers', () => {
    const diagnostic = contentDiagnostic({
      code: 'FIXTURE_ERROR',
      message: 'bad field',
      sourcePath: 'fixture.json',
      span: { sourcePath: 'fixture.json', line: 3, column: 4, endLine: 3, endColumn: 9 },
      jsonPointer: '/payload/name',
    });
    assert.equal(diagnostic.path, 'fixture.json');
    assert.equal(diagnostic.sourcePath, 'fixture.json');
    assert.equal(diagnostic.line, 3);
    assert.equal(diagnostic.column, 4);
    assert.equal(diagnostic.endLine, 3);
    assert.equal(diagnostic.endColumn, 9);
    assert.deepEqual(diagnostic.end, { line: 3, column: 9 });
    assert.equal(diagnostic.jsonPointer, '/payload/name');
    assert.deepEqual(diagnostic.sourceSpan, { sourcePath: 'fixture.json', line: 3, column: 4, endLine: 3, endColumn: 9 });
  });

  it('reports an EOF span at the insertion point and the root JSON pointer', () => {
    assert.throws(
      () => parseContentEnvelope('{"formatVersion":1,', { sourcePath: 'eof.json' }),
      (error: unknown) => {
        if (!(error instanceof ContentFormatError)) return false;
        const diagnostic = error.problems[0];
        assert.equal(diagnostic?.code, 'CONTENT_JSON_MALFORMED');
        assert.equal(diagnostic?.jsonPointer, '');
        assert.equal(diagnostic?.sourcePath, 'eof.json');
        assert.equal(diagnostic?.line, 1);
        assert.equal(diagnostic?.column, 20);
        assert.equal(diagnostic?.endLine, 1);
        assert.equal(diagnostic?.endColumn, 20);
        return true;
      },
    );
  });

  it('counts a solitary CR as a line ending for malformed JSON spans', () => {
    assert.throws(
      () => parseContentEnvelope('{"formatVersion":1,\r', { sourcePath: 'cr-eof.json' }),
      (error: unknown) => {
        if (!(error instanceof ContentFormatError)) return false;
        const diagnostic = error.problems[0];
        assert.equal(diagnostic?.jsonPointer, '');
        assert.equal(diagnostic?.line, 2);
        assert.equal(diagnostic?.column, 1);
        assert.equal(diagnostic?.endLine, 2);
        assert.equal(diagnostic?.endColumn, 1);
        return true;
      },
    );
  });

  it('normalizes symbolic keys and namespaced references deterministically', () => {
    assert.equal(normalizeSymbolicKey('  Gate  One / Café  '), 'gate-one-café');
    assert.equal(normalizeSymbolicKey('ＧＡＴＥ＿１'), 'gate_1');
    assert.deepEqual(normalizeSymbolicReference(' Gate : Opening One '), {
      raw: ' Gate : Opening One ',
      namespace: 'gate',
      key: 'opening-one',
      normalized: 'gate:opening-one',
    });
    assert.throws(() => normalizeSymbolicKey('---'), (error: unknown) => error instanceof ContentFormatError && error.problems[0]?.code === 'SYMBOLIC_KEY_EMPTY');
  });
});

describe('sectioned line lexer/parser', () => {
  it('handles BOM, CRLF/LF, blank/comment lines, Unicode, and preserves source lines', async () => {
    const fixture = await readFile(path.join(fixtureRoot, 'sectioned-valid.decklist'), 'utf8');
    const source = `\uFEFF${fixture.replace(/\n/gu, '\r\n')}`;
    const lexed = lexSectionedLines(source, 'fixture.decklist');
    assert.equal(lexed.hadBom, true);
    assert.equal(lexed.lines[0]?.raw.startsWith('\uFEFF'), true);
    assert.equal(lexed.lines[0]?.lineEnding, '\r\n');
    assert.equal(lexed.diagnostics.length, 0);

    const parsed = parseSectionedDocument(source, { sourcePath: 'fixture.decklist' });
    assert.equal(parsed.parserVersion, 1);
    assert.equal(parsed.hadBom, true);
    assert.equal(parsed.diagnostics.length, 0);
    assert.deepEqual(parsed.sections.map((section) => section.normalizedName), ['main', 'extra']);
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.entries[1]?.value, '2 "Unicode café"');
    assert.deepEqual(parsed.entries[1]?.tokens, ['2', 'Unicode café']);
    assert.equal(parsed.entries[0]?.raw, '1 Blue-Eyes White Dragon');
    assert.equal(parsed.lines.some((line) => line.normalized.kind === 'comment'), true);
    assert.equal(parsed.lines.some((line) => line.normalized.kind === 'blank'), true);
    assert.equal(parsed.sections[1]?.entries[0]?.section, 'extra');
  });

  it('diagnoses malformed section and quote lines without losing the AST', async () => {
    const source = await readFile(path.join(fixtureRoot, 'sectioned-malformed.packlist'), 'utf8');
    const parsed = parseSectionedDocument(source, 'malformed.packlist');
    const codes = new Set(parsed.diagnostics.map((entry) => entry.code));
    assert.equal(codes.has('CONTENT_LINE_UNTERMINATED_SECTION'), true);
    assert.equal(codes.has('CONTENT_LINE_UNTERMINATED_QUOTE'), true);
    assert.equal(codes.has('CONTENT_LINE_EMPTY_SECTION'), true);
    assert.equal(codes.has('CONTENT_LINE_SECTION_TRAILING_TEXT'), true);
    assert.equal(parsed.diagnostics.every((entry) => entry.sourcePath === 'malformed.packlist'), true);
    assert.equal(parsed.diagnostics.every((entry) => typeof entry.line === 'number' && typeof entry.column === 'number' && typeof entry.endColumn === 'number'), true);
    assert.equal(parsed.lines.filter((line) => line.normalized.kind === 'invalid').length, 4);
    assert.equal(parsed.lines[1]?.raw, '1 "unterminated');
  });

  it('recognizes all supported comment markers without treating quoted markers as comments', () => {
    const parsed = parseSectionedDocument([
      '# hash',
      '; semicolon',
      '// slash',
      '[main]',
      '1 "A # B // C ; D" # trailing',
    ].join('\n'));
    assert.equal(parsed.diagnostics.length, 0);
    assert.equal(parsed.lines.filter((line) => line.normalized.kind === 'comment').length, 3);
    assert.deepEqual(parsed.entries[0]?.tokens, ['1', 'A # B // C ; D']);
    assert.equal(parsed.entries[0]?.value, '1 "A # B // C ; D"');
    assert.equal(parsed.lines[4]?.comment, 'trailing');
  });
});

describe('version migrations', () => {
  it('runs only registered adjacent migrations and keeps preview/apply semantically equal', () => {
    const registry = new MigrationRegistry();
    registry.register(1, 2, (value) => {
      const document = value as { formatVersion: number; payload: { name: string } };
      return { payload: { name: document.payload.name.toUpperCase() }, formatVersion: 2 };
    }, 'uppercase-name');
    registry.register(2, 3, (value) => ({ ...(value as Record<string, unknown>), formatVersion: 3, migrated: true }), 'mark-migrated');
    const source = { formatVersion: 1, payload: { name: 'legacy' } } as const;
    const preview = registry.preview(source, 1, 3);
    const applied = registry.apply(source, 1, 3);
    assert.deepEqual(source, { formatVersion: 1, payload: { name: 'legacy' } });
    assert.equal(preview.changed, true);
    assert.deepEqual(preview.document, { formatVersion: 3, payload: { name: 'LEGACY' }, migrated: true });
    assert.equal(semanticEqual(preview.document, applied.document), true);
    assert.deepEqual(preview.steps, ['uppercase-name', 'mark-migrated']);
    assert.throws(() => registry.preview(source, 1, 4), (error: unknown) => error instanceof ContentFormatError && error.problems[0]?.code === 'MIGRATION_PATH_MISSING');
    assert.throws(() => registry.register(1, 2, (value) => value), (error: unknown) => error instanceof ContentFormatError && error.problems[0]?.code === 'MIGRATION_STEP_DUPLICATE');
  });

  it('rejects migration output whose formatVersion is missing or not the step target', () => {
    const missingVersion = new MigrationRegistry().register(1, 2, () => ({ payload: { ok: true } }));
    assert.throws(
      () => missingVersion.apply({ formatVersion: 1, payload: {} }, 1, 2, 'missing-version.json'),
      (error: unknown) => error instanceof ContentFormatError && error.problems[0]?.code === 'MIGRATION_OUTPUT_VERSION_MISMATCH',
    );
    const wrongVersion = new MigrationRegistry().register(1, 2, () => ({ formatVersion: 3, payload: {} }));
    assert.throws(
      () => wrongVersion.apply({ formatVersion: 1, payload: {} }, 1, 2, 'wrong-version.json'),
      (error: unknown) => error instanceof ContentFormatError && error.problems[0]?.code === 'MIGRATION_OUTPUT_VERSION_MISMATCH',
    );
  });

  it('previews without writing and applies through the atomic JSON helper boundary', async () => {
    const root = await makeRoot();
    const filePath = path.join(root, 'migration.json');
    await writeFile(filePath, await readFile(path.join(fixtureRoot, 'migration-v1.json')));
    const registry = new MigrationRegistry().register(1, 2, (value) => ({ ...(value as Record<string, unknown>), formatVersion: 2, migrated: true }));
    const preview = await previewContentMigration(filePath, registry, 2);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).formatVersion, 1);
    const applied = await applyContentMigration(filePath, registry, 2);
    assert.equal(semanticEqual(preview.document, applied.document), true);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), applied.document);
  });
});
