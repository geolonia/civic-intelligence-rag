import { Stack, type StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as oss from 'aws-cdk-lib/aws-opensearchserverless';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as path from 'path';

/**
 * UUID for custom resource handler singleton function
 * Changed to force recreation with new Local Bundling implementation
 */
const UUID = 'A7F8E3D2-C1B0-4A96-8E7F-5D4C3B2A1E0F';

/**
 * Supported embedding models with their vector dimensions
 * Dimension values are strings due to CloudFormation type conversion issue
 * @see https://github.com/aws-cloudformation/cloudformation-coverage-roadmap/issues/1037
 */
const MODEL_VECTOR_MAPPING: { [key: string]: string } = {
  'amazon.titan-embed-text-v1': '1536',
  'amazon.titan-embed-text-v2:0': '1024',
  'cohere.embed-multilingual-v3': '1024',
  'cohere.embed-english-v3': '1024',
};

/**
 * Parsing prompt for PDF advanced parsing feature
 * Extracts text from images, graphs, and tables in PDF documents
 * Written in English to maximize model instruction comprehension.
 * Language preservation rule ensures output matches the source document language.
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking-parsing.html#kb-advanced-parsing
 * @see https://github.com/aws-samples/generative-ai-use-cases (multilingual best practice)
 */
const PARSING_PROMPT = `IMPORTANT: You MUST output in the same language as the source document. If the document is in Japanese, output in Japanese. If the document is in English, output in English. Always respect the original language.

Transcribe the text content from an image page and output in Markdown syntax (not code blocks). Follow these steps:

1. Examine the provided page carefully.

2. Identify all elements present in the page, including headers, body text, footnotes, tables, visualizations, captions, and page numbers.

3. Use Markdown syntax to format your output:
    - Headings: # for main, ## for sections, ### for subsections, etc.
    - Lists: * or - for bulleted, 1. 2. 3. for numbered
    - Do not repeat yourself

4. If the element is a visualization:
    - Provide a detailed description in natural language
    - Do not transcribe text in the visualization after providing the description

5. If the element is a table:
    - Create a Markdown table, ensuring every row has the same number of columns
    - Maintain cell alignment as closely as possible
    - Do not split a table into multiple tables
    - If a merged cell spans multiple rows or columns, place the text in the top-left cell and output ' ' for other cells
    - Use | for column separators, |-|-| for header row separators
    - If a cell has multiple items, list them in separate rows
    - If the table contains sub-headers, separate the sub-headers from the headers in another row

6. If the element is a paragraph:
    - Transcribe each text element precisely as it appears

7. If the element is a header, footer, footnote, or page number:
    - Transcribe each text element precisely as it appears

Output Example:

A bar chart showing annual sales figures, with the y-axis labeled "Sales ($Million)" and the x-axis labeled "Year". The chart has bars for 2018 ($12M), 2019 ($18M), 2020 ($8M), and 2021 ($22M).
Figure 3: This chart shows annual sales in millions. The year 2020 was significantly down due to the COVID-19 pandemic.

# Annual Report

## Financial Highlights

* Revenue: $40M
* Profit: $12M
* EPS: $1.25

| | Year Ended December 31, | |
|-|-|-|
| | 2021 | 2022 |
| Cash provided by (used in): | | |
| Operating activities | $ 46,327 | $ 46,752 |
| Investing activities | (58,154) | (37,601) |
| Financing activities | 6,291 | 9,718 |

IMPORTANT: Remember to output in the same language as the source document.`;

/** List of supported embedding model IDs */
const EMBEDDING_MODELS = Object.keys(MODEL_VECTOR_MAPPING);

/**
 * Properties for OpenSearchServerlessIndex custom resource
 */
interface OpenSearchServerlessIndexProps {
  /** OpenSearch Serverless collection ID */
  collectionId: string;
  /** Name of the vector index to create */
  vectorIndexName: string;
  /** Field name for vector embeddings */
  vectorField: string;
  /** Field name for metadata storage */
  metadataField: string;
  /** Field name for text content */
  textField: string;
  /** Dimension of the vector embeddings */
  vectorDimension: string;
}

/**
 * Custom resource construct for managing OpenSearch Serverless indexes
 *
 * Creates a vector index with kuromoji analyzer for Japanese text search
 * and k-NN support for vector similarity search.
 */
class OpenSearchServerlessIndex extends Construct {
  /** Lambda function handling the custom resource */
  public readonly customResourceHandler: lambda.IFunction;
  /** The custom resource instance */
  public readonly customResource: cdk.CustomResource;

  constructor(
    scope: Construct,
    id: string,
    props: OpenSearchServerlessIndexProps
  ) {
    super(scope, id);

    const customResourceHandler = new lambda.SingletonFunction(
      this,
      'OpenSearchServerlessIndex',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset('custom-resources', {
          assetHashType: cdk.AssetHashType.OUTPUT,
          bundling: {
            // image and command are required but not used when local bundling succeeds
            image: lambda.Runtime.NODEJS_24_X.bundlingImage,
            command: ['echo', 'Local bundling is used - Docker bundling is skipped'],

            // Local bundling: builds without Docker in all environments
            local: {
              tryBundle(outputDir: string): boolean {
                const customResourcesDir = path.join(__dirname, '../custom-resources');
                console.log(`[Local Bundling] Starting bundle process for custom-resources to ${outputDir}`);
                console.log(`[Local Bundling] Source dir: ${customResourcesDir}`);
                console.log(`[Local Bundling] Output dir: ${outputDir}`);

                // Step 1: Copy source code (without node_modules)
                console.log('[Local Bundling] Copying source code...');
                const filesToCopy = ['oss-index.js', 'package.json'];
                for (const file of filesToCopy) {
                  const sourcePath = path.join(customResourcesDir, file);
                  console.log(`[Local Bundling] Copying ${sourcePath} to ${outputDir}`);
                  const copyResult = spawnSync('cp', ['-a', sourcePath, outputDir], {
                    stdio: 'inherit'
                  });
                  if (copyResult.status !== 0) {
                    console.error(`[Local Bundling] ERROR: Failed to copy ${file} with status ${copyResult.status}`);
                    console.error(`[Local Bundling] ERROR: ${copyResult.error}`);
                    throw new Error(`Failed to copy ${file}`);
                  }
                  console.log(`[Local Bundling] Successfully copied ${file}`);
                }

                // Step 2: npm install dependencies directly in outputDir
                console.log('[Local Bundling] Installing Node.js dependencies in output directory...');
                const npmResult = spawnSync('npm', ['install', '--omit=dev', '--production'], {
                  cwd: outputDir,
                  stdio: ['ignore', 'inherit', 'inherit']
                });
                if (npmResult.error) {
                  console.error('[Local Bundling] ERROR: npm command failed to execute:', npmResult.error);
                  throw new Error(`npm install failed: ${npmResult.error}`);
                }
                if (npmResult.status !== 0) {
                  console.error(`[Local Bundling] ERROR: npm install exited with status ${npmResult.status}`);
                  throw new Error(`npm install failed with status ${npmResult.status}`);
                }
                console.log('[Local Bundling] npm install completed successfully');

                // Verification: List output directory
                console.log('[Local Bundling] Listing output directory:');
                spawnSync('ls', ['-lah', outputDir], {stdio: 'inherit'});

                console.log('[Local Bundling] Checking node_modules:');
                spawnSync('ls', ['-lah', path.join(outputDir, 'node_modules')], {stdio: 'inherit'});

                console.log('[Local Bundling] Checking @opensearch-project:');
                spawnSync('ls', ['-lah', path.join(outputDir, 'node_modules/@opensearch-project')], {stdio: 'inherit'});

                console.log('[Local Bundling] Checking @opensearch-project/opensearch:');
                spawnSync('ls', ['-lah', path.join(outputDir, 'node_modules/@opensearch-project/opensearch')], {stdio: 'inherit'});

                console.log('[Local Bundling] ✓ Bundle completed successfully');
                console.log('[Local Bundling] Returning true from tryBundle()');
                return true;
              }
            }
          },
        }),
        handler: 'oss-index.handler',
        uuid: UUID,
        lambdaPurpose: 'OpenSearchServerlessIndex',
        timeout: cdk.Duration.minutes(15),
      }
    );

    const customResource = new cdk.CustomResource(this, 'CustomResource', {
      serviceToken: customResourceHandler.functionArn,
      resourceType: 'Custom::OssIndex',
      properties: props,
      serviceTimeout: cdk.Duration.seconds(300),
    });

    this.customResourceHandler = customResourceHandler;
    this.customResource = customResource;
  }
}

