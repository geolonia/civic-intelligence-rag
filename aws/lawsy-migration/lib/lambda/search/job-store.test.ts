import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { InMemoryJobStore } from './job-store.js';

describe('InMemoryJobStore', () => {
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore();
  });

  it('createJob returns a UUID and stores PENDING status', async () => {
    const jobId = await store.createJob({ question: 'test question' });
    assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const job = await store.getJob(jobId);
    assert.ok(job);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.progress, 'リクエストを受け付けました');
    assert.deepEqual(job.inputs, { question: 'test question' });
    assert.ok(job.created_at);
    assert.ok(job.updated_at);
  });

  it('updateProgress sets IN_PROGRESS status and progress string', async () => {
    const jobId = await store.createJob({ question: 'q' });
    await store.updateProgress(jobId, '法令データを検索中...');
    const job = await store.getJob(jobId);
    assert.ok(job);
    assert.equal(job.status, 'IN_PROGRESS');
    assert.equal(job.progress, '法令データを検索中...');
  });

  it('completeJob sets COMPLETED status with outputs', async () => {
    const jobId = await store.createJob({ question: 'q' });
    await store.completeJob(jobId, '法令解説マークダウン');
    const job = await store.getJob(jobId);
    assert.ok(job);
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.outputs, '法令解説マークダウン');
    assert.equal(job.progress, '回答の生成が完了しました');
  });

  it('failJob sets ERROR status with error details', async () => {
    const jobId = await store.createJob({ question: 'q' });
    await store.failJob(jobId, { message: '処理失敗', details: 'timeout' });
    const job = await store.getJob(jobId);
    assert.ok(job);
    assert.equal(job.status, 'ERROR');
    assert.deepEqual(job.error, { message: '処理失敗', details: 'timeout' });
  });

  it('getJob returns null for non-existent jobId', async () => {
    const job = await store.getJob('non-existent-id');
    assert.equal(job, null);
  });

  it('progress update preserves inputs and created_at', async () => {
    const jobId = await store.createJob({ question: 'q' });
    const original = await store.getJob(jobId);
    await store.updateProgress(jobId, '検索中');
    const updated = await store.getJob(jobId);
    assert.ok(original);
    assert.ok(updated);
    assert.deepEqual(updated.inputs, original.inputs);
    assert.equal(updated.created_at, original.created_at);
  });
});
