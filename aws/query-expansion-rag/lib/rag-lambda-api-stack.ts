import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import { RagLambda } from './constructs/rag-lambda';

/**
 * API throttle and quota settings
 */
const API_THROTTLE_CONFIG = {
  burstLimit: 100,
  rateLimit: 1000,
};

const API_QUOTA_CONFIG = {
  limit: 1000,
  period: apigateway.Period.DAY,
};

/**
 * Properties for RagLambdaApiStack
 */
interface RagLambdaApiStackProps extends StackProps {
  /** Application name identifier */
  readonly appName: string;
  /** ARN of WAF WebACL to associate with API Gateway */
  readonly webAclArn: string;
  /** Bedrock Knowledge Base ID */
  readonly knowledgeBaseId: string;
  /** IAM role for switch role access */
  readonly switchRole: iam.Role;
  /** Lambda log level */
  readonly logLevel: string;
  /** Application parameter file name */
  readonly appParamFile: string;
  /** KMS key for encryption */
  readonly encryptionKey: kms.IKey;
  /** Lambda integration timeout in seconds */
  readonly apiLambdaIntegrationTimeout: number;
  /** Bedrock regions allowed for model invocation (defaults to deploy region if not specified) */
  readonly bedrockRegions?: string[];
}

/**
 * Stack for RAG Lambda API with API Gateway
 */
export class RagLambdaApiStack extends Stack {
  constructor(scope: Construct, id: string, props: RagLambdaApiStackProps) {
    super(scope, id, props);

    // Create RAG Lambda function
    const ragFunction = new RagLambda(this, 'RagLambda', {
      knowledgeBaseId: props.knowledgeBaseId,
      appName: props.appName,
      logLevel: props.logLevel,
      appParamFile: props.appParamFile,
      encryptionKey: props.encryptionKey,
      bedrockRegions: props.bedrockRegions,
    });

    // Create API Gateway REST API
    const restApi = this.createRestApi(props.appName, props.encryptionKey);

    // Configure usage plan and API key
    const { apiKey } = this.configureApiAccess(restApi, props.appName);

    // Add gateway responses for CORS
    this.addGatewayResponses(restApi);

    // Associate WAF WebACL
    this.associateWaf(restApi, props.webAclArn);

    // Create POST /invoke endpoint
    const invokeEndpoint = this.createInvokeEndpoint(
      restApi,
      ragFunction,
      props.apiLambdaIntegrationTimeout
    );

    // Grant switch role permissions
    this.grantSwitchRolePermissions(props.switchRole, ragFunction, apiKey);

    // Create stack outputs
    this.createOutputs(restApi, apiKey, props.switchRole);

    // Apply CDK-NAG suppressions
    this.applyNagSuppressions(restApi, invokeEndpoint);
  }

  /**
   * Create REST API with logging and CORS
   */
  private createRestApi(
    appName: string,
    encryptionKey: kms.IKey
  ): apigateway.RestApi {
    const accessLogGroup = new logs.LogGroup(this, `${appName}-ApiGatewayLogGroup`, {
      encryptionKey: encryptionKey,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    return new apigateway.RestApi(this, `${appName}-RagApi`, {
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        dataTraceEnabled: true,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
    });
  }

  /**
   * Configure API usage plan and API key
   */
  private configureApiAccess(
    api: apigateway.RestApi,
    appName: string
  ): { usagePlan: apigateway.UsagePlan; apiKey: apigateway.IApiKey } {
    const usagePlan = api.addUsagePlan(`${appName}-RagApiUsagePlan`, {
      throttle: API_THROTTLE_CONFIG,
      quota: API_QUOTA_CONFIG,
      apiStages: [{ api, stage: api.deploymentStage }],
    });

    const apiKey = api.addApiKey(`${appName}-RagApiKey`);
    usagePlan.addApiKey(apiKey);
    usagePlan.applyRemovalPolicy(RemovalPolicy.DESTROY);

    return { usagePlan, apiKey };
  }

  /**
   * Add gateway responses for error handling with CORS headers
   */
  private addGatewayResponses(api: apigateway.RestApi): void {
    const corsHeaders = { 'Access-Control-Allow-Origin': "'*'" };

    api.addGatewayResponse('Api4XX', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: corsHeaders,
    });

    api.addGatewayResponse('Api5XX', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: corsHeaders,
    });
  }

  /**
   * Associate WAF WebACL with API Gateway
   */
  private associateWaf(api: apigateway.RestApi, webAclArn: string): void {
    new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAclArn,
    });
  }

  /**
   * Create POST /invoke endpoint with Lambda integration
   */
  private createInvokeEndpoint(
    api: apigateway.RestApi,
    ragLambda: RagLambda,
    timeoutSeconds: number
  ): apigateway.Resource {
    const invokeResource = api.root.addResource('invoke');

    invokeResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(ragLambda.lambda, {
        timeout: Duration.seconds(timeoutSeconds),
      }),
      { apiKeyRequired: true }
    );

    return invokeResource;
  }

  /**
   * Grant switch role permissions for Lambda invocation and API key retrieval
   */
  private grantSwitchRolePermissions(
    switchRole: iam.Role,
    ragLambda: RagLambda,
    apiKey: apigateway.IApiKey
  ): void {
    const apiKeyArn = `arn:aws:apigateway:${this.region}::/apikeys/${apiKey.keyId}`;

    const devPolicy = new iam.Policy(this, 'RagDevelopPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [ragLambda.lambda.functionArn],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [ragLambda.lambda.role!.roleArn],
        }),
        // Allow retrieving the API key value via:
        // aws apigateway get-api-key --api-key <KEY_ID> --include-value
        new iam.PolicyStatement({
          actions: ['apigateway:GET'],
          resources: [apiKeyArn],
        }),
      ],
    });

    switchRole.attachInlinePolicy(devPolicy);
  }

  /**
   * Create CloudFormation outputs
   */
  private createOutputs(
    api: apigateway.RestApi,
    apiKey: apigateway.IApiKey,
    switchRole: iam.Role
  ): void {
    new CfnOutput(this, 'ApiEndpoint', {
      value: `${api.url}invoke`,
      description: 'API Gateway Endpoint URL',
    });

    new CfnOutput(this, 'SwitchRole', {
      value: switchRole.roleName,
      description: 'Role name for development',
    });

    new CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description:
        'API Key ID for retrieving the API key value using AWS CLI: aws apigateway get-api-key --api-key <KEY_ID> --include-value',
    });
  }

  /**
   * Apply CDK-NAG suppressions for required permissions
   */
  private applyNagSuppressions(
    api: apigateway.RestApi,
    invokeResource: apigateway.Resource
  ): void {
    NagSuppressions.addResourceSuppressions(api, [
      {
        id: 'AwsSolutions-APIG2',
        reason:
          'Request validation is implemented in the Lambda function with comprehensive input validation and error handling',
      },
    ]);

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/${api.node.id}/CloudWatchRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CloudWatch role requires managed policy for API Gateway logging',
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/${api.node.id}/Default/${invokeResource.node.id}/POST/Resource`,
      [
        {
          id: 'AwsSolutions-COG4',
          reason: 'API Key authentication is used instead of Cognito',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason: 'API Key authentication is configured for this endpoint',
        },
      ]
    );
  }
}
