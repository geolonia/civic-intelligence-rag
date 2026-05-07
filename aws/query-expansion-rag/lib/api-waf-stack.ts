import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { CommonWebAcl } from './constructs/common-web-acl';

/**
 * Properties for ApiWafStack
 */
export interface ApiWafStackProps extends StackProps {
  /** IPv4 CIDR ranges to allow (null = no IP restriction) */
  readonly allowedIpV4AddressRanges: string[] | null;
  /** IPv6 CIDR ranges to allow (null = no IP restriction) */
  readonly allowedIpV6AddressRanges: string[] | null;
  /** Country codes to allow (null = no geo restriction) */
  readonly allowedCountryCodes: string[] | null;
}

/**
 * Stack that creates a WAF WebACL for API Gateway protection
 */
export class ApiWafStack extends Stack {
  /** ARN of the created WebACL */
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: ApiWafStackProps) {
    super(scope, id, props);

    const wafWebAcl = new CommonWebAcl(this, 'WebAcl', {
      scope: 'REGIONAL',
      allowedIpV4AddressRanges: props.allowedIpV4AddressRanges,
      allowedIpV6AddressRanges: props.allowedIpV6AddressRanges,
      allowedCountryCodes: props.allowedCountryCodes,
    });

    this.webAclArn = wafWebAcl.webAclArn;
  }
}
