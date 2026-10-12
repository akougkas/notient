# Live acceptance on this machine

Execute stage 1, then 2a, then 2b; start stage 3 only after its reviewed implementation and operator installation. These are acceptance instructions, not recorded passes. Resolve accepted T1 through T9 fixes before write acceptance. Tokenizer uncertainty must refuse the whole move; a refusal never authorizes another writer or cleanup of the source syntax.

## Session and machine gates

- Operator setup and both installs must already be complete from a plain terminal. The live toy vault is `/home/akougkas/.local/share/notient/live-toy-vault`, initially clean at `118e16a`; use this copy, never the repository fixture. Record any later authorized baseline explicitly.
- Vaultex is `/mnt/c/Users/akougk/Projects/vaultex`, initially read-only with 168 uncommitted files against one initial commit. Preserve their exact bytes, modes and staging. Setup/install/access changes and committing an operator baseline are never model actions.
- Use released 0.6.2 `run`, not `-p`. Each invocation below is a fresh session unless `--session` is explicit. Command tools run there; API 2 runtimes and their reminders do not start. Headless asks are denied even with `--autonomy yolo`; a denied or missing required call blocks that check.
- Keep affected notes, monthly logs and staging quiescent. Retain the disclosed revision-recheck-to-rename race. All normal vault writes and undo use Notient command tools. The single fixture-only IPC fault injection below is the existing test harness, not a production kill switch.
- Execute command lines separately and inspect each run's evidence before its next write or undo. Immediately record each process exit status beside its JSONL. Do not rerun a failed write with fresh IDs. Use status and its original ID first. Stop on partial/conflicted work, unknown coverage, truncated required results or an unreviewed change. No stage 4 work is authorized.

```bash
N_ROOT=/home/akougkas/projects/notient
N_TOY=/home/akougkas/.local/share/notient/live-toy-vault
N_VAULTEX=/mnt/c/Users/akougk/Projects/vaultex
N_OWN=/home/akougkas/.local/share/notient/clio-vault
N_A=/home/akougkas/projects/notient-wt/design
N_B=/home/akougkas/iowarp/clio-coder
N_DATA=/home/akougkas/.local/state/notient
N_RUN="live-$(date -u +%Y%m%dT%H%M%SZ)"
N_OUT="/home/akougkas/.local/share/notient/acceptance/$N_RUN"
mkdir -p "$N_OUT"
N_RULES='Use the installed notient-vault-manager skill and discover extension_notient__ tools through gateway. Call capabilities individually. Use only those tools for vault access and writes. I authorize exactly the stated changes, their complete dry-run previews and reference repairs, and their stated undo; proceed after a matching preview without an interview. For writes use origin operator and request exactly: Live Notient acceptance: perform only the specified changes and their undo. Read before edit; retain returned revisions, paths, plan hashes and operation IDs. Stop on any refusal or unexpected diff. Never run setup, install, shell writes, Git mutations or a substitute writer. Report actual receipts, not a plan.'
```

Verify `N_DATA`, own-vault path and roles against actual status; change these shell variables to registered values if operator setup used different XDG paths. Do not manufacture a registration. Retain stdout as JSONL, stderr separately and each process exit status. Success requires exit 0 plus the evidence below; a fluent answer alone does not pass.

## Common disk evidence and JSON frames

Define this read-only vault inspection helper. It writes evidence only beneath `N_OUT`. Call it before a stage, after its writes, and after undo, using the labels below. Retain raw Git blobs for every changed path from the returned OIDs with `git -C <vault> cat-file blob <oid>:<path>`; compare Buffers, including BOM, CRLF and EOF newline, rather than rendered Markdown.

