import { writeOperation } from '../lib/write.mjs';

const task = JSON.parse(process.argv[2]);
if (!['afterIntent', 'afterPublish', 'afterRef', 'afterMovePath', 'afterAllAfterBytes', 'afterCandidate', 'duringIndex', 'afterCommitted', 'duringCreate'].includes(task.barrier)) throw new Error('Unknown fault barrier.');
const result = writeOperation(task.tool, task.input, {
  directory: task.directory,
  barrier(name, record, file) {
    if (name !== task.barrier || task.path && file?.path !== task.path) return;
    process.send({ barrier: name, path: file?.path ?? null, operationId: record.id, commit: record.git.commit });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
