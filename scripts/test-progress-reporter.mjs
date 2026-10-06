import {spec} from 'node:test/reporters';
import {basename, resolve} from 'node:path';
import {Readable} from 'node:stream';

export async function* progressEvents(source) { // Add immediate progress messages while preserving every event for Node's standard reporter.
  let filesStarted = 0, filesFinished = 0, testsReported = 0;
  const files = new Map(), testNumbers = new Map();
  for await (const event of source) {
    const {type, data} = event;
    const isFile = data.file && data.name && resolve(data.name) === resolve(data.file); // File wrapper events identify workers; individual tests have descriptive names.
    let message;
    if (type === 'test:dequeue') {
      if (isFile) {
        files.set(data.file, ++filesStarted);
        message = `[File ${filesStarted}] RUNNING ${basename(data.file)} (${filesFinished} files finished)`;
      }
    } else if (type === 'test:complete') {
      if (isFile) {
        filesFinished++;
        message = `[File ${files.get(data.file)}] ${data.details.passed ? 'PASS' : 'FAIL'} ${basename(data.file)} (${filesFinished}/${filesStarted} started files finished)`;
      }
    }
    if (message) yield {type: 'test:stdout', data: {message: `${message}\n`}}; // Plain lines stay readable in terminals and redirected update logs.
    if (['test:start', 'test:pass', 'test:fail'].includes(type) && !isFile) {
      const key = JSON.stringify([data.file, data.line, data.column, data.nesting, data.name]);
      if (type === 'test:start' || !testNumbers.has(key)) testNumbers.set(key, ++testsReported);
      yield {...event, data: {...data, name: `[Test ${testNumbers.get(key)}] ${data.name}`}}; // Keep paired start/result names identical for Node's standard reporter.
    } else {
      yield event;
    }
  }
}

export default async function* progressReporter(source) { // Keep standard assertion details, skips and final totals alongside live numbered progress.
  yield* Readable.from(progressEvents(source)).compose(new spec());
}
