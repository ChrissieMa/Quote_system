import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { CdpPipe } from './attribution-browser-fixture';

test('an exited browser reports its actual startup failure instead of Target.getTargets timeout', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stderr.write("SYNTHETIC_STARTUP_FAILURE\\n");process.exit(23)'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const pipe = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, child);
  const result = pipe.send('Target.getTargets');
  await assert.rejects(result, error => {
    assert.match(String(error), /Chrome exited \(code=23, signal=null\)/);
    assert.match(String(error), /SYNTHETIC_STARTUP_FAILURE/);
    assert.doesNotMatch(String(error), /timed out/);
    return true;
  });
  // Cleanup and later sends reject the same closed child immediately.
  await assert.rejects(pipe.send('Browser.close'), /SYNTHETIC_STARTUP_FAILURE/);
});

test('an absent browser executable reports the spawn error without waiting for a CDP reply', async () => {
  const child = spawn('/nonexistent-lks-synthetic-browser', [], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const pipe = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, child);
  await assert.rejects(pipe.send('Target.getTargets'), /Chrome launch failed:.*ENOENT/);
});

test('the unchanged five-second command deadline still permits graceful cleanup of a live child', async () => {
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs');let data='';
    fs.createReadStream(null,{fd:3}).on('data',chunk=>{
      data+=chunk;let end;
      while((end=data.indexOf('\\0'))!==-1){
        const message=JSON.parse(data.slice(0,end));data=data.slice(end+1);
        if(message.method==='Browser.close'){
          fs.writeSync(4,JSON.stringify({id:message.id,result:{}})+'\\0');process.exit(0);
        }
      }
    });`], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const pipe = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, child);
  await assert.rejects(pipe.send('Target.getTargets'), /timed out: Target.getTargets/);
  await pipe.send('Browser.close');
});
