import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { InMemoryJobStore } from '../search/job-store.js';
import { type WorkerEvent, type WorkerDeps, handler } from './handler.js';
import type { Pool } from 'pg';

const mockDb = {} as Pool;
const mockGetPool = async () => mockDb;

// Mock generateLawReport that succeeds immediately
const successReportFn = async (_q: string, _db: Pool) => ({ report: '## テストレポート\n成功' });

// Mock that throws on call
const failReportFn = async (_q: string, _db: Pool): Promise<{ report: string }> => {
  throw new Error('generateLawReport simulated failure');
};

describe('worker handler', () => {
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore();
  });

  it('updates progress in correct order and COMPLETED when generateLawReport succeeds', async () => {
    const jobId = await store.createJob({ question: 'test question' });

    const progressLog: string[] = [];
    const wrappedStore = {
      createJob: store.createJob.bind(store),
      updateProgress: async (id: string, progress: string) => {
        progressLog.push(progress);
        return store.updateProgress(id, progress);
      },
      completeJob: store.completeJob.bind(store),
      failJob: store.failJob.bind(store),
      getJob: store.getJob.bind(store),
    };

    const event: WorkerEvent = { jobId, question: 'test question' };
    const deps: WorkerDeps = { jobStore: wrappedStore, reportFn: successReportFn, getPoolFn: mockGetPool };
    await handler(event, undefined, deps);

    const finalJob = await store.getJob(jobId);
    assert.ok(finalJob);
    assert.equal(finalJob.status, 'COMPLETED');
    assert.ok(finalJob.outputs?.includes('テストレポート'));

    assert.ok(progressLog.length >= 1, 'Expected at least one progress update');
    assert.equal(progressLog[0], '法令データを検索中...', 'First progress must be 法令データを検索中...');
  });

  it('sets ERROR status and calls failJob when generateLawReport throws', async () => {
    const jobId = await store.createJob({ question: 'fail question' });

    const event: WorkerEvent = { jobId, question: 'fail question' };
    const deps: WorkerDeps = { jobStore: store, reportFn: failReportFn, getPoolFn: mockGetPool };
    await handler(event, undefined, deps);

    const finalJob = await store.getJob(jobId);
    assert.ok(finalJob);
    assert.equal(finalJob.status, 'ERROR');
    assert.equal(finalJob.error?.message, 'generateLawReport simulated failure');
  });

  it('sets ERROR when completeJob throws after successful report generation', async () => {
    const jobId = await store.createJob({ question: 'complete-fail question' });

    const errorStore = {
      createJob: store.createJob.bind(store),
      updateProgress: async (id: string, progress: string) => store.updateProgress(id, progress),
      completeJob: async (_id: string, _outputs: string): Promise<void> => {
        throw new Error('DynamoDB connection failed');
      },
      failJob: store.failJob.bind(store),
      getJob: store.getJob.bind(store),
    };

    const event: WorkerEvent = { jobId, question: 'complete-fail question' };
    const deps: WorkerDeps = { jobStore: errorStore, reportFn: successReportFn, getPoolFn: mockGetPool };
    await handler(event, undefined, deps);

    const finalJob = await store.getJob(jobId);
    assert.ok(finalJob);
    assert.equal(finalJob.status, 'ERROR');
    assert.equal(finalJob.error?.message, 'DynamoDB connection failed');
  });

  it('calls failJob with error message on exception during progress update', async () => {
    const failedJobId = await store.createJob({ question: 'q' });
    const errors: Array<{ message: string }> = [];

    const errorCapture = {
      createJob: store.createJob.bind(store),
      updateProgress: async () => {
        throw new Error('progress update failed');
      },
      completeJob: store.completeJob.bind(store),
      failJob: async (id: string, error: { message: string; details?: string }) => {
        errors.push(error);
        return store.failJob(id, error);
      },
      getJob: store.getJob.bind(store),
    };

    const deps: WorkerDeps = { jobStore: errorCapture, reportFn: successReportFn, getPoolFn: mockGetPool };
    await handler({ jobId: failedJobId, question: 'q' }, undefined, deps);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'progress update failed');
  });
});
