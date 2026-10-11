import { writeOperation } from '../lib/write.mjs';

const task = JSON.parse(process.argv[2]);
if (!['afterIntent', 'afterPublish', 'afterRef'].includes(task.barrier)) throw new Error('Unknown stage 2a barrier.');
const result = writeOperation(task.tool, task.input, {
  directory: task.directory,
  barrier(name, record) {
    if (name !== task.barrier) return;
    process.send({ barrier: name, operationId: record.id, commit: record.git.commit });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