```bash
n_snapshot() {
  git --no-optional-locks -C "$1" rev-parse HEAD > "$N_OUT/$2.head"
  git --no-optional-locks -C "$1" status --porcelain=v1 -z > "$N_OUT/$2.status"
  git --no-optional-locks -C "$1" log -20 --format=fuller --name-status > "$N_OUT/$2.log"
  git --no-optional-locks -C "$1" ls-files --stage -z > "$N_OUT/$2.staged"
  node --input-type=module - "$1" "$N_ROOT" > "$N_OUT/$2.bytes.json" <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
const [root, repo] = process.argv.slice(2), files = [];
function walk(dir) { for (const name of fs.readdirSync(dir).sort()) { if (dir === root && name === '.git') continue; const full = path.join(dir,name), s = fs.lstatSync(full), relative = path.relative(root,full); if (s.isDirectory()) walk(full); else if (s.isFile()) files.push({path:relative,mode:s.mode & 0o777,sha256:createHash('sha256').update(fs.readFileSync(full)).digest('hex')}); else files.push({path:relative,kind:'nonregular'}); } }
walk(root); const {normalIndexEntries} = await import(pathToFileURL(path.join(repo,'clio/notient-extension/lib/git.mjs')));
const index = [...normalIndexEntries(root).entries].map(([name,e]) => ({path:name,entry:e.bytes.toString('hex')}));
process.stdout.write(JSON.stringify({files,index},null,2)+'\n');
NODE
}
n_snapshot "$N_TOY" s1-toy-before
n_snapshot "$N_VAULTEX" s1-vaultex-before
```

- Require first frame `{type:"session",schemaVersion:1,mode:"main",id,cwd}` with the requested canonical cwd; retain `target`, `model`, `clioCoderVersion` when present. Match `tool_execution_start` and `tool_execution_end` by `toolCallId`, using `toolName:"extension_notient__<name>"` and `via:"gateway"`. Starts carry the actual capability `args`, not a narration of a proposed call.
- Successful ends carry `isError:false`, `result.content` text containing the command's JSON, and `result.details` with `capability`, `exitCode:0`, `durationMs`, `timedOut:false`, `outputCapped:false`. Decode the text JSON as `P` below. A nonzero command can lose its stdout payload at the host boundary; retain the error frame/stderr instead of inventing `P.error`.
- `turn_end.message.content` must contain the final answer or receipt. Do not require a dispatch `receipt` frame from a main-agent run. Gateway discovery or skill loading can add other frames; they cannot substitute for the named capability calls. Never use terminal-only JSON mode for this evidence.
- Every normal write needs preview `P.outcome:"preview"`, 64-hex `planHash`, complete `changes[].{path,before,after,diff,splices}` and null commit; execution must reuse that hash and request ID. Execution requires `ok:true`, `outcome:"committed"`, matching `requestId/operationId`, `batch`, `commit.{oid,parent}`, `log.{path,line}`, `changes`, `undo`, `indexState`, `derivedIndexState`, `warnings`, `timings`. Both index states must eventually be `updated` through refresh/status before declaring the stage complete; a published pending commit is not permission to repeat the write. Already-saved identical retries may return `already_committed` with the same OID; intended byte-identical metadata may return `noop` without a new operation. These do not replace the required successful creation/revise/move demonstrations.
- Inspect each new commit with `git log --format=fuller` and `git show --format=fuller --stat <oid>`: Notient author, operation/path subject, batch/origin/request/destination/reverts trailers, and only planned notes plus the monthly log. Parse each new `Notient/Log/<YYYY-MM>.md` bullet after `- ` as JSON; require one line per committed operation with `time,id,operation,note,destination,batch,origin,request,files,undo`. Previous log bytes remain a prefix. No preview/no-op log line.
- Restore means exact original non-log file bytes and modes, removal of newly created notes, preserved unrelated raw index entries, and no pending intents. Git inverse commits, historical audit lines and harmless empty created directories remain. Never reset HEAD, clean the vault, edit logs or prune the journal to fake restoration.

## Stage 1: toy evidence, then read-only Vaultex

```bash
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_TOY. Call status, refresh with force true, then refresh again unchanged. Search query storage durability with limit 5. Read a returned note and cite an exact passage answering what the vault says about storage durability. Also read 3-resources/storage/Key-Value Store Design.md. Finish with status. Make no vault changes." > "$N_OUT/s1-toy.jsonl" 2> "$N_OUT/s1-toy.stderr"
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_VAULTEX. Require readOnly true in status. Call refresh with force true, then refresh again unchanged. Search storage with limit 5 three times; read one returned note and answer only from its served passage with path and lines. Finish with status. Make no vault changes." > "$N_OUT/s1-vaultex.jsonl" 2> "$N_OUT/s1-vaultex.stderr"
n_snapshot "$N_TOY" s1-toy-after
n_snapshot "$N_VAULTEX" s1-vaultex-after
```

