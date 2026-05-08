import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

/**
 * Properties for SwitchRoleForBedrockFlowsDeveloperStack
 */
interface SwitchRoleForBedrockFlowsDeveloperStackProps extends StackProps {
  /** IAM Identity Center user names allowed to assume this role */
  readonly idcUserNames: string[];
  /** SSO role name that can assume this role */
  readonly switchRoleName: string;
  /** Application name identifier */
  readonly appName: string;
}

/**
 * Stack for creating a switch role with minimal permissions for
 * Bedrock Flow development, data source uploads, and Knowledge Base sync.
 */
export class SwitchRoleForBedrockFlowsDeveloperStack extends Stack {
  /** The created IAM role for switching */
  public readonly switchRole: iam.Role;

  constructor(
    scope: Construct,
    id: string,
    props: SwitchRoleForBedrockFlowsDeveloperStackProps
  ) {
    super(scope, id, props);

    const awsAccount = Stack.of(this).account;
    const awsRegion = Stack.of(this).region;

    // Build assume role principal with SSO conditions
    const assumeRolePrincipal = new iam.ArnPrincipal(
      `arn:aws:iam::${awsAccount}:role/aws-reserved/sso.amazonaws.com/${awsRegion}/${props.switchRoleName}`
    ).withConditions({
      StringLike: {
        'aws:userid': props.idcUserNames.map((user) => `*:${user}`),
      },
    });

    // Define Bedrock permissions policy
    const bedrockPolicy = this.createBedrockPolicy(awsRegion);

    // Create the switch role
    const developerRole = new iam.Role(this, 'SwitchRoleForBedrockFlowsDeveloper', {
      assumedBy: assumeRolePrincipal,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsReadOnlyAccess'),
      ],
      inlinePolicies: {
        BedrockBasePolicy: bedrockPolicy,
      },
    });

    this.switchRole = developerRole;

    // Output role name
    new CfnOutput(this, 'SwitchRoleName', {
      value: developerRole.roleName,
    });

    // Apply CDK-NAG suppressions
    this.applyNagSuppressions(developerRole);
  }

  /**
   * Create Bedrock policy with foundation model and listing permissions
   */
  private createBedrockPolicy(region: string): iam.PolicyDocument {
    return new iam.PolicyDocument({
      statements: [
        // Foundation model invocation
        new iam.PolicyStatement({
          actions: [
            'bedrock:GetFoundationModel',
            'bedrock:GetFoundationModelAvailability',
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
          ],
          resources: [`arn:aws:bedrock:${region}::foundation-model/*`],
        }),
        // Listing operations (require * resource)
        new iam.PolicyStatement({
          actions: [
            'bedrock:ListFoundationModels',
            'bedrock:ListIngestionJobs',
            'bedrock:ListInferenceProfiles',
            'bedrock:ListMarketplaceModelEndpoints',
            'bedrock:ListProvisionedModelThroughputs',
          ],
          resources: ['*'],
        }),
        // SageMaker hub access
        new iam.PolicyStatement({
          actions: ['sagemaker:ListHubContents'],
          resources: [`arn:aws:sagemaker:${region}:aws:hub/SageMakerPublicHub`],
        }),
      ],
    });
  }

  /**
   * Apply CDK-NAG suppressions for required permissions
   */
  private applyNagSuppressions(role: iam.Role): void {
    // Suppress for the role resource and all child resources
    // Includes KMS wildcard actions that may be added by other stacks
    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CloudWatchLogsReadOnlyAccess managed policy is required for log viewing',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard required for Bedrock List* operations, foundation model access, and KMS operations',
          appliesTo: [
            'Resource::*',
            'Resource::arn:aws:bedrock:<AWS::Region>::foundation-model/*',
            // Also match resolved region values for foundation model resources
            { regex: '/^Resource::arn:aws:bedrock:.+::foundation-model\\/\\*$/g' },
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
      ],
      true
    );
  }
}