/**
 * Properties for RagKnowledgeBaseStack
 */
interface RagKnowledgeBaseStackProps extends StackProps {
  /** IAM role for switch role access */
  switchRole: iam.Role;
  /** Application name identifier */
  appName: string;
  /** OpenSearch Serverless collection name */
  collectionName?: string;
  /** Vector index name */
  vectorIndexName?: string;
  /** Vector field name */
  vectorField?: string;
  /** Metadata field name */
  metadataField?: string;
  /** Text field name */
  textField?: string;
  /**
   * External encryption key (optional)
   *
   * When provided, the stack will use this key instead of creating a new CMEK.
   * This enables multiple RAG API stacks to share a common encryption key.
   *
   * @default - undefined (creates new CMEK)
   */
  encryptionKey?: kms.IKey;
}

/**
 * Stack for RAG Knowledge Base with OpenSearch Serverless and Bedrock
 *
 * Creates:
 * - OpenSearch Serverless collection with vector search capability
 * - Bedrock Knowledge Base with S3 data source
 * - S3 buckets for data storage and access logs
 * - IAM roles and policies for secure access
 * - KMS encryption for all data at rest
 */
export class RagKnowledgeBaseStack extends Stack {
  /** Bedrock Knowledge Base ID */
  public readonly knowledgeBaseId: string;
  /** S3 bucket name for data source */
  public readonly dataSourceBucketName: string;
  /** KMS encryption key */
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: RagKnowledgeBaseStackProps) {
    super(scope, id, props);

    const { switchRole } = props;

    // Configure encryption key
    const encryptionKey = this.configureEncryptionKey(props);
    this.encryptionKey = encryptionKey;

    // Validate embedding model
    const embeddingModelId = this.validateEmbeddingModel();

    // Configure field names with defaults
    const collectionName = props.collectionName ?? 'genai';
    const vectorIndexName = props.vectorIndexName ?? 'bedrock-kb-default';
    const vectorField = props.vectorField ?? 'bedrock-kb-default-vector';
    const textField = props.textField ?? 'AMAZON_BEDROCK_TEXT_CHUNK';
    const metadataField = props.metadataField ?? 'AMAZON_BEDROCK_METADATA';

    // Create Knowledge Base IAM role
    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });

    // Get context values
    const standbyReplicas = this.node.tryGetContext('ragKnowledgeBaseStandbyReplicas');
    const advancedParsingConfig = this.validateAdvancedParsing();

    // Create OpenSearch Serverless resources
    const { collection, ossIndex } = this.createOpenSearchResources(
      collectionName,
      vectorIndexName,
      vectorField,
      textField,
      metadataField,
      embeddingModelId,
      standbyReplicas,
      encryptionKey,
      knowledgeBaseRole
    );

    // Grant switch role permissions
    this.grantSwitchRolePermissions(switchRole, collection, encryptionKey);

    // Create S3 buckets
    const { accessLogsBucket, dataSourceBucket } = this.createS3Buckets(
      props.appName,
      encryptionKey,
      switchRole
    );

    // Configure Knowledge Base role policies
    this.configureKnowledgeBaseRolePolicies(
      knowledgeBaseRole,
      collection,
      dataSourceBucket,
      encryptionKey
    );

    // Create Knowledge Base and Data Source
    const knowledgeBase = this.createKnowledgeBase(
      collectionName,
      vectorIndexName,
      vectorField,
      textField,
      metadataField,
      embeddingModelId,
      knowledgeBaseRole,
      collection,
      ossIndex,
      dataSourceBucket,
      standbyReplicas,
      advancedParsingConfig
    );

    // Grant switch role Knowledge Base permissions
    this.grantSwitchRoleKnowledgeBasePermissions(switchRole, knowledgeBase);

    // Set outputs
    this.knowledgeBaseId = knowledgeBase.ref;
    this.dataSourceBucketName = dataSourceBucket.bucketName;

    // Apply CDK-NAG suppressions
    this.applyNagSuppressions(knowledgeBaseRole, dataSourceBucket);
  }

  /**
   * Configure encryption key - use external key or create new CMEK
   */
  private configureEncryptionKey(props: RagKnowledgeBaseStackProps): kms.IKey {
    if (props.encryptionKey) {
      return props.encryptionKey;
    }

    // Create new CMEK
    const newKey = new kms.Key(this, 'EncryptionKey', {
      enableKeyRotation: true,
      description: `Encryption key for ${props.appName} RAG application data stores (S3, OpenSearch Serverless, CloudWatch Logs)`,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Bedrock service key policy
    newKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow Bedrock to use the key',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
      })
    );

    // OpenSearch Serverless service key policy
    newKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow OpenSearch Serverless to use the key',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('aoss.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        resources: ['*'],
      })
    );

    // CloudWatch Logs service key policy
    newKey.addToResourcePolicy(
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

    return newKey;
  }

  /**
   * Validate and return embedding model ID from context
   */
  private validateEmbeddingModel(): string {
    const embeddingModelId: string | null | undefined =
      this.node.tryGetContext('embeddingModelId')!;

    if (typeof embeddingModelId !== 'string') {
      throw new Error(
        'Knowledge Base RAG が有効になっていますが、embeddingModelId が指定されていません'
      );
    }

    if (!EMBEDDING_MODELS.includes(embeddingModelId)) {
      throw new Error(
        `embeddingModelId が無効な値です (有効な embeddingModelId ${EMBEDDING_MODELS})`
      );
    }

    return embeddingModelId;
  }

  /**
   * Validate advanced parsing configuration
   */
  private validateAdvancedParsing(): { enabled: boolean; modelId?: string } {
    const ragKnowledgeBaseAdvancedParsing = this.node.tryGetContext(
      'ragKnowledgeBaseAdvancedParsing'
    )!;

    const ragKnowledgeBaseAdvancedParsingModelId: string | null | undefined =
      this.node.tryGetContext('ragKnowledgeBaseAdvancedParsingModelId')!;

    if (
      ragKnowledgeBaseAdvancedParsing &&
      typeof ragKnowledgeBaseAdvancedParsingModelId !== 'string'
    ) {
      throw new Error(
        'Knowledge Base RAG の Advanced Parsing が有効ですが、ragKnowledgeBaseAdvancedParsingModelId が指定されていないか、文字列ではありません'
      );
    }

    return {
      enabled: !!ragKnowledgeBaseAdvancedParsing,
      modelId: ragKnowledgeBaseAdvancedParsingModelId ?? undefined,
    };
  }

  /**
   * Create OpenSearch Serverless collection and index
   */
  private createOpenSearchResources(
    collectionName: string,
    vectorIndexName: string,
    vectorField: string,
    textField: string,
    metadataField: string,
    embeddingModelId: string,
    standbyReplicas: boolean | undefined,
    encryptionKey: kms.IKey,
    knowledgeBaseRole: iam.Role
  ): { collection: oss.CfnCollection; ossIndex: OpenSearchServerlessIndex } {
    // Create collection
    const collection = new oss.CfnCollection(this, 'Collection', {
      name: collectionName,
      description: 'Genai Collection',
      type: 'VECTORSEARCH',
      standbyReplicas: standbyReplicas ? 'ENABLED' : 'DISABLED',
    });

    // Create index custom resource
    const ossIndex = new OpenSearchServerlessIndex(this, 'OssIndex', {
      collectionId: collection.ref,
      vectorIndexName,
      vectorField,
      textField,
      metadataField,
      vectorDimension: MODEL_VECTOR_MAPPING[embeddingModelId],
    });

    // Grant Lambda permissions for OpenSearch operations
    ossIndex.customResourceHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [cdk.Token.asString(collection.getAtt('Arn'))],
        actions: ['aoss:APIAccessAll'],
      })
    );

    // Grant Lambda KMS permissions for OpenSearch operations
    ossIndex.customResourceHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [encryptionKey.keyArn],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
      })
    );

    // Add dependency to ensure IAM policy is applied before custom resource executes
    const defaultPolicy = ossIndex.customResourceHandler.role!.node.findChild('DefaultPolicy');
    ossIndex.customResource.node.addDependency(defaultPolicy as Construct);

    // Create access policy
    const accessPolicy = new oss.CfnAccessPolicy(this, 'AccessPolicy', {
      name: collectionName,
      policy: JSON.stringify([
        {
          Rules: [
            {
              Resource: [`collection/${collectionName}`],
              Permission: [
                'aoss:DescribeCollectionItems',
                'aoss:CreateCollectionItems',
                'aoss:UpdateCollectionItems',
              ],
              ResourceType: 'collection',
            },
            {
              Resource: [`index/${collectionName}/*`],
              Permission: [
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
                'aoss:CreateIndex',
                'aoss:DeleteIndex',
              ],
              ResourceType: 'index',
            },
          ],
          Principal: [
            knowledgeBaseRole.roleArn,
            ossIndex.customResourceHandler.role?.roleArn,
          ],
          Description: '',
        },
      ]),
      type: 'data',
    });

    // Create network policy
    const networkPolicy = new oss.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: collectionName,
      policy: JSON.stringify([
        {
          Rules: [
            {
              Resource: [`collection/${collectionName}`],
              ResourceType: 'collection',
            },
            {
              Resource: [`collection/${collectionName}`],
              ResourceType: 'dashboard',
            },
          ],
          AllowFromPublic: true,
        },
      ]),
      type: 'network',
    });

    // Create encryption policy
    const encryptionPolicy = new oss.CfnSecurityPolicy(
      this,
      'EncryptionPolicy',
      {
        name: collectionName,
        policy: JSON.stringify({
          Rules: [
            {
              Resource: [`collection/${collectionName}`],
              ResourceType: 'collection',
            },
          ],
          AWSOwnedKey: false,
          KmsARN: encryptionKey.keyArn,
        }),
        type: 'encryption',
      }
    );

    // Set dependencies
    collection.node.addDependency(accessPolicy);
    collection.node.addDependency(networkPolicy);
    collection.node.addDependency(encryptionPolicy);

    return { collection, ossIndex };
  }

  /**
   * Grant switch role permissions for OpenSearch and KMS
   */
  private grantSwitchRolePermissions(
    switchRole: iam.Role,
    collection: oss.CfnCollection,
    encryptionKey: kms.IKey
  ): void {
    // OpenSearch Serverless access
    switchRole.attachInlinePolicy(
      new iam.Policy(this, `${Stack.of(this).stackName}AossAccessPolicy`, {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [cdk.Token.asString(collection.getAtt('Arn'))],
            actions: ['aoss:APIAccessAll'],
          }),
        ],
      })
    );

    // KMS access for S3, OpenSearch, and Bedrock operations
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
  }

  /**
   * Create S3 buckets for data source and access logs
   */
  private createS3Buckets(
    appName: string,
    encryptionKey: kms.IKey,
    switchRole: iam.Role
  ): { accessLogsBucket: s3.Bucket; dataSourceBucket: s3.Bucket } {
    // Access logs bucket
    const accessLogsBucket = new s3.Bucket(this, `${appName}-DataSourceAccessLogsBucket`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: encryptionKey,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      enforceSSL: true,
    });

    // Grant read-only access to access logs bucket
    switchRole.attachInlinePolicy(new iam.Policy(this, `${Stack.of(this).stackName}GrantDSAccessLogBucket`, {
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
    }));

    // Data source bucket
    const dataSourceBucket = new s3.Bucket(this, `${appName}-DataSourceBucket`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: encryptionKey,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'AccessLogs/',
      enforceSSL: true,
    });

    // Grant read/write access to data source bucket
    switchRole.attachInlinePolicy(new iam.Policy(this, `${Stack.of(this).stackName}GrantDataSourceBucket`, {
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
    }));

    return { accessLogsBucket, dataSourceBucket };
  }

  /**
   * Configure Knowledge Base role policies
   */
  private configureKnowledgeBaseRolePolicies(
    knowledgeBaseRole: iam.Role,
    collection: oss.CfnCollection,
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

    // OpenSearch Serverless access
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [cdk.Token.asString(collection.getAtt('Arn'))],
        actions: ['aoss:APIAccessAll'],
      })
    );

    // S3 bucket listing
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:s3:::${dataSourceBucket.bucketName}`],
        actions: ['s3:ListBucket'],
      })
    );

    // S3 object access
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:s3:::${dataSourceBucket.bucketName}/*`],
        actions: ['s3:GetObject'],
      })
    );

    // KMS decryption for S3
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [encryptionKey.keyArn],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
      })
    );
  }

  /**
   * Create Bedrock Knowledge Base and Data Source
   */
  private createKnowledgeBase(
    collectionName: string,
    vectorIndexName: string,
    vectorField: string,
    textField: string,
    metadataField: string,
    embeddingModelId: string,
    knowledgeBaseRole: iam.Role,
    collection: oss.CfnCollection,
    ossIndex: OpenSearchServerlessIndex,
    dataSourceBucket: s3.Bucket,
    standbyReplicas: boolean | undefined,
    advancedParsingConfig: { enabled: boolean; modelId?: string }
  ): bedrock.CfnKnowledgeBase {
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: collectionName,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${embeddingModelId}`,
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: cdk.Token.asString(collection.getAtt('Arn')),
          fieldMapping: {
            metadataField,
            textField,
            vectorField,
          },
          vectorIndexName,
        },
      },
    });

    // Create data source with optional advanced parsing
    new bedrock.CfnDataSource(this, 'DataSource', {
      dataSourceConfiguration: {
        s3Configuration: {
          bucketArn: `arn:aws:s3:::${dataSourceBucket.bucketName}`,
          inclusionPrefixes: ['docs/'],
        },
        type: 'S3',
      },
      vectorIngestionConfiguration: {
        ...(advancedParsingConfig.enabled
          ? {
              parsingConfiguration: {
                parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
                bedrockFoundationModelConfiguration: {
                  modelArn: `arn:aws:bedrock:${this.region}::foundation-model/${advancedParsingConfig.modelId}`,
                  parsingPrompt: {
                    parsingPromptText: PARSING_PROMPT,
                  },
                },
              },
            }
          : {}),
        // Chunking strategy options (commented out for customization):
        // - Default (no specification)
        // - Semantic chunking
        // - Hierarchical chunking
        // - Standard chunking
        // See: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking-parsing.html
      },
      knowledgeBaseId: knowledgeBase.ref,
      // Dynamic name based on configuration for recreation on changes
      name: `s3-datasource-${
        createHash('SHA256')
        .update(`${embeddingModelId}${standbyReplicas}${advancedParsingConfig.enabled}${advancedParsingConfig.modelId}`)
        .digest('hex').slice(0,16)}`,
    });

    // Set dependencies
    knowledgeBase.addDependency(collection);
    knowledgeBase.node.addDependency(ossIndex.customResource);

    return knowledgeBase;
  }

  /**
   * Grant switch role permissions for Knowledge Base operations
   */
  private grantSwitchRoleKnowledgeBasePermissions(
    switchRole: iam.Role,
    knowledgeBase: bedrock.CfnKnowledgeBase
  ): void {
    switchRole.attachInlinePolicy(new iam.Policy(
      this,
      `${Stack.of(this).stackName}KnowledgeBaseRAGPolicy`,
      {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [`*`],
            actions: [
              'bedrock:ListKnowledgeBases',
              'bedrock:Rerank',
            ],
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
              'bedrock:ListTagsForResource'
            ],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: ['*',],
            actions: [
              'lambda:ListFunctions'
            ],
          }),
        ],
      }
    ));
  }

  /**
   * Apply CDK-NAG suppressions for required permissions
   */
  private applyNagSuppressions(
    knowledgeBaseRole: iam.Role,
    dataSourceBucket: s3.Bucket
  ): void {
    NagSuppressions.addResourceSuppressionsByPath(this, `${knowledgeBaseRole.node.path}/DefaultPolicy/Resource`,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'The policy of S3 requires * resources to get any objects.',
      }
    ]);

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${Stack.of(this).stackName}/OpenSearchServerlessIndexA7F8E3D2C1B04A968E7F5D4C3B2A1E0F/ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'This resource will be created by custom resource.',
        }
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(this, `/${Stack.of(this).stackName}/${Stack.of(this).stackName}GrantDSAccessLogBucket/Resource`,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'S3 action requires * resources.',
      }]
    );

    NagSuppressions.addResourceSuppressionsByPath(this, `/${Stack.of(this).stackName}/${Stack.of(this).stackName}GrantDataSourceBucket/Resource`,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'S3 action requires * resources.',
      }]
    );

    NagSuppressions.addResourceSuppressionsByPath(this, `/${Stack.of(this).stackName}/${Stack.of(this).stackName}KnowledgeBaseRAGPolicy/Resource`,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'Bedrock actions require * resources.',
      }]
    );
  }
}
