import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { AuroraPgvector } from './constructs/aurora-pgvector';

export interface LawsyInfraStackProps extends cdk.StackProps {
  envName: string;
  notificationEmail?: string;
}

export class LawsyInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LawsyInfraStackProps) {
    super(scope, id, props);

    const { envName, notificationEmail } = props;

    // ── KMS CMEK ────────────────────────────────────────────────────────────
    const encryptionKey = new kms.Key(this, 'LawsyCmek', {
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      description: 'CMEK for Lawsy Migration (Aurora, S3, Lambda, CloudWatch)',
      alias: `lawsy-cmek${envName}`,
    });

    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowRdsToUseKey',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('rds.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:CreateGrant', 'kms:DescribeKey'],
        resources: ['*'],
      }),
    );
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsToUseKey',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
          },
        },
      }),
    );

    // ── VPC ─────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'LawsyVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // ── S3 Source Layer (raw e-Gov XML) ──────────────────────────────────────
    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: `lawsy-source${envName}-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(365 * 5) }],
    });

    // ── Aurora pgvector ──────────────────────────────────────────────────────
    const aurora = new AuroraPgvector(this, 'Aurora', {
      vpc,
      encryptionKey,
      envName,
    });

    // ── GCP Vertex AI key secret (pre-provisioned by 殿) ────────────────────
    const gcpVertexSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GcpVertexSecret',
      'geolonia/civic-intelligence/gcp-vertex-key',
    );

    // ── Lambda Security Group ─────────────────────────────────────────────
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSG', {
      vpc,
      description: 'SG for Lawsy Lambda functions',
      allowAllOutbound: true,
    });
    aurora.allowIngressFrom(lambdaSg);

    // ── Shared Lambda environment variables ──────────────────────────────────
    const sharedLambdaEnv: Record<string, string> = {
      DB_SECRET_ARN: aurora.secret.secretArn,
      DB_CLUSTER_ENDPOINT: aurora.cluster.clusterEndpoint.hostname,
      DB_NAME: 'lawsy',
      SOURCE_BUCKET: sourceBucket.bucketName,
      GCP_VERTEX_SECRET_ARN: gcpVertexSecret.secretArn,
      BEDROCK_REGION: this.region,
      LOG_LEVEL: 'INFO',
    };

    const vpcPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole');

    // ── fetchRole: S3 write + EventBridge (no DB / Bedrock access) ───────────
    const fetchRole = new iam.Role(this, 'FetchRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [vpcPolicy],
    });
    sourceBucket.grantWrite(fetchRole);
    encryptionKey.grantEncryptDecrypt(fetchRole);

    // ── normalizeRole: S3 read + Aurora + Secrets (no Bedrock / GCP) ─────────
    const normalizeRole = new iam.Role(this, 'NormalizeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [vpcPolicy],
    });
    sourceBucket.grantRead(normalizeRole);
    aurora.secret.grantRead(normalizeRole);
    encryptionKey.grantDecrypt(normalizeRole);

    // ── embedRole: Aurora + Bedrock Titan + Secrets (no S3 / Claude / GCP) ──
    const embedRole = new iam.Role(this, 'EmbedRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [vpcPolicy],
    });
    aurora.secret.grantRead(embedRole);
    encryptionKey.grantDecrypt(embedRole);
    embedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
      }),
    );

    // ── searchRole: Aurora + Bedrock (Claude + Titan) + Secrets + GCP ────────
    const searchRole = new iam.Role(this, 'SearchRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [vpcPolicy],
    });
    aurora.secret.grantRead(searchRole);
    gcpVertexSecret.grantRead(searchRole);
    encryptionKey.grantDecrypt(searchRole);
    searchRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          `arn:aws:bedrock:${this.region}::foundation-model/jp.anthropic.claude-sonnet-4-6-20251101-v1:0`,
        ],
      }),
    );

    // ── Lambda Layer (shared deps: pg, @anthropic-ai/sdk) ────────────────────
    // NOTE: Layer bundled from lib/lambda/layer/ at deploy time.
    // Skipped for PoC; bundled inline via NodejsFunction.

    // ── Lambda: e-Gov Fetch (scheduled weekly Sunday 00:00 UTC) ─────────────
    const fetchLogGroup = new logs.LogGroup(this, 'FetchLogGroup', {
      logGroupName: `/aws/lambda/lawsy-fetch${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fetchLambda = new lambdaNodejs.NodejsFunction(this, 'FetchLambda', {
      entry: path.join(__dirname, 'lambda/fetch/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: fetchRole,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      environment: sharedLambdaEnv,
      logGroup: fetchLogGroup,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
    });

    new events.Rule(this, 'FetchSchedule', {
      schedule: events.Schedule.cron({ weekDay: 'SUN', hour: '0', minute: '0' }),
      targets: [new eventsTargets.LambdaFunction(fetchLambda)],
    });

    // ── Lambda: XML Normalize (S3 trigger on new raw XML) ───────────────────
    const normalizeLogGroup = new logs.LogGroup(this, 'NormalizeLogGroup', {
      logGroupName: `/aws/lambda/lawsy-normalize${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const normalizeLambda = new lambdaNodejs.NodejsFunction(this, 'NormalizeLambda', {
      entry: path.join(__dirname, 'lambda/normalize/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: normalizeRole,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: sharedLambdaEnv,
      logGroup: normalizeLogGroup,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
    });
    sourceBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3notifications.LambdaDestination(normalizeLambda),
      { prefix: 'raw-xml/' },
    );

    // ── Lambda: Bedrock Titan Embedding ──────────────────────────────────────
    const embedLogGroup = new logs.LogGroup(this, 'EmbedLogGroup', {
      logGroupName: `/aws/lambda/lawsy-embed${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const embedLambda = new lambdaNodejs.NodejsFunction(this, 'EmbedLambda', {
      entry: path.join(__dirname, 'lambda/embed/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: embedRole,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: sharedLambdaEnv,
      logGroup: embedLogGroup,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
    });

    // ── Lambda: Search / Report Generation (main API handler) ───────────────
    const searchLogGroup = new logs.LogGroup(this, 'SearchLogGroup', {
      logGroupName: `/aws/lambda/lawsy-search${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const searchLambda = new lambdaNodejs.NodejsFunction(this, 'SearchLambda', {
      entry: path.join(__dirname, 'lambda/search/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: searchRole,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: sharedLambdaEnv,
      logGroup: searchLogGroup,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
    });

    // ── API Gateway (REST, x-api-key auth) ───────────────────────────────────
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/apigateway/lawsy${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'LawsyApi', {
      restApiName: `lawsy-api${envName}`,
      description: 'Lawsy AWS Migration API',
      deployOptions: {
        stageName: 'v1',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'x-api-key'],
      },
    });

    const apiKey = new apigateway.ApiKey(this, 'LawsyApiKey', {
      apiKeyName: `lawsy-key${envName}`,
    });
    const usagePlan = new apigateway.UsagePlan(this, 'LawsyUsagePlan', {
      name: `lawsy-plan${envName}`,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ api, stage: api.deploymentStage });

    const searchIntegration = new apigateway.LambdaIntegration(searchLambda, {
      proxy: true,
    });
    const searchResource = api.root.addResource('search');
    searchResource.addMethod('POST', searchIntegration, {
      apiKeyRequired: true,
    });

    // ── Budget Alert ($300/month PoC guard) ──────────────────────────────────
    new budgets.CfnBudget(this, 'PocBudget', {
      budget: {
        budgetType: 'COST',
        budgetLimit: { amount: 300, unit: 'USD' },
        timeUnit: 'MONTHLY',
        budgetName: `lawsy-poc-budget${envName}`,
      },
      notificationsWithSubscribers: notificationEmail
        ? [
            {
              notification: {
                notificationType: 'ACTUAL',
                comparisonOperator: 'GREATER_THAN',
                threshold: 80,
                thresholdType: 'PERCENTAGE',
              },
              subscribers: [{ subscriptionType: 'EMAIL', address: notificationEmail }],
            },
          ]
        : [],
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'Lawsy API endpoint',
      exportName: `LawsyApiEndpoint${envName}`,
    });
    new cdk.CfnOutput(this, 'AuroraEndpoint', {
      value: aurora.cluster.clusterEndpoint.hostname,
      description: 'Aurora cluster endpoint',
      exportName: `LawsyAuroraEndpoint${envName}`,
    });
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: sourceBucket.bucketName,
      description: 'S3 source bucket for raw e-Gov XML',
      exportName: `LawsySourceBucket${envName}`,
    });

    // Suppress unused variable warnings for PoC
    void fetchLambda;
    void normalizeLambda;
    void embedLambda;
  }
}
