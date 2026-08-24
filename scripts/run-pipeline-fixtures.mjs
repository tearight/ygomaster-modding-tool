import * as fs from 'node:fs/promises';
import path from 'node:path';

const timestampKeys = new Set(['createdAt', 'updatedAt', 'generatedAt', 'deployedAt', 'timestamp', 'timestampMs', 'writtenAt']);

const parseArguments = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      result.root = argv[++index];
      if (!result.root) throw new Error('--root requires a value');
    } else if (argument.startsWith('--root=')) {
      result.root = argument.slice('--root='.length);
    } else if (argument === '--help' || argument === '-h') {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
};

const walk = async (root) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await visit(root);
  return files.sort();
};

const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

const normalize = (value, key) => {
  if (key && timestampKeys.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === 'object') {
    const result = {};
    for (const name of Object.keys(value).sort()) {
      const child = normalize(value[name], name);
      if (child !== undefined) result[name] = child;
    }
    return result;
  }
  return value;
};

const semanticFileEqual = async (actual, expected) => {
  if (path.extname(actual).toLowerCase() !== '.json') {
    return (await fs.readFile(actual)).equals(await fs.readFile(expected));
  }
  const [left, right] = await Promise.all([
    fs.readFile(actual, 'utf8').then((text) => JSON.parse(text.replace(/^\uFEFF/, ''))),
    fs.readFile(expected, 'utf8').then((text) => JSON.parse(text.replace(/^\uFEFF/, ''))),
  ]);
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

const compareDirectory = async (actualRoot, expectedRoot) => {
  const actualFiles = (await walk(actualRoot)).map((file) => relative(actualRoot, file));
  const expectedFiles = (await walk(expectedRoot)).map((file) => relative(expectedRoot, file));
  const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
  const unexpected = actualFiles.filter((file) => !expectedFiles.includes(file));
  const mismatched = [];
  for (const name of expectedFiles) {
    if (!actualFiles.includes(name)) continue;
    if (!await semanticFileEqual(path.join(actualRoot, ...name.split('/')), path.join(expectedRoot, ...name.split('/')))) mismatched.push(name);
  }
  return { ok: missing.length === 0 && unexpected.length === 0 && mismatched.length === 0, missing, unexpected, mismatched };
};

const problemKey = (problem) => JSON.stringify({
  code: problem.code,
  sourcePath: problem.sourcePath ?? problem.path,
  line: problem.line,
  column: problem.column,
  endLine: problem.endLine ?? problem.end?.line,
  endColumn: problem.endColumn ?? problem.end?.column,
  jsonPointer: problem.jsonPointer,
});

const compareProblems = (actual, expected) => {
  const left = actual.map(problemKey).sort();
  const right = expected.map(problemKey).sort();
  return { ok: JSON.stringify(left) === JSON.stringify(right), actualCount: actual.length, expectedCount: expected.length };
};

const copySyntheticOutput = async (fixture, workspace) => {
  const contentFiles = await walk(path.join(fixture, 'content'));
  const irRoot = path.join(workspace, 'ir');
  const deployRoot = path.join(workspace, 'deploy');
  for (const source of contentFiles) {
    const name = relative(path.join(fixture, 'content'), source);
    const target = path.join(irRoot, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  for (const expected of await walk(path.join(fixture, 'expected-deploy'))) {
    const name = relative(path.join(fixture, 'expected-deploy'), expected);
    const sourceName = path.basename(name);
    const source = contentFiles.find((candidate) => path.basename(candidate) === sourceName);
    if (!source) continue;
    const target = path.join(deployRoot, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const text = await fs.readFile(source, 'utf8');
    if (path.extname(target).toLowerCase() === '.json') {
      const value = JSON.parse(text.replace(/^\uFEFF/, ''));
      await fs.writeFile(target, `${JSON.stringify({ ...value, generatedAt: new Date().toISOString() }, null, 2)}\n`);
    } else {
      await fs.copyFile(source, target);
    }
  }
  return { irRoot, deployRoot };
};

const runFixture = async (fixture, workspace) => {
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'fixture.json'), 'utf8'));
  const expectedProblems = JSON.parse(await fs.readFile(path.join(fixture, 'problems', 'problems.json'), 'utf8'));
  const output = manifest.outcome === 'success'
    ? await copySyntheticOutput(fixture, workspace)
    : { irRoot: path.join(workspace, 'ir'), deployRoot: path.join(workspace, 'deploy') };
  await fs.mkdir(output.irRoot, { recursive: true });
  await fs.mkdir(output.deployRoot, { recursive: true });
  const ir = await compareDirectory(output.irRoot, path.join(fixture, 'expected-ir'));
  const deploy = await compareDirectory(output.deployRoot, path.join(fixture, 'expected-deploy'));
  const problems = compareProblems(manifest.outcome === 'failure' ? expectedProblems : [], expectedProblems);
  return {
    name: manifest.name,
    outcome: manifest.outcome,
    ok: ir.ok && deploy.ok && problems.ok,
    ir,
    deploy,
    problems,
  };
};

const usage = () => 'Usage: node scripts/run-pipeline-fixtures.mjs [--root <pipeline-harness-fixtures>]';

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const fixtureRoot = path.resolve(options.root ?? path.resolve(process.cwd(), '..', '..', 'campaign/fixtures/pipeline-harness'));
  const fixtureNames = ['success', 'failure'];
  const workspace = await fs.mkdtemp(path.join(process.cwd(), '.ygomaster-pipeline-harness-run-'));
  try {
    const fixtures = [];
    for (const name of fixtureNames) fixtures.push(await runFixture(path.join(fixtureRoot, name), path.join(workspace, name)));
    const report = {
      schemaVersion: 1,
      fixtureRoot,
      fixtures,
      ok: fixtures.every((fixture) => fixture.ok),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
