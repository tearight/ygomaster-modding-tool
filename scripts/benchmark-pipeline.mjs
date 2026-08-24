import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const parseArguments = (argv) => {
  const result = { agentSteps: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fixture' || argument === '--output' || argument === '--agent-steps') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--fixture') result.fixture = value;
      else if (argument === '--output') result.output = value;
      else result.agentSteps = Number(value);
      continue;
    }
    if (argument.startsWith('--fixture=')) result.fixture = argument.slice('--fixture='.length);
    else if (argument.startsWith('--output=')) result.output = argument.slice('--output='.length);
    else if (argument.startsWith('--agent-steps=')) result.agentSteps = Number(argument.slice('--agent-steps='.length));
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(result.agentSteps) || result.agentSteps < 0) {
    throw new Error('--agent-steps must be a non-negative integer');
  }
  return result;
};

const walk = async (root) => {
  const files = [];
  const visit = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await visit(root);
  return files.sort();
};

const measure = async (name, action) => {
  const started = performance.now();
  const value = await action();
  return { value, timing: { name, durationMs: Number((performance.now() - started).toFixed(3)) } };
};

const atomicWrite = async (filePath, text) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, text, 'utf8');
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
};

const usage = () => `Usage: node scripts/benchmark-pipeline.mjs [options]

Options:
  --fixture <path>       Fixture root to scan
  --output <path>        Write report atomically instead of stdout
  --agent-steps <count>  Record agent step count (default: 0)
`;

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const fixture = path.resolve(
    options.fixture ?? path.resolve(process.cwd(), '..', '..', 'campaign/fixtures/pipeline-harness/success'),
  );
  const scanned = await measure('fixture-scan', () => walk(fixture));
  const read = await measure('fixture-read', async () => {
    let bytes = 0;
    for (const file of scanned.value) bytes += (await fs.stat(file)).size;
    return { files: scanned.value.length, bytes };
  });
  const report = {
    schemaVersion: 1,
    fixture,
    generatedAt: new Date().toISOString(),
    timings: [scanned.timing, read.timing],
    agentSteps: options.agentSteps,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await atomicWrite(path.resolve(options.output), serialized);
  else process.stdout.write(serialized);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
