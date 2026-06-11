import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

export type JobStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';

export interface Job {
  jobId: string;
  status: JobStatus;
  progress: string;
  inputs: { question: string };
  outputs?: string;
  error?: { message: string; details?: string };
  created_at: string;
  updated_at: string;
}

export interface IJobStore {
  createJob(inputs: { question: string }): Promise<string>;
  updateProgress(jobId: string, progress: string): Promise<void>;
  completeJob(jobId: string, outputs: string): Promise<void>;
  failJob(jobId: string, error: { message: string; details?: string }): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
}

export class DynamoDBJobStore implements IJobStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string, dynamoClient?: DynamoDBClient) {
    this.tableName = tableName ?? process.env.LAWSY_JOBS_TABLE ?? '';
    this.docClient = DynamoDBDocumentClient.from(
      dynamoClient ?? new DynamoDBClient({ region: process.env.AWS_REGION }),
    );
  }

  async createJob(inputs: { question: string }): Promise<string> {
    const jobId = randomUUID();
    const now = new Date().toISOString();
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          jobId,
          status: 'PENDING' as JobStatus,
          progress: 'リクエストを受け付けました',
          inputs,
          created_at: now,
          updated_at: now,
          ttl: Math.floor(Date.now() / 1000) + 86400,
        },
      }),
    );
    return jobId;
  }

  async updateProgress(jobId: string, progress: string): Promise<void> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { jobId },
          // Only transition if still non-terminal (PENDING or IN_PROGRESS)
          ConditionExpression: '#s IN (:pending, :inprogress)',
          UpdateExpression: 'SET #s = :status, progress = :progress, updated_at = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':status': 'IN_PROGRESS',
            ':progress': progress,
            ':now': new Date().toISOString(),
            ':pending': 'PENDING',
            ':inprogress': 'IN_PROGRESS',
          },
        }),
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw err;
    }
  }

  async completeJob(jobId: string, outputs: string): Promise<void> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { jobId },
          // Only transition from non-terminal states
          ConditionExpression: '#s IN (:pending, :inprogress)',
          UpdateExpression:
            'SET #s = :status, progress = :progress, outputs = :outputs, updated_at = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':status': 'COMPLETED',
            ':progress': '回答の生成が完了しました',
            ':outputs': outputs,
            ':now': new Date().toISOString(),
            ':pending': 'PENDING',
            ':inprogress': 'IN_PROGRESS',
          },
        }),
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw err;
    }
  }

  async failJob(jobId: string, error: { message: string; details?: string }): Promise<void> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { jobId },
          // Only transition from non-terminal states
          ConditionExpression: '#s IN (:pending, :inprogress)',
          UpdateExpression: 'SET #s = :status, #e = :error, updated_at = :now',
          ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
          ExpressionAttributeValues: {
            ':status': 'ERROR',
            ':error': error,
            ':now': new Date().toISOString(),
            ':pending': 'PENDING',
            ':inprogress': 'IN_PROGRESS',
          },
        }),
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw err;
    }
  }

  async getJob(jobId: string): Promise<Job | null> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { jobId },
      }),
    );
    return (result.Item as Job | undefined) ?? null;
  }
}

export class InMemoryJobStore implements IJobStore {
  private readonly jobs = new Map<string, Job>();

  async createJob(inputs: { question: string }): Promise<string> {
    const jobId = randomUUID();
    const now = new Date().toISOString();
    this.jobs.set(jobId, {
      jobId,
      status: 'PENDING',
      progress: 'リクエストを受け付けました',
      inputs,
      created_at: now,
      updated_at: now,
    });
    return jobId;
  }

  async updateProgress(jobId: string, progress: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, {
      ...job,
      status: 'IN_PROGRESS',
      progress,
      updated_at: new Date().toISOString(),
    });
  }

  async completeJob(jobId: string, outputs: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, {
      ...job,
      status: 'COMPLETED',
      progress: '回答の生成が完了しました',
      outputs,
      updated_at: new Date().toISOString(),
    });
  }

  async failJob(jobId: string, error: { message: string; details?: string }): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, {
      ...job,
      status: 'ERROR',
      error,
      updated_at: new Date().toISOString(),
    });
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId) ?? null;
  }
}
