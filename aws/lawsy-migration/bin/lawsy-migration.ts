#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LawsyInfraStack } from '../lib/lawsy-infra-stack';

const app = new cdk.App();

const account = app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT;
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'ap-northeast-1';
const envName = app.node.tryGetContext('env') || '-dev';

new LawsyInfraStack(app, `LawsyMigrationStack${envName}`, {
  env: { account, region },
  envName,
  description: 'Lawsy GCP→AWS migration: Aurora pgvector + Lambda + API Gateway + KMS',
  tags: {
    Project: 'civic-intelligence-rag',
    Component: 'lawsy-migration',
    Environment: envName,
  },
});
