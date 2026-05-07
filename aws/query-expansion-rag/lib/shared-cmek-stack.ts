import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface SharedCmekStackProps extends cdk.StackProps {
  /**
   * List of SwitchRoles that need access to the shared CMEK.
   * These roles will be granted encrypt/decrypt permissions on the key.
   */
  switchRoles: iam.IRole[];

  /**
   * Environment name (e.g., "prod", "dev", "staging")
   * Used as a suffix for the stack ID to ensure uniqueness across environments.
   *
   * @default - No suffix (single environment deployment)
   */
  envName?: string;
}

/**
 * Shared CMEK Stack
 *
 * Creates a shared KMS Customer Managed Encryption Key (CMEK) that can be used
 * by multiple RAG API stacks for encrypting S3 buckets, OpenSearch Serverless
 * Collections, and CloudWatch Logs.
 */
export class SharedCmekStack extends cdk.Stack {
  /**
   * The shared encryption key (public readonly)
   *
   * This key can be referenced by other stacks to encrypt their resources.
   */
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: SharedCmekStackProps) {
    super(scope, id, props);

    // Create the shared KMS Customer Managed Key
    this.encryptionKey = new kms.Key(this, 'SharedCmek', {
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      description: 'Shared CMEK for multiple RAG APIs',
      alias: `shared-cmek-${props.envName || 'default'}`,
    });

    // Add Key Policy for Bedrock Service Principal
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBedrockToUseTheKey',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
      })
    );

    // Add Key Policy for OpenSearch Serverless Service Principal
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowOpenSearchServerlessToUseTheKey',
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

    // Add Key Policy for CloudWatch Logs Service Principal
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsToUseTheKey',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal(`logs.${cdk.Aws.REGION}.amazonaws.com`),
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
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
          },
        },
      })
    );

    // Grant encrypt/decrypt permissions to all SwitchRoles
    for (const switchRole of props.switchRoles) {
      this.encryptionKey.grantEncryptDecrypt(switchRole);

      // Add NAG suppression for the DefaultPolicy created by grantEncryptDecrypt
      // The grant adds kms:GenerateDataKey* and kms:ReEncrypt* which require wildcards
      NagSuppressions.addResourceSuppressions(
        switchRole,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'KMS grantEncryptDecrypt requires wildcard actions for GenerateDataKey* and ReEncrypt*',
            appliesTo: [
              'Action::kms:GenerateDataKey*',
              'Action::kms:ReEncrypt*',
            ],
          },
        ],
        true
      );
    }

    // CDK-NAG Suppressions
    NagSuppressions.addResourceSuppressions(
      this.encryptionKey,
      [
        {
          id: 'AwsSolutions-KMS5',
          reason:
            'Shared CMEK requires wildcard resource for service principals (Bedrock, OpenSearch Serverless, CloudWatch Logs).',
        },
      ],
      true
    );

    // Output the Key ARN for reference
    new cdk.CfnOutput(this, 'SharedCmekArn', {
      value: this.encryptionKey.keyArn,
      description: 'ARN of the shared CMEK for RAG APIs',
      exportName: `SharedCmekArn-${props.envName || 'default'}`,
    });
  }
}