Pass: actual status/refresh/search/note frames for each selected vault; status `fts5:true,nodeVersion,dataDirectory,vaults[].{id,path,role,readOnly,index,journal,lastCommit}`, no unresolved journal work; refresh `scanned,changed,unchanged,hashed,errorCount:0,durationMs`; unchanged refresh has zero changes. Record skips and their coverage implications. Search has nonempty `hits[].{path,revision,headingPath,source,passage}`, no stale required hit; note has matching `path,revision,body,frontmatter,source,index.matchesNote:true`. Final quotation matches served bytes and source lines. Compare before/after hashes, modes, index entries, HEAD and audit logs: no vault mutation. No undo is needed. Report full-scan, unchanged-refresh and three search timings separately; do not call a forced scan a cold cache or claim a meaningful p95 from three samples.

## Stage 2a: three writes and three single-operation inverses

```bash
n_snapshot "$N_TOY" a-before
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_TOY, batch $N_RUN-a. Preview and capture name $N_RUN-a, requestId $N_RUN-a-cap, content exactly a heading '# Live acceptance', blank line, sentence 'Storage acceptance sentence one.' and final LF. Read the returned path. Preview and replace only 'Storage acceptance sentence one.' with 'Storage acceptance sentence two.', requestId $N_RUN-a-replace. Read again. Preview and set frontmatter acceptance to JSON boolean true, requestId $N_RUN-a-frontmatter. Read again and search 'Storage acceptance' with workspace live-toy-vault and limit 20. Finish with status and all three receipts. Do not undo yet." > "$N_OUT/a-write.jsonl" 2> "$N_OUT/a-write.stderr"
n_snapshot "$N_TOY" a-written
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_TOY. Undo by opId in this exact order: $N_RUN-a-frontmatter, $N_RUN-a-replace, $N_RUN-a-cap. Use batch $N_RUN-a-undo and respective request IDs $N_RUN-a-ufm, $N_RUN-a-ureplace, $N_RUN-a-ucap. Before each inverse read its surviving note and preview, then execute with that preview hash. Read the restored note after each of the first two inverses. Finish with status and receipts." > "$N_OUT/a-undo.jsonl" 2> "$N_OUT/a-undo.stderr"
n_snapshot "$N_TOY" a-restored
```

Pass: capture receipt `capture.{path,bodyHash,workspace,capturedAt,revision,duplicateOf:null}`; generated `created_by: clio`, workspace `live-toy-vault`, UTC capture time, dated Inbox filename and tags list. Every revise start uses the preceding note revision and only its mode fields; frontmatter `set:[{key:"acceptance",valueJson:"true"}]`. Inspect the three commit blobs: only the requested body span changes, then only frontmatter changes. Search returns the capture. Each undo start uses exactly one `opId`, never `targetBatch`; its output selects that original ID/OID. Six commits and six log lines, inverse order frontmatter/replace/capture, exact intermediate restored hashes, final capture absent, original fixture unchanged. A dedup/no-op on the first capture means this run did not exercise creation and does not pass.

### Fixture-only F1 kill, then actual headless recovery

Run after 2a restoration, with installed code matching the reviewed source used by this existing harness. This parent waits for the durable `afterIntent` IPC barrier before SIGKILL; never guess the window with a sleep. It targets only the live toy baseline note and does not run a suite.

