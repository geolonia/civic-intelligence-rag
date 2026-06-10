import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRequestAcceptedResponse, buildStatusResponse } from './async-routes.js';
import type { Job } from './job-store.js';

const baseJob: Job = {
  jobId: 'test-job-id',
  status: 'PENDING',
  progress: 'リクエストを受け付けました',
  inputs: { question: 'test' },
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
};

describe('buildRequestAcceptedResponse', () => {
  it('returns 202-spec format with correct fields', () => {
    const res = buildRequestAcceptedResponse('job-123');
    assert.equal(res.outputs, 'リクエストを受け付けました');
    assert.equal(res.request_id, 'job-123');
    assert.equal(res.status, 'PENDING');
    assert.equal(res.status_url, '/status/job-123');
  });
});

describe('buildStatusResponse', () => {
  it('returns PENDING response with progress and timestamps', () => {
    const res = buildStatusResponse(baseJob);
    assert.equal(res.request_id, 'test-job-id');
    assert.equal(res.status, 'PENDING');
    assert.equal(res.progress, 'リクエストを受け付けました');
    assert.equal(res.created_at, '2026-06-10T00:00:00.000Z');
    assert.ok(!res.outputs);
  });

  it('returns IN_PROGRESS response with progress string', () => {
    const job: Job = { ...baseJob, status: 'IN_PROGRESS', progress: '法令データを検索中...' };
    const res = buildStatusResponse(job);
    assert.equal(res.status, 'IN_PROGRESS');
    assert.equal(res.progress, '法令データを検索中...');
    assert.ok(!res.outputs);
  });

  it('returns COMPLETED response with outputs and artifacts', () => {
    const job: Job = {
      ...baseJob,
      status: 'COMPLETED',
      progress: '回答の生成が完了しました',
      outputs: '法令解説テキスト',
    };
    const res = buildStatusResponse(job);
    assert.equal(res.status, 'COMPLETED');
    assert.equal(res.outputs, '法令解説テキスト');
    assert.ok(Array.isArray(res.artifacts));
    assert.equal(res.artifacts?.length, 1);
    assert.equal(res.artifacts?.[0].display_name, 'report.md');
    assert.ok(res.artifacts?.[0].contents);
  });

  it('returns ERROR response with error details', () => {
    const job: Job = {
      ...baseJob,
      status: 'ERROR',
      progress: 'エラーが発生しました',
      error: { message: '処理失敗', details: 'timeout' },
    };
    const res = buildStatusResponse(job);
    assert.equal(res.status, 'ERROR');
    // details (stack trace) is stripped from public response for security
    assert.deepEqual(res.error, { message: '処理失敗' });
  });

  it('base64-encodes outputs in artifacts', () => {
    const job: Job = {
      ...baseJob,
      status: 'COMPLETED',
      progress: '完了',
      outputs: 'hello',
    };
    const res = buildStatusResponse(job);
    assert.equal(res.artifacts?.[0].contents, Buffer.from('hello').toString('base64'));
  });
});
