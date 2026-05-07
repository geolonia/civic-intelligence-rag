import { Stack, type StackProps, RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';

/**
 * Supported embedding models and their vector dimensions.
 * Uses number type (not string) because CfnIndex.dimension requires number.
 */
const MODEL_DIMENSION_MAPPING: { [key: string]: number } = {
  'amazon.titan-embed-text-v1': 1536,
  'amazon.titan-embed-text-v2:0': 1024,
  'cohere.embed-multilingual-v3': 1024,
  'cohere.embed-english-v3': 1024,
};

/** List of supported embedding model IDs */
const SUPPORTED_EMBEDDING_MODELS = Object.keys(MODEL_DIMENSION_MAPPING);

/**
 * Bedrock internal metadata fields stored as non-filterable metadata in S3 Vectors.
 * These are automatically added by Bedrock and must not count toward the 1KB user metadata limit.
 */
const BEDROCK_INTERNAL_METADATA_KEYS = [
  'AMAZON_BEDROCK_TEXT',
  'AMAZON_BEDROCK_METADATA',
] as const;

/**
 * Properties for RagS3VectorsKbStack
 */
interface RagS3VectorsKbStackProps extends StackProps {
  /** IAM role for switch role access */
  switchRole: iam.Role;
  /** Application name identifier used as resource name prefix */
  appName: string;
  /**
   * External encryption key (optional).
   * When omitted, creates a new individual CMEK for this application.
   */
  encryptionKey?: kms.IKey;
}

/**
 * Stack for RAG Knowledge Base with S3 Vectors backend and Bedrock.
 *
 * Creates:
 * - S3 Vector Bucket and Vector Index for embedding storage
 * - Bedrock Knowledge Base with S3_VECTORS storage configuration
 * - S3 buckets for data source documents and access logs
 * - IAM roles and policies for secure access
 * - KMS encryption key (individual CMEK per app)
 */
export class RagS3VectorsKbStack extends Stack {
  /** Bedrock Knowledge Base ID */
  public readonly knowledgeBaseId: string;
  /** S3 bucket name for data source documents */
  public readonly dataSourceBucketName: string;
  /** KMS encryption key */
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: RagS3VectorsKbStackProps) {
    super(scope, id, props);

    const { switchRole } = props;

    // 1. Validate embedding model and retrieve vector dimension
    const { embeddingModelId, dimension } = this.validateEmbeddingModel();

    // 2. Configure KMS CMEK (create new individual key if not provided)
    const encryptionKey = props.encryptionKey ?? this.createCmek(props.appName);
    this.encryptionKey = encryptionKey;

    // 3. Create S3 buckets for data source documents and access logs
    const { dataSourceBucket } = this.createS3Buckets(
      props.appName,
      encryptionKey,
      switchRole
    );

    // 4. Create S3 Vector Bucket with KMS encryption
    const vectorBucketName = `${props.appName}-s3v-bucket`;
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName,
      encryptionConfiguration: {
        sseType: 'aws:kms',
        kmsKeyArn: encryptionKey.keyArn,
      },
    });

    // 5. Create Vector Index
    const vectorIndexName = `${props.appName}-s3v-index`;
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName,
      indexName: vectorIndexName,
      dataType: 'float32',
      dimension,
      distanceMetric: 'cosine',
      encryptionConfiguration: {
        sseType: 'aws:kms',
        kmsKeyArn: encryptionKey.keyArn,
      },
      metadataConfiguration: {
        nonFilterableMetadataKeys: [...BEDROCK_INTERNAL_METADATA_KEYS],
      },
    });
    vectorIndex.addDependency(vectorBucket);

    // 6. Create Knowledge Base IAM role
    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });

    // 7. Configure Knowledge Base role policies
    this.configureKnowledgeBaseRolePolicies(
      knowledgeBaseRole,
      vectorIndex,
      dataSourceBucket,
      encryptionKey
    );

    // Explicitly depend on the DefaultPolicy so CloudFormation waits for
    // IAM policy propagation before creating the Knowledge Base.
    const kbDefaultPolicy = knowledgeBaseRole.node.tryFindChild('DefaultPolicy') as iam.Policy | undefined;

    // 8. Create Bedrock Knowledge Base with S3_VECTORS storage
    const kbName = `${props.appName}-s3v-kb`;
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: kbName,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${embeddingModelId}`,
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
          indexName: vectorIndexName,
        },
      },
    });
    knowledgeBase.addDependency(vectorBucket);
    knowledgeBase.node.addDependency(vectorIndex);
    if (kbDefaultPolicy) {
      knowledgeBase.node.addDependency(kbDefaultPolicy);
    }

    // 9. Create Data Source (docs/ prefix)
    new bedrock.CfnDataSource(this, 'DataSource', {
      dataSourceConfiguration: {
        s3Configuration: {
          bucketArn: `arn:aws:s3:::${dataSourceBucket.bucketName}`,
          inclusionPrefixes: ['docs/'],
        },
        type: 'S3',
      },
      knowledgeBaseId: knowledgeBase.ref,
      name: `${props.appName}-s3v-datasource`,
    });

    // 10. Grant SwitchRole permissions for KMS and Knowledge Base operations
    this.grantSwitchRolePermissions(switchRole, encryptionKey, knowledgeBase);

    // Set public outputs
    this.knowledgeBaseId = knowledgeBase.ref;
    this.dataSourceBucketName = dataSourceBucket.bucketName;

    // 11. Apply cdk-nag suppressions
    this.applyNagSuppressions(knowledgeBaseRole);
  }

  /**
   * Validate embedding model from CDK context and return its vector dimension.
   */
  private validateEmbeddingModel(): { embeddingModelId: string; dimension: number } {
    const embeddingModelId: string | null | undefined =
      this.node.tryGetContext('embeddingModelId');

    if (typeof embeddingModelId !== 'string') {
      throw new Error(
        'Knowledge Base RAG が有効になっていますが、embeddingModelId が指定されていません'
      );
    }

    if (!SUPPORTED_EMBEDDING_MODELS.includes(embeddingModelId)) {
      throw new Error(
        `embeddingModelId が無効な値です (有効な embeddingModelId: ${SUPPORTED_EMBEDDING_MODELS})`
      );
    }

    return { embeddingModelId, dimension: MODEL_DIMENSION_MAPPING[embeddingModelId] };
  }

  /**
   * Create an individual KMS CMEK for this application.
   */
  private createCmek(appName: string): kms.Key {
    const key = new kms.Key(this, 'EncryptionKey', {
      enableKeyRotation: true,
      description: `Encryption key for ${appName} S3 Vectors RAG application data stores (S3, S3 Vectors, CloudWatch Logs)`,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow Bedrock to use the key',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
      })
    );

    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow S3 Vectors indexing service to use the key',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('indexing.s3vectors.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
      })
    );

    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow CloudWatch Logs to use the key',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
        ],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
          },
        },
      })
    );

    return key;
  }

  /**
   * Create S3 buckets for data source documents and access logs.
   */
  private createS3Buckets(
    appName: string,
    encryptionKey: kms.IKey,
    switchRole: iam.Role
  ): { accessLogsBucket: s3.Bucket; dataSourceBucket: s3.Bucket } {
    const accessLogsBucket = new s3.Bucket(
      this,
      `${appName}-DataSourceAccessLogsBucket`,
      {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey,
        autoDeleteObjects: true,
        removalPolicy: RemovalPolicy.DESTROY,
        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        enforceSSL: true,
      }
    );

    switchRole.attachInlinePolicy(
      new iam.Policy(
        this,
        `${Stack.of(this).stackName}GrantDSAccessLogBucket`,
        {
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [accessLogsBucket.bucketArn],
              actions: ['s3:ListBucket'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [accessLogsBucket.arnForObjects('*')],
              actions: ['s3:GetObject'],
            }),
          ],
        }
      )
    );

    const dataSourceBucket = new s3.Bucket(this, `${appName}-DataSourceBucket`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'AccessLogs/',
      enforceSSL: true,
    });

    switchRole.attachInlinePolicy(
      new iam.Policy(
        this,
        `${Stack.of(this).stackName}GrantDataSourceBucket`,
        {
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [dataSourceBucket.bucketArn],
              actions: ['s3:ListBucket'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [dataSourceBucket.arnForObjects('*')],
              actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
            }),
          ],
        }
      )
    );

    return { accessLogsBucket, dataSourceBucket };
  }

  /**
   * Configure IAM policies for the Knowledge Base service role.
   */
  private configureKnowledgeBaseRolePolicies(
    knowledgeBaseRole: iam.Role,
    vectorIndex: s3vectors.CfnIndex,
    dataSourceBucket: s3.Bucket,
    encryptionKey: kms.IKey
  ): void {
    // Bedrock model invocation
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ['*'],
        actions: ['bedrock:InvokeModel'],
      })
    );

    // S3 Vectors read/write access for ingestion and retrieval
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [vectorIndex.attrIndexArn],
        actions: [
          's3vectors:PutVectors',
          's3vectors:QueryVectors',
          's3vectors:GetVectors',
        ],
      })
    );

    // S3 data source bucket access
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:s3:::${dataSourceBucket.bucketName}`],
        actions: ['s3:ListBucket'],
      })
    );

    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:s3:::${dataSourceBucket.bucketName}/*`],
        actions: ['s3:GetObject'],
      })
    );

    // KMS decryption for S3 and S3 Vectors
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [encryptionKey.keyArn],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      })
    );
  }

  /**
   * Grant SwitchRole permissions for KMS and Knowledge Base operations.
   */
  private grantSwitchRolePermissions(
    switchRole: iam.Role,
    encryptionKey: kms.IKey,
    knowledgeBase: bedrock.CfnKnowledgeBase
  ): void {
    switchRole.attachInlinePolicy(
      new iam.Policy(this, `${Stack.of(this).stackName}KmsAccessPolicy`, {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [encryptionKey.keyArn],
            actions: [
              'kms:Decrypt',
              'kms:GenerateDataKey',
              'kms:Encrypt',
              'kms:DescribeKey',
              'kms:CreateGrant',
            ],
          }),
        ],
      })
    );

    switchRole.attachInlinePolicy(
      new iam.Policy(
        this,
        `${Stack.of(this).stackName}KnowledgeBaseRAGPolicy`,
        {
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: ['*'],
              actions: ['bedrock:ListKnowledgeBases', 'bedrock:Rerank'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${knowledgeBase.attrKnowledgeBaseId}`,
              ],
              actions: [
                'bedrock:DeleteKnowledgeBaseDocuments',
                'bedrock:GetDataSource',
                'bedrock:GetIngestionJob',
                'bedrock:GetKnowledgeBase',
                'bedrock:GetKnowledgeBaseDocuments',
                'bedrock:ListDataSources',
                'bedrock:ListKnowledgeBaseDocuments',
                'bedrock:ListIngestionJobs',
                'bedrock:IngestKnowledgeBaseDocuments',
                'bedrock:Retrieve',
                'bedrock:RetrieveAndGenerate',
                'bedrock:StartIngestionJob',
                'bedrock:StopIngestionJob',
                'bedrock:TagResource',
                'bedrock:UntagResource',
                'bedrock:UpdateDataSource',
                'bedrock:UpdateKnowledgeBase',
                'bedrock:ListTagsForResource',
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: ['*'],
              actions: ['lambda:ListFunctions'],
            }),
          ],
        }
      )
    );
  }

  /**
   * Apply CDK-NAG suppressions for required wildcard permissions.
   */
  private applyNagSuppressions(knowledgeBaseRole: iam.Role): void {
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${knowledgeBaseRole.node.path}/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'bedrock:InvokeModel and S3 actions require * resources. s3vectors actions are scoped to the specific index ARN.',
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${Stack.of(this).stackName}/${Stack.of(this).stackName}GrantDSAccessLogBucket/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 action requires * resources.',
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${Stack.of(this).stackName}/${Stack.of(this).stackName}GrantDataSourceBucket/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 action requires * resources.',
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${Stack.of(this).stackName}/${Stack.of(this).stackName}KnowledgeBaseRAGPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Bedrock and lambda:ListFunctions actions require * resources.',
        },
      ]
    );
  }
}