```bash
n_snapshot "$N_TOY" fault-before
node --input-type=module - "$N_ROOT" "$N_TOY" "$N_DATA" "$N_RUN" > "$N_OUT/fault-barrier.jsonl" 2> "$N_OUT/fault-barrier.stderr" <<'NODE'
import {fork} from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
const [repo,vault,directory,run] = process.argv.slice(2), name = '3-resources/storage/Key-Value Store Design.md', bytes = fs.readFileSync(path.join(vault,name));
const input = {vault,batch:run+'-fault',requestId:run+'-fault-replace',authorization:{origin:'operator',request:'Live toy acceptance: replace the architecture sentence after the F1 kill.'},operation:'replace',path:name,revision:createHash('sha256').update(bytes).digest('hex'),oldText:'Fundamental architectural patterns for modern embedded and distributed key-value storage engines.',newText:'Live acceptance checks architecture and durable recovery.'};
const child = fork(path.join(repo,'clio/notient-extension/test/fault-child.mjs'),[JSON.stringify({tool:'revise',input,directory,barrier:'afterIntent'})],{execArgv:[],stdio:['ignore','inherit','inherit','ipc']});
let reached = false; const timer = setTimeout(()=>child.kill('SIGKILL'),90000);
child.once('message', message => { reached = message.barrier === 'afterIntent'; process.stdout.write(JSON.stringify(message)+'\n'); child.kill('SIGKILL'); });
child.once('exit',(code,signal)=>{clearTimeout(timer);process.stdout.write(JSON.stringify({reached,code,signal})+'\n');process.exitCode = reached && signal === 'SIGKILL' ? 0 : 1;});
NODE
n_snapshot "$N_TOY" fault-stopped
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_TOY. Call status twice sequentially and read 3-resources/storage/Key-Value Store Design.md. Report recovered operation $N_RUN-fault-replace and its actual commit. Do not make another write." > "$N_OUT/fault-recover.jsonl" 2> "$N_OUT/fault-recover.stderr"
n_snapshot "$N_TOY" fault-recovered
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_TOY. Read 3-resources/storage/Key-Value Store Design.md, preview then undo opId $N_RUN-fault-replace with batch $N_RUN-fault-undo and requestId $N_RUN-fault-inverse. Finish with status." > "$N_OUT/fault-undo.jsonl" 2> "$N_OUT/fault-undo.stderr"
n_snapshot "$N_TOY" fault-restored
```

Pass: before recovery, HEAD and the named note still equal `fault-before`; inspect the durable intent, candidate OID and prepared SQL rows read-only. First status `P.recovered[]` names the operation, `result:"resumed_from_intent"`, `commit` equal to the barrier's candidate, `elapsedMs`; second status adds no commit/log line and has zero pending work. One recovered write, one inverse, exact original note bytes restored, owned temporary siblings removed. F2/F3 and structural fault matrices remain the manager's separate deterministic verification, not claims made by this single live F1 check.

## Stage 2b: three incoming references, move and whole-batch undo

```bash
n_snapshot "$N_TOY" b-before
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_TOY, batch $N_RUN-b. Read Notient/Conventions.md. Preview and capture target name $N_RUN-target with body '# Live target', blank line, '## Checkpoint', blank line, 'Move acceptance sentence one.' and final LF; use requestId $N_RUN-b-target. From its returned path construct three separate captures named $N_RUN-ref1, $N_RUN-ref2, $N_RUN-ref3, request IDs $N_RUN-b-ref1, $N_RUN-b-ref2, $N_RUN-b-ref3. Each body is a heading '# Live reference N', a blank line, one link and final LF. Ref1 uses a basename wiki link with alias Live target; ref2 uses a vault-relative wiki embed to heading Checkpoint; ref3 uses a relative Markdown link labeled target to heading checkpoint. Preview each capture. Read target and all three referrers. Preview and replace only 'Move acceptance sentence one.' with 'Move acceptance sentence two.', requestId $N_RUN-b-replace. Read the target again. Preview move to Notient/Acceptance/$N_RUN-Moved.md with requestId $N_RUN-b-move. All three incoming references must be repaired; apply the exact full preview only if it has no blockers and no unrelated edits. Read destination and all referrers, then status. Do not undo yet." > "$N_OUT/b-write.jsonl" 2> "$N_OUT/b-write.stderr"
n_snapshot "$N_TOY" b-written
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_TOY. Read every surviving note named in batch $N_RUN-b using status and its audit entries. Preview undo targetBatch $N_RUN-b with new batch $N_RUN-b-undo and requestId $N_RUN-b-inverse, then apply its planHash. Finish with status and the inverse receipt." > "$N_OUT/b-undo.jsonl" 2> "$N_OUT/b-undo.stderr"
n_snapshot "$N_TOY" b-restored
```

