import type { Job } from './job-store.js';

export interface RequestAcceptedResponse {
  outputs: string;
  request_id: string;
  status: 'PENDING';
  status_url: string;
}

export interface StatusResponse {
  request_id: string;
  status: string;
  progress: string;
  created_at: string;
  updated_at: string;
  outputs?: string;
  artifacts?: Array<{ contents: string; display_name: string }>;
  error?: { message: string; details?: string };
}

export function buildRequestAcceptedResponse(jobId: string): RequestAcceptedResponse {
  return {
    outputs: 'リクエストを受け付けました',
    request_id: jobId,
    status: 'PENDING',
    status_url: `/status/${jobId}`,
  };
}

export function buildStatusResponse(job: Job): StatusResponse {
  const base: StatusResponse = {
    request_id: job.jobId,
    status: job.status,
    progress: job.progress,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };

  if (job.status === 'COMPLETED' && job.outputs) {
    return {
      ...base,
      outputs: job.outputs,
      artifacts: [
        {
          contents: Buffer.from(job.outputs).toString('base64'),
          display_name: 'report.md',
        },
      ],
    };
  }

  if (job.status === 'ERROR' && job.error) {
    // Return user-facing message only; stack traces stay in internal store
    return { ...base, error: { message: job.error.message } };
  }

  return base;
}
