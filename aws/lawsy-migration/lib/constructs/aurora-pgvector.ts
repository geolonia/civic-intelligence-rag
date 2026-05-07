import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AuroraPgvectorProps {
  vpc: ec2.IVpc;
  encryptionKey: kms.IKey;
  envName: string;
}

export class AuroraPgvector extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly secret: secretsmanager.ISecret;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AuroraPgvectorProps) {
    super(scope, id);

    const { vpc, encryptionKey, envName } = props;

    this.securityGroup = new ec2.SecurityGroup(this, 'AuroraSG', {
      vpc,
      description: 'Security group for lawsy Aurora pgvector cluster',
      allowAllOutbound: false,
    });

    // Aurora Serverless v2 PostgreSQL 16 with pgvector
    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_3,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        autoMinorVersionUpgrade: true,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.securityGroup],
      storageEncrypted: true,
      storageEncryptionKey: encryptionKey,
      backup: { retention: cdk.Duration.days(7) },
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      defaultDatabaseName: 'lawsy',
      parameters: {
        'shared_preload_libraries': 'pgvector',
      },
    });

    this.secret = this.cluster.secret!;
  }

  allowIngressFrom(sg: ec2.ISecurityGroup): void {
    this.securityGroup.addIngressRule(
      sg,
      ec2.Port.tcp(5432),
      'Allow Lambda to connect to Aurora',
    );
  }
}