Pass: six forward commits: four captures, replace, move. Move start includes `operation:"move",path,revision,destination,dryRun,planHash`; full preview includes source deletion, destination creation and three referrer replacements. Check raw bytes preserve aliases, headings, embeds, link labels and all other text. Destination trailer matches destination. Batch undo uses only `targetBatch`, selects all six originals in reverse order, creates one inverse commit and sets their `undoneBy` to its ID. All four captured notes and moved destination disappear; fixture files and unrelated raw index entries match `b-before`. Seven retained log lines; `Notient-Reverts` names six original commits. Ambiguity or unsupported syntax is a safe refusal and a blocked positive acceptance, never a partial pass or permission to pick another target silently.

## Vaultex: separate operator windows after fixture acceptance

Until an operator baseline commit exists, allow only one Inbox capture and its single-operation inverse. The 168 existing changes remain outside every Notient commit. First inspect the proposed monthly log: it must be absent or clean against raw HEAD/index; a dirty managed log blocks even capture. Operator alone changes registration access with the following setup commands; do not unset `AI_AGENT` or route setup through Clio. Return to read-only after recovery/undo completes, including after a failed check is resolved.

```bash
node "$N_ROOT/clio/notient-extension/bin/setup.mjs" --vault "$N_VAULTEX" --access read-write
n_snapshot "$N_VAULTEX" vx-before
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_VAULTEX. Require writable registration. Preview and capture name $N_RUN-vaultex, content exactly '# Live capture', blank line, 'This disposable Inbox note checks Notient on the Windows drive.' and final LF, batch $N_RUN-vx, requestId $N_RUN-vx-cap. Read the result and report timings and commit. Do not revise any existing note or undo yet." > "$N_OUT/vx-capture.jsonl" 2> "$N_OUT/vx-capture.stderr"
n_snapshot "$N_VAULTEX" vx-captured
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_VAULTEX. Read the capture identified by operation $N_RUN-vx-cap. Preview and undo only opId $N_RUN-vx-cap with batch $N_RUN-vx-undo and requestId $N_RUN-vx-inverse. Finish with status." > "$N_OUT/vx-undo.jsonl" 2> "$N_OUT/vx-undo.stderr"
n_snapshot "$N_VAULTEX" vx-restored
node "$N_ROOT/clio/notient-extension/bin/setup.mjs" --vault "$N_VAULTEX" --access read-only
```

Pass: common capture/undo frames, exactly two commits and log lines, capture absent afterwards, every pre-existing non-log byte/mode and unrelated staged entry preserved, original dirty paths still dirty with the same contents. Record Windows-drive `timings.{scanMs,lockWaitMs,journalMs,applyMs,gitMs,totalMs}`, host duration, lock retries if reported and durability warnings. No Vaultex move or kill injection.

Later gate: the operator commits an intentional Vaultex baseline and explicitly names one Markdown note. Record that OID, require the named note and monthly log clean in HEAD/index/worktree, then take a fresh snapshot. Do not select the note for the operator or commit dirty content as preparation. The following shell prompt is answered by the operator, outside headless Clio.

```bash
read -r -p 'Operator-named Vaultex note, vault-relative: ' N_NAMED
node "$N_ROOT/clio/notient-extension/bin/setup.mjs" --vault "$N_VAULTEX" --access read-write
n_snapshot "$N_VAULTEX" vx-revise-before
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_VAULTEX. Read exactly $N_NAMED. If frontmatter already has notient_live_acceptance, stop. Preview then set only notient_live_acceptance to JSON string $N_RUN, batch $N_RUN-vxr, requestId $N_RUN-vxr-edit. Read back, report commit and timings. Make no other note change and do not undo yet." > "$N_OUT/vx-revise.jsonl" 2> "$N_OUT/vx-revise.stderr"
n_snapshot "$N_VAULTEX" vx-revised
clio-coder run --json --autonomy yolo --cwd "$N_TOY" "$N_RULES Target vault $N_VAULTEX. Read exactly $N_NAMED, preview then undo opId $N_RUN-vxr-edit, batch $N_RUN-vxr-undo, requestId $N_RUN-vxr-inverse. Finish with status." > "$N_OUT/vx-revise-undo.jsonl" 2> "$N_OUT/vx-revise-undo.stderr"
n_snapshot "$N_VAULTEX" vx-revise-restored
node "$N_ROOT/clio/notient-extension/bin/setup.mjs" --vault "$N_VAULTEX" --access read-only
```

Pass: one `revise` frontmatter preview/apply using the served revision and `set:[{key:"notient_live_acceptance",valueJson:<JSON string>}]`, one single-op inverse, two commits/log lines, and the named note's complete original Buffer restored. Unsupported YAML or dirty baseline is a refusal, never a substitute target or body rewrite.

## Stage 3 later: task in A, genuine fresh recall in B

Require accepted 2a/2b, reviewed stage 3, writable registered `role:"own"` at `N_OWN`, an operator-committed clean bootstrap, and installed memory-keeper plus reviewed hook envelope. A and B are existing distinct repositories; no repository files are created or changed for this demonstration. Memory capture must use actual task-bank hits. If recall returns none, record the unmet prerequisite; do not synthesize entry IDs, promote durable memory or inspect private task-bank files.

```bash
n_snapshot "$N_OWN" memory-before
clio-coder run --json --autonomy yolo --cwd "$N_A" "Read only clio/design/02-write-path.md section 1. Complete this bounded review task: determine the exact replacement bytes when Phrase in First LF Second CRLF Third CRLF Phrase is replaced by New LF Lines, and explain the dominant-convention rule and tie fallback. Report the observed nonsecret procedural lesson. Do not change any file or capture memory yet." > "$N_OUT/memory-a-task.jsonl" 2> "$N_OUT/memory-a-task.stderr"
N_SESSION_A=$(node -e 'const fs=require("node:fs");const x=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).find(x=>x.type==="session"&&x.id);if(!x)process.exit(1);process.stdout.write(x.id)' "$N_OUT/memory-a-task.jsonl")
clio-coder run --json --autonomy yolo --cwd "$N_A" --session "$N_SESSION_A" "Use installed notient-memory-keeper. Call memory_recall with query Notient replacement newline fallback and limit 8. I authorize saving one observed nonsecret task-bank lesson to registered own vault $N_OWN under batch $N_RUN-memory using origin clio. Search the entire own vault first, read plausible notes, then preview and capture or single-replace append with actual entry IDs and canonical repository provenance. Follow the readable contribution and Source format; preserve earlier bytes. Optional updated/repositories refresh is authorized as a separate operation in the same batch. Stop if there is no usable task hit or any refusal; never fabricate provenance or use another writer. Read back and report body and metadata receipts, IDs and OIDs." > "$N_OUT/memory-a-save.jsonl" 2> "$N_OUT/memory-a-save.stderr"
n_snapshot "$N_OWN" memory-saved
clio-coder run --json --autonomy yolo --cwd "$N_B" "Use installed notient-memory-keeper and registered own vault $N_OWN. What did Clio learn last time about Notient replacement newline handling? Refresh the derived index with force true, search the whole own vault, read correction context and cite only served passages. Label the answer unverified memory. Do not read repository files or prior session files, change notes, or use another source to supply the answer." > "$N_OUT/memory-b-recall.jsonl" 2> "$N_OUT/memory-b-recall.stderr"
clio-coder run --json --autonomy yolo --cwd "$N_A" --session "$N_SESSION_A" "Use notient-memory-keeper for own vault $N_OWN. Repeat only the exact repository, entry IDs and UTC date already saved in batch $N_RUN-memory. Read the canonical Source contribution and demonstrate that these tuples are already present. Do not add a new contribution or optional metadata change. Report existing IDs; never invent a new date to evade deduplication." > "$N_OUT/memory-dedup.jsonl" 2> "$N_OUT/memory-dedup.stderr"
```

Pass: installed skill use; actual `memory_recall` start `{query,limit}` and returned task hits `source:"task",id,kind,text,score`; observed own-vault status/search/note then capture or replace preview/apply. The new contribution has `## <UTC date> · design` and one Source line with actual task entry IDs, canonical `N_A`, known session or `unknown`, and basis `unverified task-bank recall`; the complete body has one append marker. Frontmatter includes `type,created,updated,repositories,tags` plus generic capture fields. Body commit suffices when optional metadata fails. B has a different session ID/cwd, no resumed A history, actual own-vault refresh/search/note, `memory:"unverified memory"`, and a final cited answer supported by served bytes. No workspace filter may hide contributions from A. Dedup adds zero commits/log lines and preserves bytes.

For the correction check, complete a second bounded observation in A, then recall its actual new task entry before saving; the correction restates the earlier claim and narrows its scope to body replacement. Do not invent a false lesson merely to correct it.

```bash
clio-coder run --json --autonomy yolo --cwd "$N_A" --session "$N_SESSION_A" "Read only 02 section 1 at clio/design/02-write-path.md. Check whether the dominant replacement fallback also governs newly generated frontmatter lines. Report the observed scope distinction as a nonsecret procedural refinement. Change nothing and do not save memory yet." > "$N_OUT/memory-correction-task.jsonl" 2> "$N_OUT/memory-correction-task.stderr"
clio-coder run --json --autonomy yolo --cwd "$N_A" --session "$N_SESSION_A" "Use notient-memory-keeper, memory_recall query Notient frontmatter newline scope limit 8, and own vault $N_OWN. I authorize one later correction contribution to the same topic, batch $N_RUN-correction, origin clio, based only on actual new task entry IDs. Read the prior contribution; its first correction line must name the earlier date heading and restate the old claim before the observed scope refinement. Preview the single-replace append and apply; optional summary refresh is authorized separately. Preserve all earlier body bytes. Stop on missing task evidence or refusal. Report all IDs/OIDs." > "$N_OUT/memory-correction.jsonl" 2> "$N_OUT/memory-correction.stderr"
clio-coder run --json --autonomy yolo --cwd "$N_B" "Use notient-memory-keeper and own vault $N_OWN. Search and read what Clio learned about Notient newline handling, including later corrections. Cite the served evidence as unverified memory. Do not use repository or prior session files and do not change notes." > "$N_OUT/memory-b-correction.jsonl" 2> "$N_OUT/memory-b-correction.stderr"
n_snapshot "$N_OWN" memory-corrected
clio-coder run --json --autonomy yolo --cwd "$N_A" "$N_RULES Target own vault $N_OWN. Read the surviving memory topic. Preview then undo targetBatch $N_RUN-correction under batch $N_RUN-correction-undo with requestId $N_RUN-correction-inverse. Read the restored topic, then preview and undo targetBatch $N_RUN-memory under batch $N_RUN-memory-undo with requestId $N_RUN-memory-inverse. Use each returned planHash. Finish with status and receipts; preserve all older memory and audit lines." > "$N_OUT/memory-undo.jsonl" 2> "$N_OUT/memory-undo.stderr"
n_snapshot "$N_OWN" memory-restored
```

Pass: new correction tuple, old contribution retained byte-for-byte, later B answer cites the correction; inverse batches restore the pre-demonstration topic or remove a newly captured topic, with all older own-vault files unchanged. Record body/metadata commits separately and count log lines from actual committed operations, not an assumed fixed metadata count.

Headless success establishes the conversational memory path only. Full stage 3 reminder acceptance remains an attended check under 03 §7: open fresh sessions with `(cd "$N_A" && clio-coder)` and `(cd "$N_B" && clio-coder)`. In each, ask for own-vault status, a topic search and note read; repeat the search/read in a second turn. Require orientation `inject_reminder` once and first search/note `annotate_tool_result` once, with no duplication. Retain the actual host hook receipts/effects, not an assistant claim that the hook ran. No such hook frames are expected from `run`. Record this gate as pending until observed.

Record actual versions, installed digests, session/model IDs, roots, commands, exit codes, frames, citations, byte/index snapshots, batch/request/operation IDs, OIDs, per-phase timings, warnings and refusals. Report each stage independently; stop after stage 3. Setup, installs, checks and outcomes have not been executed by this document.
